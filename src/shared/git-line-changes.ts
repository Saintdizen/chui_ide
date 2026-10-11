/**
 * Построчные изменения файла относительно сохранённой версии — для полосок в
 * жёлобе редактора (добавлено / изменено / удалено).
 *
 * Модуль чистый: на вход две версии текста, на выход — какие строки ТЕКУЩЕЙ
 * версии появились, изменились или после какой строки что-то удалили. Ни git,
 * ни DOM здесь нет — поэтому проверяется тестами напрямую.
 *
 * Как считаем: общие строки в начале и в конце отсекаем сразу (это обычный
 * случай правки в середине файла), а по остатку ищем наибольшую общую
 * подпоследовательность. Так «переписанный блок» читается как изменение строк,
 * а не как «всё удалено и всё добавлено заново».
 */

/** Что произошло со строкой: появилась, изменилась или рядом удалили. */
export type LineChangeKind = 'added' | 'modified' | 'deleted';

export interface GitLineChange {
  /**
   * Строка в текущей версии файла (1-based). Для `deleted` — строка ПЕРЕД
   * удалённым местом: самой удалённой строки уже нет, а полоску нужно к чему-то
   * привязать (так же помечает удаления VS Code).
   */
  line: number;
  kind: LineChangeKind;
}

/**
 * Потолок таблицы LCS. После отсечения общих краёв середина обычно крошечная;
 * числа выше — это уже «два разных файла», где подробный разбор бесполезен:
 * помечаем весь остаток изменённым, не тратя память на таблицу.
 */
const MAX_CELLS = 2_000_000;

/** Пустой текст — ноль строк, а не одна пустая: так «файла не было» ≠ «одна строка». */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // Завершающий перевод строки — терминатор последней строки, а не пустая строка
  // после неё: без этого у каждого файла с \n в конце была бы лишняя «добавленная».
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineChanges(original: string, modified: string): GitLineChange[] {
  const a = splitLines(original);
  const b = splitLines(modified);

  // Общее начало и общий конец — не изменения: ищем только по середине.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return [];

  const changes: GitLineChange[] = [];
  // Строка текущей версии, которую разбираем прямо сейчас (1-based).
  let newLine = start + 1;

  const rows = midA.length;
  const cols = midB.length;

  if ((rows + 1) * (cols + 1) > MAX_CELLS) {
    for (let j = 0; j < cols; j += 1) changes.push({ line: newLine + j, kind: 'modified' });
    return changes;
  }

  // dp[i][j] — длина общей подпоследовательности остатков midA[i:] и midB[j:].
  const width = cols + 1;
  const dp = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        midA[i] === midB[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    // Общая строка — не изменение: обе версии идут дальше одновременно.
    if (i < rows && j < cols && midA[i] === midB[j]) {
      i += 1;
      j += 1;
      newLine += 1;
      continue;
    }

    // Собрали блок изменений: идём до следующей общей строки, считая удаления и вставки.
    let deleted = 0;
    let inserted = 0;
    while (i < rows || j < cols) {
      if (i < rows && j < cols && midA[i] === midB[j]) break;
      // При равной длине остатка предпочитаем провести строку как удаление: так
      // «переписанная» строка читается изменением, а не парой «удалил — добавил».
      if (i < rows && (j >= cols || dp[(i + 1) * width + j] >= dp[i * width + (j + 1)])) {
        i += 1;
        deleted += 1;
      } else {
        j += 1;
        inserted += 1;
      }
    }

    if (deleted > 0 && inserted === 0) {
      // Чистое удаление: привязываем полоску к строке перед пропуском.
      changes.push({ line: Math.max(newLine - 1, 1), kind: 'deleted' });
    } else {
      for (let k = 0; k < inserted; k += 1) {
        changes.push({ line: newLine + k, kind: deleted > 0 ? 'modified' : 'added' });
      }
      newLine += inserted;
    }
  }

  return changes;
}
