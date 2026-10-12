/**
 * Диапазоны свёртки: что в файле можно сложить и как.
 *
 * Источников два, и они дополняют друг друга:
 *
 *   • ЯЗЫКОВОЙ СЕРВЕР (`textDocument/foldingRange`) — он знает про блоки, секции
 *     комментариев и списки импортов, свёртка у него смысловая. Ответ разбираем
 *     здесь (`toFoldRanges`).
 *   • ОТСТУПЫ — запасной путь, когда сервера нет: блок — это строка и следующие за
 *     ней строки с большим отступом (`indentFoldRanges`). Так сворачивается почти
 *     любой код, и это честно: без разбора языка глубже не заглянуть.
 *
 * Диапазоны у нас 1-based и включительные с обеих сторон — как строки в редакторе и
 * `document.path`; перевод из 0-based LSP делается тут же, в одном месте.
 *
 * Модуль чистый: ни DOM, ни сети. Поэтому проверяется тестами без окна
 * (`tests/fold-ranges.test.ts`).
 */

/** Сворачиваемый отрезок: от строки-заголовка до последней строки блока включительно. */
export interface FoldRange {
  startLine: number;
  endLine: number;
}

/**
 * Кусок ответа LSP. Строки там 0-based; конец может прийти как `endLine`, а у
 * некоторых серверов — только началом (тогда сворачивать нечего).
 */
export function toFoldRanges(raw: unknown): FoldRange[] {
  if (!Array.isArray(raw)) return [];
  const ranges: FoldRange[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { startLine?: unknown; endLine?: unknown };
    if (typeof value.startLine !== 'number' || typeof value.endLine !== 'number') continue;
    const startLine = Math.trunc(value.startLine) + 1;
    const endLine = Math.trunc(value.endLine) + 1;
    if (endLine > startLine) ranges.push({ startLine, endLine });
  }
  return mergeFoldRanges(ranges);
}

/**
 * Свернуть блоки по отступам. Блоком считается строка и все следующие за ней
 * строки, пока отступ больше её собственного; пустые строки внутри блока не
 * прерывают его и в конец не оттягиваются (иначе свёртка прятала бы пустоту).
 */
export function indentFoldRanges(text: string, tabSize = 4): FoldRange[] {
  const lines = text.split('\n');
  const ranges: FoldRange[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const base = indentWidth(lines[index]!, tabSize);
    if (isBlank(lines[index]!)) continue;
    let end = index;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (isBlank(lines[next]!)) continue;
      if (indentWidth(lines[next]!, tabSize) <= base) break;
      end = next;
    }
    if (end > index) ranges.push({ startLine: index + 1, endLine: end + 1 });
  }
  return mergeFoldRanges(ranges);
}

/**
 * Привести диапазоны в порядок: по началу, без пустых и без дублей. Вложенные
 * оставляем — их видно в жёлобе после того, как внешний раскрыт.
 */
export function mergeFoldRanges(ranges: readonly FoldRange[]): FoldRange[] {
  const sorted = [...ranges].filter((range) => range.endLine > range.startLine).sort(byStart);
  const result: FoldRange[] = [];
  for (const range of sorted) {
    const last = result[result.length - 1];
    // Полный дубль (тот же отрезок) — не второй диапазон, а тот же самый.
    if (last && last.startLine === range.startLine && last.endLine === range.endLine) continue;
    result.push(range);
  }
  return result;
}

/**
 * Диапазон, который начинается на этой строке (самый внешний из начинающихся тут):
 * его и сворачивает значок в жёлобе.
 */
export function foldStartingAt(ranges: readonly FoldRange[], line: number): FoldRange | null {
  let found: FoldRange | null = null;
  for (const range of ranges) {
    if (range.startLine !== line) continue;
    // Самый длинный: значок у строки сворачивает весь блок, а не вложенный в него.
    if (!found || range.endLine > found.endLine) found = range;
  }
  return found;
}

/** Можно ли сложить что-нибудь на этой строке — по этому рисуется значок в жёлобе. */
export function isFoldStart(ranges: readonly FoldRange[], line: number): boolean {
  return foldStartingAt(ranges, line) !== null;
}

/**
 * Блоки, в которые строка входит, но не начинает их, — от внешнего к вложенным.
 *
 * Это цепочка «где я сейчас» для закреплённых заголовков (sticky scroll): пока верх
 * экрана внутри функции и вложенного в неё блока, обоих заголовка видно сверху. Блок,
 * НАЧИНАЮЩИЙСЯ на этой строке, сюда не попадает: его заголовок и так виден в тексте.
 */
export function enclosingFoldRanges(ranges: readonly FoldRange[], line: number): FoldRange[] {
  return ranges
    .filter((range) => range.startLine < line && range.endLine >= line)
    .sort((a, b) => a.startLine - b.startLine);
}

/** Порядок диапазонов: сверху вниз, при равном начале — от длинного к короткому. */
function byStart(a: FoldRange, b: FoldRange): number {
  return a.startLine - b.startLine || b.endLine - a.endLine;
}

/** Ширина отступа строки в столбцах: табуляция — `tabSize`. */
function indentWidth(line: string, tabSize: number): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += tabSize;
    else break;
  }
  return width;
}

/** Пустая строка — только пробелы, табуляции или ничего. */
function isBlank(line: string): boolean {
  return line.trim() === '';
}
