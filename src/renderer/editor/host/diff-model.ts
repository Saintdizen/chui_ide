/**
 * Сравнение двух версий файла: выровненные строки и блоки изменений.
 *
 * Модуль чистый: на вход две строки, на выход — построчное сопоставление версий.
 * Ни git, ни DOM, ни движка здесь нет, поэтому результат проверяется тестами прямо.
 *
 * Зачем отдельный модуль, если есть `shared/git-line-changes.ts`. Тот отвечает на
 * узкий вопрос жёлоба редактора: «какие строки ТЕКУЩЕЙ версии добавлены, изменены
 * или рядом с чем удалили» — одной строкой на изменение. Для сравнения нужно другое:
 * обе версии, СТРОКА К СТРОКЕ, чтобы поставить их рядом и подсветить пары. Один и тот
 * же LCS лежит в основе обоих, но выход разный — и смешивать их значило бы в одном
 * модуле отвечать сразу на два вопроса.
 *
 * Как считаем: общие строки в начале и в конце отсекаем сразу (обычная правка в
 * середине файла), а по остатку ищем наибольшую общую подпоследовательность. Затем
 * идём по остатку и собираем «блок изменений»: подряд идущие удаления и вставки.
 * Внутри блока пары строк сопоставляются: первая удалённая с первой вставленной — это
 * `replace` (изменённая строка), а лишние с той или иной стороны — `delete` или
 * `insert`. Так «переписанный блок» читается как изменённые строки, а не как всё
 * удалено и всё добавлено заново.
 *
 * Смысл выравнивания — в `DiffRow`: у каждой строки обе стороны (номер и текст) или
 * `null`, если с этой стороны строки нет. Именно по этому ряду и рисуется сравнение:
 * либо две колонки (рядом), либо одна (встроенно), где удаления и вставки идут подряд.
 */

/** Что за строка в выравнивании. */
export type DiffRowKind = 'equal' | 'insert' | 'delete' | 'replace';

/** Одна строка выравнивания: обе стороны этого ряда. */
export interface DiffRow {
  readonly kind: DiffRowKind;
  /** Номер строки в исходной версии (1 с единицы) или `null`, если строки нет. */
  readonly originalLine: number | null;
  /** Номер строки в изменённой версии или `null`. */
  readonly modifiedLine: number | null;
  readonly originalText: string;
  readonly modifiedText: string;
}

/** Блок изменений: подряд идущие непустые ряды. По блокам ходят «вперёд/назад». */
export interface DiffHunk {
  readonly index: number;
  /** Строка исходной версии, с которой начинается блок (1 с единицы). */
  readonly originalStartLine: number;
  /** Строка изменённой версии, с которой начинается блок — к ней ведёт переход. */
  readonly modifiedStartLine: number;
  readonly originalCount: number;
  readonly modifiedCount: number;
}

export interface DiffModel {
  readonly rows: readonly DiffRow[];
  readonly hunks: readonly DiffHunk[];
}

/**
 * Потолок таблицы LCS. После отсечения общих краёв середина обычно крошечная; числа
 * выше — это уже «два разных файла», где подробный разбор бесполезен: считаем весь
 * остаток заменённым, не тратя память на таблицу.
 */
const MAX_CELLS = 2_000_000;

/** Пустой текст — ноль строк, а не одна пустая: так «файла не было» ≠ «одна строка». */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // Завершающий перевод строки — терминатор последней строки, а не пустая строка
  // после неё: иначе у каждого файла с \n в конце была бы лишняя «добавленная».
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Выровнять две версии текста построчно. */
export function buildDiff(original: string, modified: string): DiffModel {
  const a = splitLines(original);
  const b = splitLines(modified);
  const rows: DiffRow[] = [];

  // Общее начало и общий конец — не изменения: ищем только по середине.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  for (let k = 0; k < start; k += 1) rows.push(equalRow(k + 1, k + 1, a[k]!));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  appendMiddle(rows, midA, midB, start);
  // Остаток строки исходной версии, не попавшие в середину.
  const suffixA = a.length - endA;
  for (let k = 0; k < suffixA; k += 1) {
    rows.push(equalRow(endA + k + 1, endB + k + 1, a[endA + k]!));
  }

  return { rows, hunks: groupHunks(rows) };
}

