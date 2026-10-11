import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseRuffJson, type LintOutcome } from '../../shared/lint';
import { projectEnv } from '../project-env';

/**
 * Проверка кода линтером окружения: ruff.
 *
 * Инструмент запускаем как модуль интерпретатора проекта (`python -m ruff`) —
 * так берётся именно то окружение, в котором человек работает, без поиска
 * бинарников в PATH. Это тот же уговор, что и у форматтера (`python/format.ts`).
 *
 * Разница в том, что форматтер читает stdin, а линтеру нужны пути: проверяем
 * файл, папку или проект целиком. Файлы не меняем — `--fix` не передаём.
 *
 * Кеш ruff уводим во временный каталог: проверка не должна оставлять в проекте
 * `.ruff_cache` — инструмент читающий, и следов после него быть не должно.
 */

export async function lintPython(root: string, python: string, target: string): Promise<LintOutcome> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(await projectEnv(root)),
    PYTHONIOENCODING: 'utf-8',
    NO_COLOR: '1',
    RUFF_CACHE_DIR: path.join(os.tmpdir(), 'chui-ruff-cache'),
  };

  const stdout = await run(python, ['-m', 'ruff', 'check', '--output-format', 'json', target], root, env);
  // Пустой вывод — ruff не отработал (не установлен, не тот интерпретатор): это
  // «нечем проверить», а не «проблем нет». Настоящее «нет проблем» — это `[]`.
  if (stdout.trim() === '') return { tool: null, problems: [] };
  const problems = parseRuffJson(stdout);
  return problems === null ? { tool: null, problems: [] } : { tool: 'ruff', problems };
}

/** Запустить линтер и вернуть его stdout; ошибки запуска не бросаем — вернём пусто. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });

    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    // Сообщения линтера о себе самих (трейсбеки, предупреждения) нам не нужны.
    child.stderr.on('data', () => undefined);

    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}
