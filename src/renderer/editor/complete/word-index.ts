/**
 * Словарь документа: какие слова в файле вообще есть.
 *
 * Подсказки в редакторе кода работают в двух слоях, и нижний — самый честный: подсказать
 * то, что человек уже написал. Файл знает свои имена лучше любого словаря языка: локальная
 * переменная `activeRow` не встречается в стандартной библиотеке, но в этом файле — вот она,
 * двенадцать раз.
 *
 * Собираем слова ПО ХОДУ, а не разом при открытии файла. Собрать словарный запас всех ста
 * тысяч строк стоит заметное время и память, а человеку в первый момент нужны подсказки
 * только по видимому куску. Поэтому индекс наполняется строками, которые трогает
 * представление: сколько строк увидели — с тех и слова. За сессию наберётся столько,
 * сколько человек реально просмотрел, а не весь файл.
 *
 * Частота нужна для порядка: слова, встречающиеся чаще, — вероятнее (и `const`, и
 * `function` попадаются в файле десятки раз, а редкая опечатка — один). Порядок по частоте
 * и длине, а не по алфавиту: алфавит поставил бы `aaa` выше `value`, и это всем мешает.
 *
 * Хранилище — `Map` от слова к счётчику. `Map` держит порядок вставки, поэтому
 * одинаковые по частоте слова сохраняют порядок появления в тексте — а это тоже подсказка:
 * что написано раньше, то уже «своё».
 */

/** Минимальная длина слова, попадающего в словарь: короткие — шум и почти всегда не нужны. */
const MIN_WORD_LENGTH = 2;

/** Предел размера словаря: дальше подсказки всё равно не просматривают, а память тратится. */
export const MAX_WORDS = 20000;

/** Разбиение строки на слова: буквы и цифры плюс `_`, ничего больше. */
const WORD_SPLIT = /[\p{L}\p{Nl}\p{Nd}_$]+/gu;

export class WordIndex {
  /** Слово → сколько раз встретилось. Порядок вставки сохраняется — он же и «старшинство». */
  private readonly counts = new Map<string, number>();
  /** Строки, уже попавшие в словарь: пересканирование той же строки ничего не меняет. */
  private readonly seen = new Set<number>();
  private limit: number;

  constructor(limit = MAX_WORDS) {
    this.limit = limit;
  }

  get size(): number {
    return this.counts.size;
  }

  /** Добавить слова из строки. Повторный вызов для той же строки ничего не делает. */
  addLine(line0: number, text: string): void {
    if (this.seen.has(line0)) return;
    this.seen.add(line0);
    if (this.counts.size >= this.limit) return;
    for (const match of text.matchAll(WORD_SPLIT)) {
      const word = match[0];
      if (word.length < MIN_WORD_LENGTH) continue;
      this.counts.set(word, (this.counts.get(word) ?? 0) + 1);
      if (this.counts.size >= this.limit) return;
    }
  }

  /** Добавить слова из набора строк — так наполняет словарь представление. */
  addLines(fromLine: number, lines: readonly string[]): void {
    for (let index = 0; index < lines.length; index += 1) this.addLine(fromLine + index, lines[index]!);
  }

  /** Забыть строку: она изменилась, и её слова надо пересчитать при следующем показе. */
  invalidate(line0: number): void {
    this.seen.delete(line0);
  }

  /** Забыть всё — новый документ или смена языка. */
  reset(): void {
    this.counts.clear();
    this.seen.clear();
  }

  /** Сколько раз слово встретилось. Ноль — слова в словаре нет. */
  count(word: string): number {
    return this.counts.get(word) ?? 0;
  }

  /**
   * Слова, начинающиеся с `prefix`, в порядке убывания частоты. При равной частоте
   * сначала короткие, потом — раньше появившиеся: так `value` встанет выше `valueWithParens`.
   */
  candidates(prefix: string, limit: number, exclude: ReadonlySet<string> = new Set()): string[] {
    if (prefix.length === 0) return [];
    const lowered = prefix.toLowerCase();
    // Слово, совпавшее с набранным, не предлагаем: дополнять его нечем — оно уже целиком в тексте.
    return this.select(
      limit,
      (word) => word.toLowerCase() !== lowered && word.toLowerCase().startsWith(lowered),
      exclude,
    );
  }

  /**
   * Самые ходовые слова словаря — без ограничения по префиксу. Нужны подсказкам по
   * вызову (Ctrl+Space): там префикса нет, а показать надо самое полезное.
   */
  allWords(limit: number, exclude: ReadonlySet<string> = new Set()): string[] {
    return this.select(limit, () => true, exclude);
  }

  /** Общий отбор с сортировкой: по частоте, затем по длине, затем по порядку появления. */
  private select(limit: number, accept: (word: string) => boolean, exclude: ReadonlySet<string>): string[] {
    const found: Array<{ word: string; count: number; order: number }> = [];
    let order = 0;
    for (const [word, count] of this.counts) {
      if (!exclude.has(word) && accept(word)) found.push({ word, count, order });
      order += 1;
    }

    found.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.word.length !== b.word.length) return a.word.length - b.word.length;
      return a.order - b.order;
    });

    return found.slice(0, limit).map((item) => item.word);
  }
}
