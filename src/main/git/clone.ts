import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { CLONE_TIMEOUT_MS } from './exec';

/**
 * Клонирование — отдельно от `net.ts`, потому что у него другая форма вызова:
 * не «выполнить и вернуть слова», а живой поток строк прогресса, минуты
 * ожидания и таймаут на весь процесс. Общего с `execGit` — только сам git.
 */

/**
 * Клонировать `url` в `directory`. Прогресс git пишет в stderr, поэтому нужен
 * поток, а не буферизованный вызов: иначе пользователь видит только тишину.
 */
export async function clone(
  url: string,
  directory: string,
  onProgress?: (line: string) => void,
): Promise<{ path: string }> {
  const link = url.trim();
  if (!link) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пустой адрес репозитория');
  // Ведущий дефис git примет за флаг, а не за адрес.
  if (link.startsWith('-')) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Адрес не может начинаться с «-»');

  const target = path.resolve(directory);
  const existing = await fs.stat(target).catch(() => null);
  if (existing) throw new RpcFailure(RpcErrorCode.InvalidParams, `Папка уже существует: ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });

  await stream(['clone', '--progress', link, target], path.dirname(target), onProgress);
  return { path: target };
}

/** Запустить git и отдать построчно и stdout, и stderr — прогресс клона идёт в оба. */
function stream(args: string[], cwd: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        GIT_PAGER: 'cat',
      },
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new RpcFailure(RpcErrorCode.Internal, 'git не ответил за 10 минут'));
    }, CLONE_TIMEOUT_MS);

    let rest = '';
    const feed = (chunk: string): void => {
      rest += chunk;
      const lines = rest.split(/\r?\n|\r/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (text) onLine?.(text);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new RpcFailure(RpcErrorCode.Internal, `git: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new RpcFailure(RpcErrorCode.Internal, `git ${args[0]} завершился с кодом ${code}`, rest.trim()));
    });
  });
}
