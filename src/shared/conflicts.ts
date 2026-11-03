/**
 * Разбор конфликтов слияния в файле и сборка разрешённого текста.
 *
 * Когда git не может слить две версии, он кладёт в файл обе стороны, разделив их
 * маркерами `<<<<<<< ours`, `=======`, `>>>>>>> theirs` (в стиле diff3 перед
 * `=======` добавляется ещё общий предок после `|||||||`). Редактировать такие
 * маркеры руками — источник ошибок: легко потерять кусок или оставить маркер.
 * Поэтому блоки разбираются здесь, а интерфейс предлагает выбрать сторону.
 *
 * Модуль чистый: он работает с текстом файла, а не с git, поэтому проверяется
 * юнит-тестами без репозитория.
 */

import type { TextEdit } from './edits';

/** Маркер начала «нашей» стороны (и, в diff3, общего предка). */
const OURS = '<<<<<<<';
const BASE = '|||||||';
const MIDDLE = '=======';
const THEIRS = '>>>>>>>';

/** Один блок конфликта: строки файла и обе стороны. */
export interface ConflictBlock {
  /** Порядковый номер блока в файле, с нуля: по нему интерфейс помнит выбор. */
  index: number;
  /** Строка с `<<<<<<<` (1-based). */
  startLine: number;
  /** Строка с `>>>>>>>` (1-based). */
  endLine: number;
  /** Текст «нашей» стороны без строк маркеров. */
  ours: string;
  /** Текст «их» стороны. */
  theirs: string;
  /** Общий предок (стиль diff3); нет — null. */
  base: string | null;
  /** Пометка после `<<<<<<<` (обычно HEAD). */
  oursLabel: string;
  /** Пометка после `>>>>>>>` (имя ветки или коммита). */
  theirsLabel: string;
}

/** Что оставить на месте блока. */
export type ConflictChoice = 'ours' | 'theirs' | 'both';

/**
 * Итог склейки «обоих».
 *
 * `ambiguous` — стороны дописали ОДНУ И ТУ ЖЕ строку по-разному: поставить их
 * рядом — значит выдать мусор (`a += 1a += 2`) за ответ. Тогда отдаём только
 * одну сторону плюс пометку места: человек решает сам, а не угадывает.
 */
export interface BothResult {
  text: string;
  ambiguous: boolean;
}

/**
 * Пометка на месте спора — прямо в тексте, а не тостом.
 *
 * Человек будет смотреть на этот файл ещё долго (в диффе, в поиске, в редакторе),
 * и объяснение должно ехать вместе с местом.
 */
export const VARIANT_MARK = '// Конфликт: обе стороны правили это место — выбери одну';

/** Строка — маркер начала стороны? Проверяем префикс: далее может быть пометка. */
function isMarker(line: string, marker: string): boolean {
  return line.startsWith(marker) && (line.length === marker.length || line[marker.length] === ' ');
}

/**
 * Блоки конфликтов в файле в порядке появления. Текст без конфликтов даёт пустой
 * список — это же поведение проверяет `hasConflicts`.
 */
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];
  let current: {
    startLine: number;
    oursLabel: string;
    theirsLabel: string;
    phase: 'ours' | 'base' | 'theirs';
    ours: string[];
    base: string[] | null;
    theirs: string[];
  } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    if (current === null) {
      if (isMarker(line, OURS)) {
        current = {
          startLine: lineNumber,
          oursLabel: line.slice(OURS.length).trim(),
          theirsLabel: '',
          phase: 'ours',
          ours: [],
          base: null,
          theirs: [],
        };
      }
      continue;
    }

    if (isMarker(line, BASE) && current.phase === 'ours') {
      current.phase = 'base';
      current.base = [];
      continue;
    }
    if (isMarker(line, MIDDLE) && current.phase !== 'theirs') {
      current.phase = 'theirs';
      continue;
    }
    if (isMarker(line, THEIRS)) {
      current.theirsLabel = line.slice(THEIRS.length).trim();
      blocks.push({
        index: blocks.length,
        startLine: current.startLine,
        endLine: lineNumber,
        ours: current.ours.join('\n'),
        theirs: current.theirs.join('\n'),
        base: current.base === null ? null : current.base.join('\n'),
        oursLabel: current.oursLabel,
        theirsLabel: current.theirsLabel,
      });
      current = null;
      continue;
    }

    if (current.phase === 'ours') current.ours.push(line);
    else if (current.phase === 'base') current.base?.push(line);
    else current.theirs.push(line);
  }

  return blocks;
}

