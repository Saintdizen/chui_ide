import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** Ответ «Проверить» в настройках: команда сервера или причина, почему её нет. */
export interface LspCheckResult {
  /** Команда нашлась и запустилась. */
  ok: boolean;
  /** Абсолютный путь, в который разрешилась команда (`''`, если не нашлась). */
  resolved: string;
  /** Первая строка `--version` (или аналога) — что именно нашлось. */
  version: string;
  /** Почему не вышло: человеку, а не в журнал. */
  error: string;
}

/** Сколько ждём `--version`, прежде чем считать сервер молчуном. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Где лежит команда сервера.
 *
 * С путём (`./node_modules/.bin/pylsp`, `/usr/bin/gopls`) — от корня проекта,
 * иначе — перебором `PATH`. Проверяем, что это файл и что он исполняемый: иначе
 * человек увидит «команда есть», а сервер не поднимется.
 */
export function resolveCommand(command: string, cwd: string, pathEnv: string = process.env.PATH ?? ''): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const looksLikePath = trimmed.includes('/') || (process.platform === 'win32' && trimmed.includes('\\'));
  const candidates = looksLikePath
    ? [path.resolve(cwd, trimmed)]
    : pathEnv
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, trimmed));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Каталога нет, файла нет, прав нет — следующий кандидат.
    }
  }
  return null;
}

/** Первая непустая строка — версия сервера, чем бы он её ни назвал. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return '';
}

/**
 * Проверка команды сервера до сохранения: есть ли она и что о себе говорит.
 *
 * Запускаем её с аргументами из настроек, а если их нет — с `--version`: это
 * дешёвый способ удостовериться, что бинарь живой и это именно сервер. Полный
 * рукопожатный `initialize` здесь был бы неуместен: настройку правят до
 * сохранения, сервер ещё не выбран для проекта.
 */
export async function checkLspCommand(input: {
  command: string;
  args?: readonly string[];
  cwd: string;
}): Promise<LspCheckResult> {
  const resolved = resolveCommand(input.command, input.cwd);
  if (!resolved) {
    return {
      ok: false,
      resolved: '',
      version: '',
      error: `Команда «${input.command.trim() || '(пусто)'}» не найдена: ни в PATH, ни по указанному пути.`,
    };
  }

  const argv = [...(input.args ?? [])];
  const probe = argv.length === 0 ? ['--version'] : argv;
  const answer = await run(resolved, probe, input.cwd);
  if (answer.error && !answer.output) {
    return { ok: false, resolved, version: '', error: answer.error };
  }
  const version = firstLine(answer.output);
  if (answer.code !== 0 && answer.code !== null) {
    return {
      ok: false,
      resolved,
      version,
      error: `Найдена, но завершилась с кодом ${answer.code}${version ? `: ${version}` : ''}.`,
    };
  }
  return { ok: true, resolved, version, error: '' };
}

/** Запуск и сбор ответа: stdout и stderr вместе, выход по таймауту тоже ответ. */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (code: number | null, error: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, error });
    };
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, 'Команда не ответила за 4 секунды — возможно, это не сервер или она ждёт ввода.');
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < 2000) output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (output.length < 2000) output += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(null, `Не запустилась: ${error.message}`));
    child.on('close', (code) => finish(code, ''));
  });
}
