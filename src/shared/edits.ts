/**
 * Правки в стиле LSP: позиции 1-based, column считается в UTF-16 code units —
 * ровно так же, как в Monaco. Один формат и для пользователя, и для AI-ассистента,
 * и для правок «с диска», поэтому конфликтов между источниками не возникает.
 */

export interface TextEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
  /**
   * Текст, который правка должна заменить. Если задан — перед применением
   * сверяется с документом, и при расхождении правка НЕ применяется.
   * Это важно для текста с кириллицей и других случаев, когда позиция,
   * посчитанная моделью, может указывать не туда: молчаливое «применено 1»
   * или «применено 0» без объяснения — худший из возможных исходов.
   */
  oldText?: string;
}

export interface FileEdit {
  path: string;
  edits: TextEdit[];
  /** Если задано — правка применяется только к документу этой версии (защита от гонок). */
  expectedVersion?: number;
}

export interface ApplyReport {
  path: string;
  applied: number;
  version: number;
}

export interface ApplyFailure {
  path: string;
  message: string;
}

export interface ApplyResult {
  reports: ApplyReport[];
  failed: ApplyFailure[];
}

/** Смещения начал строк (0-based, в code units). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Позиция (1-based) → смещение в тексте. */
export function toOffset(text: string, line: number, column: number): number {
  const starts = lineStarts(text);
  const lineIndex = Math.min(Math.max(line - 1, 0), starts.length - 1);
  const lineStart = starts[lineIndex]!;
  const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1]! - 1 : text.length;
  const offset = lineStart + Math.max(column - 1, 0);
  return Math.min(Math.max(offset, lineStart), Math.max(lineEnd, lineStart));
}

/** Смещение → позиция (1-based). */
export function fromOffset(text: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(text);
  const clamped = Math.min(Math.max(offset, 0), text.length);
  let lineIndex = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i]! <= clamped) lineIndex = i;
    else break;
  }
  return { line: lineIndex + 1, column: clamped - starts[lineIndex]! + 1 };
}

/**
 * Применяет набор правок к тексту. Правки считаются заданными относительно
 * исходного текста, поэтому применяем их с конца — тогда смещения не «съезжают».
 *
 * Если у правки задан `oldText`, он сверяется с тем, что реально лежит в этом
 * месте: несовпадение — исключение, а не тихая порча документа. Модель считает
 * позиции на глаз (для не-ASCII — особенно), и без такой проверки ошибка
 * выглядела бы как «применено 1» при нетронутом файле.
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;

  const prepared = edits
    .map((edit) => ({
      start: toOffset(text, edit.startLine, edit.startColumn),
      end: toOffset(text, edit.endLine, edit.endColumn),
      newText: edit.newText,
      oldText: edit.oldText,
      source: edit,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);

  let result = text;
  for (const edit of prepared) {
    const end = Math.max(edit.end, edit.start);
    verifyOldText(result, { start: edit.start, end, expected: edit.oldText, source: edit.source });
    result = result.slice(0, edit.start) + edit.newText + result.slice(end);
  }
  return result;
}

/**
 * Сверка `oldText` с тем, что лежит в документе. Проверяем ДО применения, но
 * уже с учётом предыдущих правок набора: они могут сдвинуть текст под курсором.
 */
function verifyOldText(text: string, range: { start: number; end: number; expected?: string; source: TextEdit }): void {
  const { start, end, expected, source } = range;
  if (expected === undefined) return;

  const actual = text.slice(start, end);
  if (actual === expected) return;

  const where = `${source.startLine}:${source.startColumn}–${source.endLine}:${source.endColumn}`;
  throw new Error(
    `Правка не совпала с текстом документа в ${where}: ожидалось «${cut(expected)}» ` +
      `(${symbolWord(expected.length)}), а в файле «${cut(actual)}» (${symbolWord(actual.length)}). ` +
      'Перечитай файл и повтори правку — документ с тех пор мог измениться.',
  );
}

/** Русская форма слова «символ» для числа. */
function symbolWord(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} символов`;
  if (mod10 === 1) return `${count} символ`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} символа`;
  return `${count} символов`;
}

/** Фрагмент для сообщения: длинную строку в текст ошибки не тащить. */
function cut(value: string): string {
  const flat = value.replace(/\n/g, '⏎');
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}
