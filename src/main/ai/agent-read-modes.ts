import { describeValue, integerArg } from '../../shared/tool-args';

/**
 * Режимы чтения длинного файла: `lines` (голова, по умолчанию), `indentation`
 * (дерево по отступам) и `imports` (только каркас зависимостей).
 *
 * Зачем: длинный файл — самый дорогой ответ `read`. Голова за 120 строк называет
 * файл, но о структуре молчит, и модель идёт просить диапазоны наугад. Дерево по
 * отступам отвечает на «из чего он состоит» вдвое короче и не зависит от языкового
 * сервера: отступы есть везде, где есть форматирование.
 */

export const READ_MODES = ['lines', 'indentation', 'imports'] as const;
export type ReadMode = (typeof READ_MODES)[number];

/** Сколько уровней дерева отдаём по умолчанию и сколько всего. */
export const TREE_DEFAULT_LINES = 200;
export const TREE_MAX_LINES = 1200;

/** Один уровень вложенности — два пробела отступа. */
const INDENT_STEP = 2;

/** Отступ строки в символах: табуляция считается за четыре пробела. */
function indentOf(line: string, tabSize = 4): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += tabSize;
    else break;
  }
  return width;
}

/** Глубина уровня по отступу: первый уровень — 0, вложенный — 1 и дальше. */
function depthOf(line: string): number {
  return Math.floor(indentOf(line) / INDENT_STEP);
}

/** Строка закрывает блок (`}`, `});`, `end`) — сама уровнем не является. */
function closesBlock(trimmed: string): boolean {
  return /^[)\]}]/.test(trimmed) || trimmed === 'end';
}

/** Строка открывает блок — за ней пойдёт тело с большим отступом. */
function opensBlock(trimmed: string): boolean {
  return trimmed.includes('{');
}

/**
 * Строка начинает объявление (`import {`, `export function f() {`) — за ней идут
 * не поля, а новое объявление; фигурная скобка импорта тут ничего не значит.
 */
function isDeclarationStart(trimmed: string): boolean {
  return /^(import|from|export|class|interface|enum|namespace|package|using|use)\b/.test(trimmed);
}

/** Строка — продолжение предыдущей (значение, список аргументов), а не свой уровень. */
function isContinuation(trimmed: string): boolean {
  return /[{(,=+&|?:.[]$/.test(trimmed) || /^[)\]}]/.test(trimmed);
}

/**
 * Есть ли у строки тело: следующая строка глубже, или глубже есть что-то до того,
 * как файл вернётся на её глубину или мельче.
 *
 * Смотреть только на соседа нельзя: у `if` между заголовком и телом стоит ветка
 * `} else {`, у объявления — комментарий. Зато `const x = 1;` телом не считается —
 * иначе плоский файл данных целком уехал бы в дерево.
 */
function opensBody(rows: readonly { depth: number; text: string }[], index: number): boolean {
  const row = rows[index]!;
  if (!opensBlock(row.text)) return false;
  for (let scan = index + 1; scan < rows.length; scan += 1) {
    const next = rows[scan]!;
    if (next.depth > row.depth) return true;
    // Ветка на своей глубине — не конец тела: `} else {` продолжает объявление.
    if (next.depth === row.depth && opensBlock(next.text)) continue;
    return false;
  }
  return false;
}

export interface TreeResult {
  readonly text: string;
  /** Сколько уровней в дереве всего. */
  readonly total: number;
  /** Сколько отдано в этот раз. */
  readonly shown: number;
}

/**
 * Дерево по отступам: объявления и их ветки, без тел, с номерами как у `read`.
 *
 * Пометка `▸` значит: у строки есть тело, которое в дерево не вошло. По ней видно,
 * где просить диапазон через `read`. `maxLines`/`offset` режут само дерево — так
 * огромный файл листается по частям.
 */
