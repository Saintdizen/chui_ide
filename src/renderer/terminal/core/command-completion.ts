import { nameOf, parentOf } from '../../../shared/paths';

/**
 * Самые частые команды, если PATH не прочитан: без них Tab не работал бы на
 * первом запуске. Список намеренно короткий — это не справочник, а старт.
 */
export const COMPLETION_COMMANDS: readonly string[] = [
  'cd', 'cp', 'git', 'ls', 'mkdir', 'mv', 'npm', 'pnpm', 'rm', 'sudo', 'touch', 'yarn',
];

/**
 * Завершение команд терминала по Tab.
 *
 * Смысл не в том, чтобы знать все команды мира, а в том, чтобы не дописывать
 * руками то, что уже известно: имя команды, флаг, путь в проекте.
 *
 * Разбор строки — без DOM и без диска: список файлов и команды приходят
 * снаружи, так что поведение проверяется тестом.
 */
export interface CompletionContext {
  /** Имена исполняемых файлов из PATH — как их видит терминал. */
  readonly commands: readonly string[];
  /** Флаги предыдущих запусков этой же команды — история через историю. */
  readonly history?: readonly string[];
  /** Откуда читать имена файлов; `null` — каталога нет или не читается. */
  readonly listDir: (path: string) => readonly string[] | null;
  /** Текущий каталог. */
  readonly cwd: string;
}

export interface Completion {
  /** Что подставить вместо набранного хвоста. */
  readonly value: string;
  /** Единственное ли это продолжение: тогда Tab дописывает сразу. */
  readonly single: boolean;
  /** Подсказки одним взглядом — для показываемого списка. */
  readonly options: readonly string[];
}

/**
 * Последнее слово в строке и всё, что до него.
 *
 * Кавычки и обратный слэш отрезаются: после `cat "my fi` подсказывать надо
 * `my file.txt`, а не `"my fi`.
 */
export function splitTail(line: string): { head: string; tail: string } {
  const match = /[^\s]*$/.exec(line);
  const raw = match ? match[0] : '';
  const start = line.length - raw.length;
  // Кавычка, открывшая слово, остаётся в голове, чтобы подстановка не сломала
  // синтаксис: после `cat "my fi` подсказываем `my file.txt`, а кавычка уже стоит.
  const quoted = raw[0] === '"' || raw[0] === "'";
  return {
    head: line.slice(0, start) + (quoted ? raw[0]! : ''),
    tail: quoted ? raw.slice(1) : raw,
  };
}

/** Первое слово строки — команда; пусто после пробела — ждём ввод. */
export function firstWord(line: string): string {
  const trimmed = line.trimStart();
  const space = trimmed.search(/\s/);
  return space < 0 ? trimmed : trimmed.slice(0, space);
}

/**
 * Завершение текущего слова.
 *
 * Три случая, и они разные по смыслу: первое слово — команда из PATH,
 * слово с дефисом — флаг из истории, всё остальное — путь на диске.
 */
export function completeTerminal(line: string, context: CompletionContext): Completion | null {
  const { head, tail } = splitTail(line);
  const atCommand = firstWord(line) === tail;

  if (atCommand) {
    const options = pick(context.commands, tail);
    return finish(head, options, ' ');
  }
  if (tail.startsWith('-')) {
    const flags = collectFlags(context.history ?? []);
    const options = pick(flags, tail);
    return finish(head, options, ' ');
  }
  return completePath(head, tail, context);
}

/** Варианты, начинающиеся с набранного; при равенстве — по алфавиту. */
function pick(all: readonly string[], prefix: string): string[] {
  if (prefix === '') return [...all].sort();
  return all.filter((item) => item.startsWith(prefix)).sort();
}

/** Одно продолжение — дописываем и ставим пробел; несколько — только список. */
function finish(head: string, options: readonly string[], suffix: string): Completion | null {
  if (options.length === 0) return null;
  const single = options.length === 1;
  const value = single ? `${options[0]!}${suffix}` : commonPrefix(options);
  return { value: head + value, single, options };
}

/** Общее начало вариантов: дописываем его, даже когда вариантов много. */
function commonPrefix(items: readonly string[]): string {
  if (items.length === 0) return '';
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (prefix === '') return '';
  }
  return prefix;
}

/** Флаги из истории — с дефисом и без повторов. */
function collectFlags(history: readonly string[]): string[] {
  const flags = new Set<string>();
  for (const line of history) {
    for (const word of line.split(/\s+/)) {
      if (word.startsWith('-') && word.length > 1 && !word.includes('=')) flags.add(word);
    }
  }
  return [...flags];
}

/** Завершение пути: каталог — с косой чертой, файл — с пробелом. */
function completePath(head: string, tail: string, context: CompletionContext): Completion | null {
  const slash = tail.lastIndexOf('/');
  const dirPart = slash < 0 ? '' : tail.slice(0, slash + 1);
  const prefix = slash < 0 ? tail : tail.slice(slash + 1);
  // Абсолютный путь — как есть, относительный — от текущего каталога.
  const dir = dirPart.startsWith('/') ? dirPart : context.cwd + '/' + dirPart;
  const names = context.listDir(dir.replace(/\/$/, '') || '/');
  if (!names) return null;
  const options = pick(names, prefix).map((name) => dirPart + name);
  if (options.length === 0) return null;
  const single = options.length === 1;
  const value = single ? `${options[0]!} ` : dirPart + commonPrefix(options.map((item) => item.slice(dirPart.length)));
  return { value: head + value, single, options };
}

/**
 * Имя каталога, в который хотим зайти — для проверки существования.
 * Вынесено сюда, чтобы UI не угадывал, что именно спра­шивать у диска.
 */
export function dirToRead(tail: string, cwd: string): string {
  const slash = tail.lastIndexOf('/');
  const dirPart = slash < 0 ? '' : tail.slice(0, slash);
  return dirPart === '' ? cwd : dirPart.startsWith('/') ? dirPart : `${cwd}/${dirPart}`;
}

/** Имя файла без каталога — для сообщения «дописано до …». */
export function completedName(completion: Completion): string {
  return nameOf(completion.value.trimEnd()) || parentOf(completion.value);
}