/** Есть ли в тексте незакрытый или целый конфликт — дёшево, без полного разбора. */
export function hasConflicts(text: string): boolean {
  return text.includes(`\n${OURS}`) || text.startsWith(OURS) || text.includes(`\n${THEIRS}`);
}

/**
 * Текст, которым заменяется блок при выбранной стороне.
 *
 * `base` — общий предок из блока (стиль diff3). Он нужен только для «обоих»:
 * по нему видно, что стороны делали с базой, — см. `joinSides`.
 */
export function conflictChoiceText(
  block: ConflictBlock,
  choice: ConflictChoice,
  base: string | null = block.base,
): string {
  return conflictChoiceResult(block, choice, base).text;
}

/** То же, что `conflictChoiceText`, но с ответом «пришлось выбирать за тебя?». */
export function conflictChoiceResult(
  block: ConflictBlock,
  choice: ConflictChoice,
  base: string | null = block.base,
): BothResult {
  if (choice === 'ours') return { text: block.ours, ambiguous: false };
  if (choice === 'theirs') return { text: block.theirs, ambiguous: false };
  return joinSides(block.ours, block.theirs, base);
}

/**
 * «Оба»: в каком порядке ставить стороны.
 *
 * Наивное «наше, затем их» ломает код: две правки одной строки (`a += 1` и
 * `a += 2`) дают `a += 1a += 2` — мусор без ошибки. Так же ломается вставка
 * в одно и то же место: два новых `import` слипаются в одну строку.
 *
 * Порядок восстанавливаем по ОБЩЕМУ КРАЮ: если обе стороны сохранили одинаковые
 * строки в начале или в конце, это и есть место, куда они вставляли, — склеиваем
 * по нему, и вставки встают в нужном порядке. Края убираем по одной штуке и не
 * больше половины стороны: иначе у правки самого края мы съедим её же текст.
 *
 * Остались куски, которые вставить рядом нельзя (спор об одной строке) — отдаём
 * одну сторону и говорим `ambiguous`: молча склеить — соврать, молча выбрать
 * сторону — потерять правку.
 */
export function joinSides(ours: string, theirs: string, base: string | null): BothResult {
  if (ours === '') return { text: theirs, ambiguous: false };
  if (theirs === '') return { text: ours, ambiguous: false };
  // Без базы порядок сторон не угадать: склеиваем как есть, но говорим правду —
  // в diff3/zdiff3 база есть всегда, и тогда будет точнее.
  if (base === null) return { text: `${ours}\n${theirs}`, ambiguous: true };

  const oursLines = ours.split('\n');
  const theirsLines = theirs.split('\n');
  const head = commonPrefix(oursLines, theirsLines);
  const tail = commonSuffix(oursLines, theirsLines, head);

  const oursMid = oursLines.slice(head, oursLines.length - tail);
  const theirsMid = theirsLines.slice(head, theirsLines.length - tail);
  const prefix = oursLines.slice(0, head);
  const suffix = oursLines.slice(oursLines.length - tail);

  const merged = joinMiddle(oursMid, theirsMid);
  if (merged === null) {
    // Спор об одном месте: показываем одну сторону и метим место пометкой.
    return { text: `${ours}\n${VARIANT_MARK}`, ambiguous: true };
  }
  return { text: [...prefix, ...merged, ...suffix].join('\n'), ambiguous: false };
}

