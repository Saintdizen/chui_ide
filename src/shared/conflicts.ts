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

/** Текст, которым заменяется блок при выбранной стороне. */
export function conflictChoiceText(block: ConflictBlock, choice: ConflictChoice): string {
  if (choice === 'ours') return block.ours;
  if (choice === 'theirs') return block.theirs;
  // «Оба»: наше, затем их. Пустые стороны не добавляют лишних переводов строки.
  if (block.ours === '') return block.theirs;
  if (block.theirs === '') return block.ours;
  return `${block.ours}\n${block.theirs}`;
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

    const replacement = conflictChoiceText(block, choice);
    if (replacement !== '') out.push(...replacement.split('\n'));
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