export function indentationTree(
  lines: readonly string[],
  options: { maxLines?: number; offset?: number } = {},
): TreeResult {
  const maxLines = Math.max(1, Math.min(options.maxLines ?? TREE_DEFAULT_LINES, TREE_MAX_LINES));

  const rows: { line: number; text: string; depth: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    rows.push({ line: index + 1, text: trimmed, depth: depthOf(raw) });
  }

  const picked: { line: number; text: string; depth: number }[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    // Чистое закрытие — не уровень. `} else {` закрывает и открывает: он уровень.
    if (closesBlock(row.text) && !opensBlock(row.text)) continue;
    // Продолжение — только внутри открытого объявления: `const x = {` тянет за собой
    // поля, а `import {` после себя — уже новое объявление.
    if (
      index > 0 &&
      isContinuation(rows[index - 1]!.text) &&
      !closesBlock(row.text) &&
      row.depth > rows[index - 1]!.depth &&
      !isDeclarationStart(rows[index - 1]!.text)
    ) {
      continue;
    }
    if (!opensBody(rows, index)) continue;
    picked.push({ line: row.line, text: row.text, depth: row.depth });
  }

  // Пометка «внутри есть строки»: до следующего уровня пропущено тело.
  for (let index = 0; index < picked.length; index += 1) {
    const current = picked[index]!;
    const next = picked[index + 1];
    const end = next ? next.line - 1 : lines.length;
    if (end > current.line + 1) current.text = `${current.text} \u25b8`;
  }

  const from = Math.max(1, options.offset ?? 1);
  const slice = picked.slice(from - 1, from - 1 + maxLines);
  const text = slice
    .map((row) => `${'  '.repeat(Math.max(0, row.depth))}${row.line} | ${row.text}`)
    .join('\n');
  return { text, total: picked.length, shown: slice.length };
}

/**
 * Сколько скобок в накопленном объявлении осталось открытыми. Строка `import {` —
 * одна, `} from './b';` — минус одна: по этому счёту видно, продолжается ли оно.
 */
function bracketBalance(text: string): number {
  let balance = 0;
  for (const char of text) {
    if (char === '{' || char === '(' || char === '[') balance += 1;
    else if (char === '}' || char === ')' || char === ']') balance -= 1;
  }
  return balance;
}

/**
 * Каркас зависимостей: строки импортов.
 *
 * Ищет `import`/`from`/`require`/`use`/`using`/`#include` и продолжения многострочных
 * объявлений (`  b,`, `} from './b';`), без разбора синтаксиса. На вопрос «какие
 * библиотеки тянет файл» этого хватает, а цена — только импорты, без тела.
 */
export function importsBlock(lines: readonly string[]): { text: string; count: number } {
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const isImport =
      /^(import|from|require|use|using|package|namespace)\b/.test(trimmed) ||
      trimmed.startsWith('#include') ||
      trimmed.startsWith('#import') ||
      trimmed.startsWith('package ') ||
      trimmed.startsWith('namespace ') ||
      /^(const|let|var)\s+\w+\s*=\s*require\(/.test(trimmed);
    // Продолжение: закрывающая скобка многострочного импорта или имя в списке.
    // Продолжение: объявление ещё открыто (счёт скобок в нём плюсовой) и строка —
    // либо его закрытие (`} from './b';`), либо имя в списке (`  b,`).
    const isTail =
      kept.length > 0 &&
      bracketBalance(kept.join('\n')) > 0 &&
      /^[}\]]|^[A-Za-z_$][\w$]*,?$/.test(trimmed);
    if (isImport || isTail) kept.push(`${index + 1} | ${raw}`);
  }
  return { text: kept.join('\n'), count: kept.length };
}

export function readModeArg(args: Record<string, unknown>): ReadMode {
  const raw = args.mode;
  if (raw === undefined || raw === null) return 'lines';
  if (typeof raw !== 'string') {
    throw new Error(`mode: нужно одно из ${READ_MODES.join('/')} — получено ${describeValue(raw)}`);
  }
  const value = raw.trim().toLowerCase();
  // Опечатка молчала бы как `lines` — и модель получила бы не то, что просила.
  if (!(READ_MODES as readonly string[]).includes(value)) {
    throw new Error(`mode: нужно одно из ${READ_MODES.join('/')} — получено "${raw}"`);
  }
  return value as ReadMode;
}

/** Сколько уровней дерева просит модель. `0` и мусор читаются как «по умолчанию». */
export function treeMaxLines(args: Record<string, unknown>): number | undefined {
  const value = integerArg(args.maxLines);
  return value && value > 0 ? value : undefined;
}

/** С какого уровня дерева начинать. */
export function treeOffset(args: Record<string, unknown>): number | undefined {
  const value = integerArg(args.offset);
  return value && value > 0 ? value : undefined;
}
