import { execFile } from 'node:child_process';
import path from 'node:path';

import { app } from 'electron';

import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

export const GIT_TIMEOUT_MS = 20_000;
/** Клонирование зависит от сети: здесь ограничение по времени много больше. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;
/**
 * Сетевые операции (fetch/pull/push) тоже ждут сеть, но не так долго, как полный
 * клон: обычный fetch укладывается в секунды, а зависший лучше прервать раньше.
 */
export const NETWORK_TIMEOUT_MS = 3 * 60_000;
export const MAX_BUFFER = 8 * 1024 * 1024;
/** Размер файла, выше которого diff не строим: сравнение такого в редакторе бессмысленно. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * Пустой каталог шаблонов git. git кладёт в новый `.git` хук-образец и примеры
 * ловушек, которые IDE не показывает и никто не исполняет: замер — 50 `init` с
 * шаблоном 192мс, с пустым каталогом 126мс. Каталог один на машину, поэтому и
 * живёт рядом с прочим состоянием приложения, а не в репозитории.
 *
 * Функция, а не константа: импорт модуля в юнит-тестах не должен трогать `app`
 * (Electron там нет вовсе). Значение считается на вызове, а `mkdir` перед `init`
 * подстраховывает первый запуск — git без каталога тоже работает, но пишет
 * предупреждение в stderr, а его мы показываем как ошибку панели.
 * Если `app` всё-таки недоступен, шаблоны просто не подставляем: это ускоритель,
 * а не условие работы.
 */
export function gitTemplateDir(): string | undefined {
try {
  return path.join(app.getPath('userData'), 'git-templates');
} catch {
  return undefined;
}
}

/** Что вернул `execFile`: `ok` — код выхода ноль, `stderr` — то, что git сказал в ошибку. */
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function execGit(
  args: string[],
  cwd: string,
  options: { allowFailure?: boolean; timeout?: number; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // --no-optional-locks: IDE не должна менять индекс, пока пользователь просто смотрит на файлы.
      ['--no-optional-locks', '-c', 'core.quotepath=false', ...args],
      {
        cwd,
        timeout: options.timeout ?? GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          // Никаких диалогов и редакторов: всё, что требует ввода, в IDE решается иначе.
          GIT_TERMINAL_PROMPT: '0',
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
          // Пустой каталог шаблонов — причина и замер в `gitTemplateDir`.
          ...(gitTemplateDir() ? { GIT_TEMPLATE_DIR: gitTemplateDir() } : {}),
          // Отдельные вызовы (rebase) подменяют редакторы своими — см. `rebaseInteractive`.
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const failed = error !== null;
        const result: GitResult = { ok: !failed, stdout, stderr };
        if (!failed || options.allowFailure) {
          resolve(result);
          return;
        }
        const message = stderr.trim() || stdout.trim() || `git ${args[0]}: код ${error?.code ?? '?'}`;
        reject(new RpcFailure(RpcErrorCode.Internal, `git: ${message}`, message));
      },
    );
  });
}