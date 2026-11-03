import { shellQuote } from './shell-quote';

/**
 * Задачи проекта: `.vscode/tasks.json` плюс `scripts` из `package.json`.
 *
 * Это не полная поддержка схемы VS Code. Переменные `${workspaceFolder}` и
 * `${file}` вырезаем — с ними команда в sh падает на `bad substitution`, а без
 * них работает (терминал и так в корне проекта). `dependsOn` не разворачиваем:
 * панель ведёт одну строку, а не граф. Задача — чтобы чужой репозиторий
 * запускался из панели, а не чтобы повторить VS Code.
 */

/** Одна запускаемая задача. */
export interface ProjectTask {
  /** Подпись для панели: `label`, а если его нет — сама команда. */
  readonly label: string;
  /** Команда для терминала. */
  readonly command: string;
  /** Откуда задача — для пометки в панели. */
  readonly source: 'tasks-json' | 'package-json';
}

/** Потолок: задач в чужих репозиториях бывает под сотню, а панель должна остаться панелью. */
const MAX_TASKS = 50;

/**
 * Срезать комментарии и висячие запятые: `tasks.json` — JSONC, и файл у людей
 * почти всегда с комментариями.
 */
function stripJsonc(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Подставить переменные VS Code.
 *
 * Замены нет: `${workspaceFolder}` — это корень, а терминал в нём и работает;
 * `${file}` у задачи без файла не значит ничего. Пустое место даёт рабочую
 * команду, а оставленный `${...}` даёт `/bin/sh: bad substitution`.
 */
function substitute(text: string): string {
  return text
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Строка или массив строк: `args` в `tasks.json` бывает по-разному. */
function asStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Одна задача → командная строка.
 *
 * Три типа, которые действительно встречаются:
 * - `shell` (по умолчанию) — `command` плюс `args`;
 * - `process` — то же без оболочки; для строки терминала разницы нет;
 * - `npm` — `npm run <command>`: у этого типа в `command` лежит имя скрипта,
 *   а не программа.
 */
function commandOf(raw: Record<string, unknown>): string | null {
  const type = typeof raw.type === 'string' ? raw.type : 'shell';
  const command = typeof raw.command === 'string' ? substitute(raw.command) : '';
  if (command === '') return null;
  if (type === 'npm') return `npm run ${shellQuote(command)}`;

  const args = asStrings(raw.args)
    .map(substitute)
    .filter((arg) => arg !== '');
  return args.length === 0 ? command : [command, ...args.map(shellQuote)].join(' ');
}

/**
 * Задачи из текста `tasks.json`.
 *
 * Берём только то, что запускается строкой: задачи без `command` (композитные,
 * одни `dependsOn`) пропускаем — панель запуска ведёт команду, а не граф.
 * Битый JSON — пусто: панель не должна падать из-за чужого файла.
 */
export function tasksFromTasksJson(text: string): ProjectTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const raw = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return [];

  const tasks: ProjectTask[] = [];
  for (const item of raw) {
    if (tasks.length >= MAX_TASKS) break;
    if (!item || typeof item !== 'object') continue;
    const task = item as Record<string, unknown>;
    const command = commandOf(task);
    if (!command) continue;
    const label = typeof task.label === 'string' && task.label.trim() !== '' ? task.label.trim() : command;
    // Повтор подписи — не новая задача: в чужом файле их бывает по две на файл,
    // потому что глазами файл различают по `group`, а в панели — по подписи.
    if (tasks.some((known) => known.label === label)) continue;
    tasks.push({ label, command, source: 'tasks-json' });
  }
  return tasks;
}

/** Скрипты `package.json` в той же форме: человеку важно, что запускается, а не откуда. */
export function tasksFromScripts(
  scripts: readonly { name: string; command: string }[],
  manager: string,
): ProjectTask[] {
  return scripts.map((script) => ({
    label: script.name,
    command: `${manager} run ${shellQuote(script.name)}`,
    source: 'package-json' as const,
  }));
}

/**
 * Слияние: задачи из `tasks.json` первыми — их писал человек проекта, — потом
 * скрипты с неповторённой подписью.
 */
export function mergeTasks(tasks: readonly ProjectTask[], scripts: readonly ProjectTask[]): ProjectTask[] {
  const seen = new Set(tasks.map((task) => task.label));
  return [...tasks, ...scripts.filter((script) => !seen.has(script.label))];
}
