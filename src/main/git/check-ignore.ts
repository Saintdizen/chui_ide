import { spawn } from 'node:child_process';
import path from 'node:path';
import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * Какие из путей git считает игнорируемыми (`.gitignore`). Спрашиваем только про
 * то, что реально видно в дереве: полный список игнорируемого на проекте с
 * `node_modules` — это сотни тысяч строк, и читать его незачем.
 *
 * Пути идут на stdin через NUL: так их не ограничивает длина командной строки,
 * а `-z` даёт ответ тоже через NUL — имена со спецсимволами не ломают разбор.
 *
 * Отдельный модуль, а не `execGit`: `check-ignore` при «ничего не игнорируется»
 * отвечает кодом 1, и это нормальный ответ. Через `execGit` пришлось бы глушить
 * failure настройкой, а глушение такого рода — источник тихих поломок.
 */
export async function checkIgnore(repoRoot: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const relative = paths.map((target) => {
    const absolute = path.resolve(target);
    const text = path.relative(repoRoot, absolute).split(path.sep).join('/');
    return { absolute, text };
  });
  const known = new Map(relative.map((item) => [item.text, item.absolute]));
  const output = await runCheckIgnore(
    repoRoot,
    relative.map((item) => item.text),
  );
  return (
    output
      .split('\u0000')
      // На Windows git отвечает родным разделителем — сверяем в прямых слэшах.
      .map((line) => line.trim().split('\\').join('/'))
      .map((line) => known.get(line))
      .filter((item): item is string => typeof item === 'string')
  );
}

/** Сам вызов `git check-ignore`: пути на stdin, ответ NUL-разделённый. */
function runCheckIgnore(repoRoot: string, relative: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', 'check-ignore', '-z', '--stdin'], {
      cwd: repoRoot,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_PAGER: 'cat',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(new RpcFailure(RpcErrorCode.Internal, `git: ${error.message}`)));
    child.on('close', (code) => {
      // Код 1 — «ничего не игнорируется»: это обычный ответ, а не сбой.
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new RpcFailure(RpcErrorCode.Internal, `git check-ignore: ${stderr.trim() || `код ${code}`}`));
    });
    // Пути разделяем NUL: в имени файла перевод строки — законное имя.
    child.stdin.end(relative.map((item) => `${item}\u0000`).join(''));
  });
}
