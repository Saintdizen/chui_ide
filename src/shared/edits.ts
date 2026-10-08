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
 */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return text;

  const prepared = edits
    .map((edit) => ({
      start: toOffset(text, edit.startLine, edit.startColumn),
      end: toOffset(text, edit.endLine, edit.endColumn),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);

  let result = text;
  for (const edit of prepared) {
    const end = Math.max(edit.end, edit.start);
    result = result.slice(0, edit.start) + edit.newText + result.slice(end);
  }
  return result;
}