/** Пройти середину и разложить её на ряды: совпадения, замены, вставки и удаления. */
function appendMiddle(rows: DiffRow[], midA: string[], midB: string[], base: number): void {
  const rowCount = midA.length;
  const colCount = midB.length;
  if (rowCount === 0 && colCount === 0) return;

  // Середина слишком большая для таблицы — считаем всё вставленным (или всё удалённым).
  if ((rowCount + 1) * (colCount + 1) > MAX_CELLS) {
    appendBlock(rows, midA, midB, base + 1, base + 1);
    return;
  }

  // dp[i][j] — длина общей подпоследовательности midA[i:] и midB[j:].
  const width = colCount + 1;
  const dp = new Uint32Array((rowCount + 1) * width);
  for (let i = rowCount - 1; i >= 0; i -= 1) {
    for (let j = colCount - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        midA[i] === midB[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  let i = 0;
  let j = 0;
  let originalLine = base + 1;
  let modifiedLine = base + 1;

  while (i < rowCount || j < colCount) {
    if (i < rowCount && j < colCount && midA[i] === midB[j]) {
      rows.push(equalRow(originalLine, modifiedLine, midA[i]!));
      i += 1;
      j += 1;
      originalLine += 1;
      modifiedLine += 1;
      continue;
    }

    // Собрали блок изменений: идём до следующей общей строки, считая удаления и вставки.
    const delStart = i;
    const insStart = j;
    while (i < rowCount || j < colCount) {
      if (i < rowCount && j < colCount && midA[i] === midB[j]) break;
      // При равной длине остатка предпочитаем провести строку как удаление: так
      // «переписанная» строка читается изменением, а не парой «удалил — добавил».
      if (i < rowCount && (j >= colCount || dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!)) {
        i += 1;
      } else {
        j += 1;
      }
    }

    appendBlock(rows, midA.slice(delStart, i), midB.slice(insStart, j), originalLine, modifiedLine);
    originalLine += i - delStart;
    modifiedLine += j - insStart;
  }
}

/**
 * Разложить блок изменений на ряды. Совпавшие по позиции строки становятся заменой,
 * а лишние с одной стороны — удалением или вставкой. Так рядом стоящие версии читаются
 * построчно, а не «всё удалено и всё добавлено».
 */
function appendBlock(
  rows: DiffRow[],
  dels: string[],
  inserts: string[],
  originalLine: number,
  modifiedLine: number,
): void {
  const paired = Math.min(dels.length, inserts.length);
  for (let k = 0; k < paired; k += 1) {
    rows.push({
      kind: 'replace',
      originalLine: originalLine + k,
      modifiedLine: modifiedLine + k,
      originalText: dels[k]!,
      modifiedText: inserts[k]!,
    });
  }
  for (let k = paired; k < dels.length; k += 1) {
    rows.push({
      kind: 'delete',
      originalLine: originalLine + k,
      modifiedLine: null,
      originalText: dels[k]!,
      modifiedText: '',
    });
  }
  for (let k = paired; k < inserts.length; k += 1) {
    rows.push({
      kind: 'insert',
      originalLine: null,
      modifiedLine: modifiedLine + k,
      originalText: '',
      modifiedText: inserts[k]!,
    });
  }
}

function equalRow(originalLine: number, modifiedLine: number, text: string): DiffRow {
  return { kind: 'equal', originalLine, modifiedLine, originalText: text, modifiedText: text };
}

/** Сгруппировать непустые ряды в блоки: по ним ходят «следующий/предыдущий блок». */
function groupHunks(rows: readonly DiffRow[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffRow[] = [];
  // Номера строк перед блоком: нужны, когда у блока с одной стороны строк нет вовсе
  // (чистое удаление или чистая вставка) — тогда началом служит строка после предыдущей.
  let lastOriginal = 0;
  let lastModified = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    const originalLines = current.filter((row) => row.originalLine !== null).length;
    const modifiedLines = current.filter((row) => row.modifiedLine !== null).length;
    hunks.push({
      index: hunks.length,
      originalStartLine: first.originalLine ?? lastOriginal + 1,
      modifiedStartLine: first.modifiedLine ?? lastModified + 1,
      originalCount: originalLines,
      modifiedCount: modifiedLines,
    });
    current = [];
  };

  for (const row of rows) {
    if (row.kind === 'equal') {
      flush();
      lastOriginal = row.originalLine ?? lastOriginal;
      lastModified = row.modifiedLine ?? lastModified;
      continue;
    }
    current.push(row);
  }
  flush();
  return hunks;
}