/** Сколько первых строк совпадает. */
function commonPrefix(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Сколько последних строк совпадает, не залезая в уже общий префикс.
 * Края убираем в порядке склейки — значит остаётся ровно одна копия общего куска.
 */
function commonSuffix(a: readonly string[], b: readonly string[], prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let n = 0;
  while (n < limit && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

/**
 * Склеить середины сторон или сказать, что это нельзя.
 *
 * Отказываемся ровно тогда, когда оба продолжили ОДНУ И ТУ ЖЕ строку: обе стороны
 * непусты, база на месте кончилась, и половинки склеиваются в строку кода. Признак —
 * хвост одной и голова другой вместе читаются как одна строка (есть непарная скобка,
 * кавычка, оператор). Без синтаксиса тут не обойтись: у текста, который стороны
 * просто поставили рядом, такого шва нет.
 *
 * Две стороны подряд без шва — вставки в разные места: ставим их рядом.
 */
function joinMiddle(ours: readonly string[], theirs: readonly string[]): string[] | null {
  if (ours.length === 0) return [...theirs];
  if (theirs.length === 0) return [...ours];
  const lastOurs = ours[ours.length - 1] ?? '';
  const lastTheirs = theirs[theirs.length - 1] ?? '';
  if (isSameLineSeam(lastOurs) || isSameLineSeam(lastTheirs)) return null;
  return [...ours, ...theirs];
}

/**
 * Строки склеятся в одну?
 *
 * Считаем только очевидные случаи: непарная кавычка или скобка, конец на операторе.
 * Гадать по отступам нельзя — а вот `a +` и `= 1` рядом оставлять нельзя точно.
 */
function isSameLineSeam(left: string): boolean {
  const tail = left.trim();
  if (tail === '') return false;
  // Конец на операторе или на открывающей скобке/кавычке — строка явно не кончена.
  if (/[=+\-*/%<>!&|^~?:,([{]$/.test(tail)) return true;
  // Непарная кавычка в конце — строка продолжается внутри литерала.
  const single = (tail.match(/'/g) ?? []).length;
  const double = (tail.match(/"/g) ?? []).length;
  const back = (tail.match(/`/g) ?? []).length;
  if (single % 2 === 1 || double % 2 === 1 || back % 2 === 1) return true;
  return false;
}

/**
 * Собрать текст файла с учётом выбора по блокам. `choices[i]` — выбор для блока
 * с номером `i`; `undefined` оставляет блок как есть (маркеры не трогаются).
 * Так можно применять выбор по одному блоку за раз, не теряя остальные.
 */
export function mergeConflicts(text: string, choices: ReadonlyArray<ConflictChoice | undefined>): string {
  const blocks = parseConflicts(text);
  if (blocks.length === 0) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let cursor = 0;

  for (const block of blocks) {
    const startIndex = block.startLine - 1;
    const endIndex = block.endLine - 1;
    for (; cursor < startIndex; cursor += 1) out.push(lines[cursor] ?? '');

    const choice = choices[block.index];
    if (choice === undefined) {
      // Выбор не сделан — блок остаётся на месте вместе с маркерами.
      for (; cursor <= endIndex; cursor += 1) out.push(lines[cursor] ?? '');
      continue;
    }

    const replacement = conflictChoiceResult(block, choice);
    if (replacement.text !== '') out.push(...replacement.text.split('\n'));
    cursor = endIndex + 1;
  }

  for (; cursor < lines.length; cursor += 1) out.push(lines[cursor] ?? '');
  return out.join('\n');
}

/**
 * Правка, заменяющая блок целиком выбранной стороной. Диапазон — от первой
 * строки `<<<<<<<` до `>>>>>>>`, включая их.
 */
export function conflictEdit(text: string, block: ConflictBlock, choice: ConflictChoice): TextEdit {
  const lines = text.split('\n');
  const lastLine = lines[block.endLine - 1] ?? '';
  return {
    startLine: block.startLine,
    startColumn: 1,
    endLine: block.endLine,
    endColumn: lastLine.length + 1,
    newText: conflictChoiceText(block, choice),
  };
}
