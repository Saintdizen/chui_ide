import { joinPath } from './paths';

/**
 * Конфигурации отладки из `.vscode/launch.json`.
 *
 * Чужой проект приносит их с собой, и «запустить с параметрами» в VS Code — это
 * именно `launch.json`. Поддерживаем то, что наш отладчик действительно умеет:
 * один процесс Node (или Python своим адаптером) — `program`, `args`, `cwd`,
 * `env`, `stopOnEntry`. `compounds` и `request: attach` сюда не входят: их нечем
 * запустить, и обещать их хуже, чем не показывать.
 */

/** Одна конфигурация, приведённая к тому, что шлётся в `debug.start`. */
export interface LaunchConfig {
  /** Подпись: `name` из файла, а если его нет — имя программы. */
  readonly name: string;
  /** Путь к программе. Абсолютный: относительный считается от корня проекта. */
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stopOnEntry: boolean;
}

/** Типы, которые запускаются нашим отладчиком. `pwa-node` — тот же Node. */
const NODE_TYPES = new Set(['node', 'pwa-node', 'node-terminal']);

/**
 * Подстановка `${...}`, которую мы умеем точно.
 *
 * Остальные (`${file}`, `${selectedText}`) в файле без открытого файла не значат
 * ничего. Подставить случайное хуже, чем не показать конфигурацию вовсе: запустят
 * отладку не того файла.
 *
 * Окружение приходит снаружи, как и в `external-terminal.ts`: модуль общий с renderer,
 * а там `process` нет вовсе.
 */
function expand(value: string, root: string, env: Readonly<Record<string, string | undefined>>): string | null {
  let unknown = false;
  const text = value.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    const trimmed = name.trim();
    if (trimmed === 'workspaceFolder' || trimmed === 'workspaceRoot') return root;
    if (trimmed.startsWith('env:')) {
      const found = env[trimmed.slice(4)] ?? '';
      if (found === '') unknown = true;
      return found;
    }
    unknown = true;
    return '';
  });
  return unknown ? null : text;
}

/** Строки из массива: в `args` встречается и одна строка с пробелами. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** `env` — объект; значения приводим к строкам, как ждёт DAP. */
function environment(
  value: unknown,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const text = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
    if (text === null) continue;
    const expanded = expand(text, root, env);
    if (expanded !== null) result[key] = expanded;
  }
  return result;
}

/** Абсолютный путь по обоим видам разделителя — как их пишут в чужом файле. */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * Конфигурации из текста `launch.json` (JSONC).
 *
 * `root` нужен, чтобы `program` стал путём от корня проекта: отладчик работает
 * в его каталоге, а файл описывает пути относительно корня. `env` — окружение для
 * `${env:ИМЯ}`; читает его main, здесь оно только подставляется.
 */
export function launchConfigs(
  text: string,
  root: string,
  env: Readonly<Record<string, string | undefined>> = {},
): LaunchConfig[] {
  const parsed = parseJsonc(text);
  if (!parsed) return [];
  const raw = Array.isArray(parsed.configurations) ? parsed.configurations : [];

  const configs: LaunchConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    // `attach` — подключение к чужому процессу: адрес задаёт человек, не файл.
    if (record.request !== undefined && record.request !== 'launch') continue;
    const declared = typeof record.program === 'string' ? expand(record.program, root, env) : null;
    if (!declared) continue;
    if (!NODE_TYPES.has(type) && type !== 'python' && type !== 'debugpy') continue;

    const cwd = typeof record.cwd === 'string' ? expand(record.cwd, root, env) : null;
    configs.push({
      name:
        typeof record.name === 'string' && record.name.trim() !== ''
          ? record.name.trim()
          : declared.split(/[/\\]/).pop() || declared,
      program: isAbsolute(declared) ? declared : joinPath(root, declared),
      args: strings(record.args)
        .map((arg) => expand(arg, root, env))
        .filter((arg): arg is string => arg !== null),
      ...(cwd ? { cwd: isAbsolute(cwd) ? cwd : joinPath(root, cwd) } : {}),
      env: environment(record.env, root, env),
      stopOnEntry: record.stopOnEntry === true,
    });
  }
  return configs;
}

/** JSONC → объект; битый файл — null (чужой файл не повод падать). */
function parseJsonc(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
