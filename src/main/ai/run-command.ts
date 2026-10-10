import { spawn } from 'node:child_process';

/**
 * Запуск команды для инструмента `run_terminal`.
 *
 * Обычные пайпы, а не pty: агенту нужен текст и код выхода, а не полноэкранная
 * программа. Плата — нет цветов и прогресс-баров, зато вывод предсказуем и его
 * можно вернуть модели целиком.
 *
 * Команду запускает оболочка пользователя (`$SHELL`), поэтому работают пайпы,
 * перенаправления и всё, что настроено в rc-файлах.
 */

export interface CommandResult {
  /** Код выхода; null — процесс убит сигналом. */
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Дольше держать агента в ожидании бессмысленно: пользователь уже ушёл. */
const TIMEOUT_MS = 120_000;
/** Один `npm install` выдаёт мегабайты — в контекст модели всё не влезет. */
const MAX_OUTPUT_CHARS = 60_000;

export function runShellCommand(command: string, cwd: string, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : process.env.SHELL || '/bin/bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];

    // detached — чтобы убивать всю группу процессов: `npm run watch` порождает
    // детей, и SIGKILL одной оболочке оставил бы их висеть.
    const child = spawn(shell, args, {
      cwd,
      env: commandEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer): void => {
      if (truncated) return;
      output += chunk.toString('utf8');
      if (output.length >= MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // процесс уже умер — это нормально
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);

    const onAbort = (): void => kill();

    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      result();
    };

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signalName) =>
      finish(() => resolve({ code, signal: signalName, output, truncated, timedOut })),
    );

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Цвета и прогресс-бары в выводе агента только мешают: просим утилиты молчать. */
function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
    // Иначе дочерний процесс решит, что он — Electron, и запустит вторую копию IDE.
    ELECTRON_RUN_AS_NODE: undefined,
  };
}
