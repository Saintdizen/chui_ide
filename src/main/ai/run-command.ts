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
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Потолок заданного агентом предела времени: больше — это уже не инструмент. */
export const MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * Сколько оставляем от вывода. Один `npm install` выдаёт мегабайты, и всё это
 * в контекст не влезет. Держим НАЧАЛО и КОНЕЦ, а середину выбрасываем: в начале
 * видно, что запустилось и с какими аргументами, в конце — итог и ошибки. При
 * обрезке только хвоста терялось именно начало, а по нему видно, что команда
 * вообще сделала.
 */
const HEAD_CHARS = 24_000;
const TAIL_CHARS = 36_000;

export interface RunOptions {
  signal?: AbortSignal;
  /** Предел времени в миллисекундах; по умолчанию `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export function runShellCommand(command: string, cwd: string, options: RunOptions = {}): Promise<CommandResult> {
  const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  return runProcess(shell, args, cwd, options);
}

/**
 * Запуск без оболочки: исполняемый файл и готовый список аргументов.
 *
 * Этим путём идёт всё, что собирается из чужих данных, — например команда в
 * контейнере (`docker run … sh -c "…"`). Здесь аргументы не проходят через
 * разбор строки, поэтому текст команды не может «вылезти» из своей позиции и
 * подставить хосту лишний флаг: никакой склейки и экранирования.
 */
export function runProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<CommandResult> {
  const { signal } = options;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  return new Promise<CommandResult>((resolve, reject) => {
    // detached — чтобы убивать всю группу процессов: `npm run watch` порождает
    // детей, и SIGKILL одной оболочке оставил бы их висеть.
    const child = spawn(file, [...args], {
      cwd,
      env: commandEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Голова и хвост держатся отдельно: середина не нужна, а копить весь вывод
    // (десятки мегабайт от сборки) в памяти — лишнее.
    let head = '';
    let tail = '';
    let total = 0;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      total += text.length;
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length;
        head += text.slice(0, room);
        const rest = text.slice(room);
        if (rest) tail = (tail + rest).slice(-TAIL_CHARS);
        return;
      }
      tail = (tail + text).slice(-TAIL_CHARS);
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
    }, timeoutMs);

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
      finish(() =>
        resolve({
          code,
          signal: signalName,
          output: joinOutput(head, tail, total),
          truncated: total > HEAD_CHARS + TAIL_CHARS,
          timedOut,
        }),
      ),
    );

    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Собрать вывод из головы и хвоста. Когда середина отброшена, на её месте
 * оставляем пометку с числом отброшенных символов: модель должна знать, что
 * видит не всё, иначе примет обрывок за целый вывод.
 */
function joinOutput(head: string, tail: string, total: number): string {
  if (total <= head.length + tail.length) return head + tail;
  const dropped = total - head.length - tail.length;
  return `${head}\n… (отброшено символов: ${dropped})\n${tail}`;
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
