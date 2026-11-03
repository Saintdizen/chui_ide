/**
 * Показ блока конфликта против общего предка.
 *
 * Без базы (`git merge` по умолчанию) стороны видны двумя соседними текстами, и
 * непонятно, что из них правка, а что было раньше: кусок строк читается как
 * «переписано всё». Базу git показывает в файле только в стиле diff3/zdiff3, но
 * в индексе она есть всегда (стадия 1) — вот её и сверяем. Это ПОДСКАЗКА
 * («тронуто / нетронуто»); исходный текст сторон не меняется.
 */

/**
 * Что стало со строкой базы на месте строки стороны.
 *
 * `same` — та же самая; `changed` — на её месте другая или её нет. «Удалено»
 * отдельным значением нет: сторона — это список строк, у неё нет пустых мест,
 * и отличать «переписал» от «убрал» можно только соседством строк базы.
 */
export type BaseLineState = 'same' | 'changed';

/** Строка стороны с тем, что стало с базой на её месте. */
export interface AnnotatedLine {
  text: string;
  /** Строка стороны (1-based). */
  line: number;
  state: BaseLineState;
}

/** Абзац, в котором хоть одна сторона отошла от базы: это и есть «что решают». */
export interface BaseDiffHunk {
  ours: AnnotatedLine[];
  theirs: AnnotatedLine[];
  /** Сколько строк базы правил этот абзац — по нему видно, спорят ли об одном. */
  baseLines: number;
}

/**
 * Потолок таблицы выравнивания. Выше — «два разных файла»: подробный разбор
 * дороже, чем польза от него, и мы честно отдаём пусто.
 */
const MAX_CELLS = 2_000_000;

/** Пустой текст — ноль строк, а не одна пустая. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Где каждая строка базы встала в стороне: индексы строк стороны или -1.
 *
 * `null` — упёрлись в потолок таблицы: вызывающий покажет стороны без разметки.
 * Больше от выравнивания ничего не нужно: `at[i] >= 0` — строка базы сохранилась,
 * `-1` — переписана.
 */
function matchBase(base: readonly string[], side: readonly string[]): Int32Array | null {
  const rows = base.length;
  const cols = side.length;
  const at = new Int32Array(rows).fill(-1);
  if (rows === 0 || cols === 0) return at;
  if ((rows + 1) * (cols + 1) > MAX_CELLS) return null;

  const width = cols + 1;
  const dp = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        base[i] === side[j]
          ? dp[(i + 1) * width + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (base[i] === side[j]) {
      at[i] = j;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) i += 1;
    else j += 1;
  }
  return at;
}

/** Что стало с базой на месте строки стороны. */
function stateOf(at: Int32Array, sideIndex: number): BaseLineState {
  return at.includes(sideIndex) ? 'same' : 'changed';
}

/**
 * Разложить стороны на абзацы против базы.
 *
 * Абзацы, где ОБЕ стороны буквально повторили базу, не возвращаются: решать в них
 * нечего. Пустая база (файл добавлен с обеих сторон) — тоже пусто: сравнивать не
 * с чем, стороны показываются целиком (§ описание `GitConflictParts`).
 *
 * Граница абзаца — строка базы, которую сохранили ОБЕ стороны. Всё остальное —
 * «сторона отошла от базы».
 */
export function diffAgainstBase(ours: string, theirs: string, base: string): BaseDiffHunk[] {
  const baseLines = splitLines(base);
  if (baseLines.length === 0) return [];
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);

  const oursAt = matchBase(baseLines, oursLines);
  const theirsAt = matchBase(baseLines, theirsLines);
  // Без выравнивания всё окажется «изменённым» — подсказка соврёт: молчим.
  if (!oursAt || !theirsAt) return [];

  const hunks: BaseDiffHunk[] = [];
  let oursFrom = 0;
  let theirsFrom = 0;
  let baseFrom = 0;

  const flush = (baseTo: number, oursTo: number, theirsTo: number) => {
    const oursSlice = oursLines.slice(oursFrom, oursTo).map((text, k) => ({
      text,
      line: oursFrom + k + 1,
      state: stateOf(oursAt, oursFrom + k),
    }));
    const theirsSlice = theirsLines.slice(theirsFrom, theirsTo).map((text, k) => ({
      text,
      line: theirsFrom + k + 1,
      state: stateOf(theirsAt, theirsFrom + k),
    }));
    const touched = oursSlice.some((l) => l.state !== 'same') || theirsSlice.some((l) => l.state !== 'same');
    if (touched) hunks.push({ ours: oursSlice, theirs: theirsSlice, baseLines: baseTo - baseFrom });
    oursFrom = oursTo;
    theirsFrom = theirsTo;
    baseFrom = baseTo;
  };

  for (let i = 0; i < baseLines.length; i += 1) {
    const shared = oursAt[i]! >= 0 && theirsAt[i]! >= 0;
    if (!shared) continue;
    // Всё до общей строки — спорный абзац; сама общая строка в него не входит.
    flush(i, oursAt[i]!, theirsAt[i]!);
    oursFrom = oursAt[i]! + 1;
    theirsFrom = theirsAt[i]! + 1;
    baseFrom = i + 1;
  }
  flush(baseLines.length, oursLines.length, theirsLines.length);
  return hunks;
}
