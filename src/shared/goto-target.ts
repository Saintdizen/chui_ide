/**
 * Разбор поля перехода к строке (`Ctrl+G`): `номер`, `файл:строка`, `файл:строка:столбец`.
 *
 * VS Code и Sublime принимают в одном поле и номер строки, и путь с номером: поле
 * одно, а человек вставляет туда то, что даёт ошибка компилятора или лог. Здесь
 * только разбор — что открыть и на что встать. Открытие файла и подстановку пути
 * делает виджет, поэтому правило проверяется без окна и без файловой системы.
 */

export interface GotoQuery {
  /** Что открыть: `null` — остаёмся в текущем файле. */
  path: string | null;
  /** Строка. `null` — файл открыть, но номер не назван (значит с начала). */
  line: number | null;
  /** Столбец, 1 если не назван. */
  column: number;
}

export interface ParseGotoResult {
  /** Что делать с вводом. `null` — переходить некуда. */
  query: GotoQuery | null;
  /**
   * Ошибка — только то, что человек ПИСАЛ и что кончилось ничем (`a.ts:0`).
   * Пустое поле и мусор без намёка на файл ошибкой не считаются: панель открывают
   * с заготовкой и очищают, это нормальный ход, а не отказ.
   */
  error: string | null;
}

/** Снять кавычки по краям: обычный хвост от «скопировать путь» и из логов. */
function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Номер: только цифры, только от 1. `0` и `-1` — не «начало файла», а опечатка:
 * молча ставить каретку в первую строку — делать вид, что понял.
 */
function parseIndex(text: string): number | null {
  const raw = text.trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= 1 ? value : null;
}

/** Похоже ли на «хвост-номер», чтобы отличить его от имени файла с двоеточием. */
function looksLikeNumber(text: string): boolean {
  const raw = text.trim();
  return /^\d+$/.test(raw) || /^-\d+$/.test(raw);
}

/**
 * Разобрать ввод поля «Строка:».
 *
 * - `12` — строка 12 текущего файла;
 * - `src/main.ts:12` — файл и строка;
 * - `src/main.ts:12:5` — ещё и столбец;
 * - `src/main.ts` — файл целиком, с начала;
 * - `C:\\src\\main.ts:12` — двоеточие диска не путается с разделителем;
 * - пробелы по краям, кавычки по краям — не мешают.
 *
 * Разбор идёт С КОНЦА: последний кусок, если это число, — номер, предпоследний —
 * тоже, если число, — столбец. Поэтому `C:\\src\\a.ts:12` работает без отдельного
 * знания про Windows: `C` просто остаётся в пути.
 */
export function parseGotoInput(input: string): ParseGotoResult {
  const text = unquote(input);
  if (text === '') return { query: null, error: null };

  // Голое число — самый частый случай: «на 412-ю строку».
  if (/^\d+$/.test(text)) return { query: { path: null, line: Number.parseInt(text, 10), column: 1 }, error: null };

  const parts = text.split(':');
  const last = parts[parts.length - 1] ?? '';
  const prev = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';

  let line: number | null = null;
  let column = 1;
  let taken = 0;

  if (parts.length >= 3 && looksLikeNumber(last) && looksLikeNumber(prev)) {
    // `файл:строка:столбец`
    line = parseIndex(prev);
    column = parseIndex(last) ?? 1;
    taken = 2;
  } else if (parts.length >= 2 && looksLikeNumber(last)) {
    // `файл:строка`
    line = parseIndex(last);
    taken = 1;
  }

  if (taken > 0 && line === null) {
    // Хвост числовой, но нулевой или отрицательный: опечатка, а не «первая строка».
    return { query: null, error: 'Номер строки — от 1' };
  }

  const path = unquote(parts.slice(0, parts.length - taken).join(':'));
  if (path === '') {
    // Есть номер, но файла нет (`:12`): сказать об этом честнее, чем молчать.
    return taken > 0 ? { query: null, error: 'Не понял, в каком файле искать' } : { query: null, error: null };
  }
  // Перевод строки и табуляция в имени файла — не путь, а склеенный текст.
  if (/[\r\n\t]/.test(path)) return { query: null, error: null };

  return { query: { path, line, column }, error: null };
}

/**
 * Чем дополнить ввод: часть пути, по которой ищем файлы проекта.
 *
 * Отличается от `parseGotoInput` намеренно: пока человек печатает, `:12` ещё не
 * номер, а просто набранное, и отрезать его от подстановки нельзя — иначе список
 * исчезнет ровно тогда, когда имя файла уже набрано, а номер ещё не введён.
 */
export function completionQuery(input: string): string {
  const text = input.trim();
  if (text === '') return '';
  if (/^\d+$/.test(text)) return '';
  const parts = text.split(':');
  // Числовой хвост в подстановке не участвует: ищем по пути перед ним.
  while (parts.length > 1 && looksLikeNumber(parts[parts.length - 1] ?? '')) parts.pop();
  const rest = parts.join(':');
  // Голое `C:` отрезать нечем: это может быть начало пути `C:\\src`. Пусть решает
  // ранжирование — оно просто ничего не найдёт или найдёт то, что надо.
  return rest;
}
