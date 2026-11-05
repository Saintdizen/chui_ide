/**
 * Префиксы быстрого ввода: одна строка — несколько режимов.
 *
 * `Ctrl+P` открывает файлы, но человек набирает не «открой файл», а то, что
 * помнит: имя файла, имя команды, имя символа, строку кода. Префикс — это
 * соглашение о том, что именно он ищет, и его видно в самом вводе.
 *
 * Разбор — отдельная чистая функция, чтобы режимы проверялись тестами без окна.
 */

/** Что ищет ввод. */
export type QuickMode = 'files' | 'commands' | 'symbols' | 'text';

/** Режим и остаток строки — то, что идёт в поиск. */
export interface QuickPrefix {
  readonly mode: QuickMode;
  /** Запрос без префикса, обрезанный по краям. */
  readonly query: string;
  /** Префикс, который был в строке (`>`/`@`/`#`) или пустая строка. */
  readonly marker: string;
}

/** Префикс → режим. Один знак, один режим. */
const MARKERS: readonly { marker: string; mode: QuickMode }[] = [
  { marker: '>', mode: 'commands' },
  { marker: '@', mode: 'symbols' },
  { marker: '#', mode: 'text' },
];

/**
 * Разобрать строку ввода в режим и запрос.
 *
 * Префиксом считается только ПЕРВЫЙ символ: `a > b` — это поиск файла с таким
 * именем, а не команды. Пробелы по краям снимаются — но только после снятия
 * префикса: `> название` и `>название` значат одно и то же.
 */
export function parseQuickPrefix(value: string): QuickPrefix {
  const trimmed = value.trimStart();
  const first = trimmed[0];
  const known = MARKERS.find((item) => item.marker === first);
  if (!known) return { mode: 'files', query: value.trim(), marker: '' };
  return { mode: known.mode, query: trimmed.slice(1).trim(), marker: known.marker };
}

/** Префикс режима — чтобы вернуть его в строку ввода при переключении. */
export function prefixOf(mode: QuickMode): string {
  return MARKERS.find((item) => item.mode === mode)?.marker ?? '';
}

/**
 * Подсказка в подвале: что делают режимы.
 *
 * Здесь же, а не в тексте-заглушке: заглушка пропадает на первом символе —
 * ровно тогда, когда нужно знать, куда идёшь дальше.
 */
export const QUICK_MODES: readonly { marker: string; mode: QuickMode; hint: string }[] = [
  { marker: '', mode: 'files', hint: 'файлы' },
  { marker: '>', mode: 'commands', hint: 'команды' },
  { marker: '@', mode: 'symbols', hint: 'символы файла' },
  { marker: '#', mode: 'text', hint: 'поиск по проекту' },
];
