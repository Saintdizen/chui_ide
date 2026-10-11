/**
 * Разбор унифицированного diff на блоки изменений (хунки).
 *
 * Нужно для частичного индексирования: человек хочет отправить в индекс не файл
 * целиком, а отдельную правку. У `git` это делается так: взять из diff один хунк
 * вместе с заголовком файла и приложить его к индексу (`git apply --cached`).
 * Модуль чистый — он только режет текст diff, а запуск `git` остаётся в main.
 *
 * Заголовок файла (`diff --git`, `index`, `---`, `+++`) общий для всех хунков:
 * без него отдельный кусок патча `git apply` не примет, поэтому он хранится
 * рядом и вклеивается в каждый собранный патч.
 */

/** Границы блока изменений: по строкам старой и новой версии (1-based). */
export interface DiffHunkRange {
  /** Строка в старой версии, где начинается блок. */
  oldStart: number;
  /** Сколько строк старой версии охватывает блок (0 — только добавления). */
  oldCount: number;
  /** Строка в новой версии, где начинается блок. */
  newStart: number;
  /** Сколько строк новой версии охватывает блок (0 — только удаления). */
  newCount: number;
}

interface ParsedHunk {
  range: DiffHunkRange;
  /** Строка `@@ -a,b +c,d @@ …` как есть: хвост после `@@` — подсказка о контексте. */
  header: string;
  /** Тело блока: строки контекста (` `), добавления (`+`) и удаления (`-`). */
  lines: string[];
}

interface ParsedDiff {
  /** Всё до первого блока: заголовок файла. */
  header: string[];
  hunks: ParsedHunk[];
}

/** Строка-заголовок блока: `@@ -1,3 +1,4 @@`. Хвост после второго `@@` необязателен. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** С какого символа начинается строка тела блока: контекст, добавление, удаление, «нет \n». */
const BODY_LINE = /^[ +\-\\]/;

function parseRange(line: string): DiffHunkRange | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  // Пропущенные числа в шапке означают «одна строка»: `@@ -5 +5 @@` это `-5,1 +5,1`.
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isFinite)) return null;
  return { oldStart, oldCount, newStart, newCount };
}

function parseDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  // В diff всегда есть перевод строки в конце — последний пустой элемент не строка.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const header: string[] = [];
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      const range = parseRange(line);
      // Шапка блока не разобралась — считаем блок негодным и ждём следующий.
      current = range ? { range, header: line, lines: [] } : null;
      if (current) hunks.push(current);
      continue;
    }

    if (current) {
      // Тело блока продолжается, пока строка начинается со знака изменения.
      if (BODY_LINE.test(line)) {
        current.lines.push(line);
        continue;
      }
      // Что-то иное (заголовок следующего файла) — блок кончился.
      current = null;
    }

    header.push(line);
  }

  return { header, hunks };
}

/**
 * Границы блоков изменений — их показывает интерфейс, чтобы поставить у каждого
 * свою кнопку. Порядок блоков — файловый, тот же, что у `git`.
 */
export function hunkRanges(text: string): DiffHunkRange[] {
  return parseDiff(text).hunks.map((hunk) => hunk.range);
}

/**
 * Патч из одного блока: заголовок файла плюс сам хунк. `null` — блока с таким
 * номером нет или заголовок файла пуст (резать нечего). Такой патч `git apply`
 * прикладывает к индексу, не трогая остальные правки файла.
 */
export function hunkPatch(text: string, index: number): string | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const diff = parseDiff(text);
  const hunk = diff.hunks[index];
  if (!hunk || diff.header.length === 0) return null;

  const lines = [...diff.header, hunk.header, ...hunk.lines];
  return `${lines.join('\n')}\n`;
}
