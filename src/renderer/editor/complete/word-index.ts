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

import { matchScore } from './fuzzy';

/** Минимальная длина слова, попадающего в словарь: короткие — шум и почти всегда не нужны. */
const MIN_WORD_LENGTH = 2;

/** Предел размера словаря: дальше подсказки всё равно не просматривают, а память тратится. */
export const MAX_WORDS = 20000;

/** Разбиение строки на слова: буквы и цифры плюс `_`, ничего больше. */
const WORD_SPLIT = /[\p{L}\p{Nl}\p{Nd}_$]+/gu;

/**
 * Где начинается "своё" объявление в строке. Проверяется по строке, а не по дереву
 * разбора: полного разбора в renderer нет, и заводить его ради подсказок слишком дорого.
 * Набор нарочно широкий — `const`, `let`, `def`, `func`, `fn`, `val`, `var`, `class`, `interface`.
 */
const DECLARES = /(?:^|[\s;{}(,])(?:const|let|var|function|class|interface|type|enum|def|func|fn|val|struct|impl)\s+/u;

/** Объявление через стрелку, параметр или поле объекта: `имя =`, `имя:` в начале строки. */
const ASSIGNS = /^\s*([\w$][\w$\d]*)\s*(?:=(?!=)|:)/u;

export class WordIndex {
  /** Слово → сколько раз встретилось. Порядок вставки сохраняется — он же и «старшинство». */
  private readonly counts = new Map<string, number>();
  /** Строки, уже попавшие в словарь: пересканирование той же строки ничего не меняет. */
  private readonly seen = new Set<number>();
  /**
   * Слова, объявленные в самих строках: `const activeRow =` — это "своё ближнее" имя,
   * а не просто слово из текста. Без второго прохода по AST — по строке объявления.
   */
  private readonly declared = new Set<string>();
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
    // Объявленное запоминаем ДО предела размера: объявление короткой строки — самое
    // ценное, а лимит словаря при длинном файле может уже быть выбран.
    const declared = declaredIn(text);
    if (declared) this.declared.add(declared);
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
    this.declared.clear();
  }

  /** Сколько раз слово встретилось. Ноль — слова в словаре нет. */
  count(word: string): number {
    return this.counts.get(word) ?? 0;
  }

  /**
   * Слово объявлено в файле (`const activeRow =`), а не просто встретилось в тексте.
   *
   * Это дешёвый признак "своего": местные имена человек называет сам, и при равной
   * форме совпадения они ему нужнее слов из чужих строк. От полной области видимости
   * он отличается тем, что не знает ни границ блока, ни порядка объявления — только сам
   * факт объявления. Для надбавки к оценке этого хватает.
   */
  isDeclared(word: string): boolean {
    return this.declared.has(word);
  }

  /**
   * Слова, начинающиеся с `prefix`, в порядке убывания частоты. При равной частоте
   * сначала короткие, потом — раньше появившиеся: так `value` встанет выше `valueWithParens`.
   */
  candidates(prefix: string, limit: number, exclude: ReadonlySet<string> = new Set()): string[] {
    if (prefix.length === 0) return [];
    const lowered = prefix.toLowerCase();
    // Слово, совпавшее с набранным, не предлагаем: дополнять его нечем — оно уже целиком в тексте.
    // Совпадение — не только по началу: `gT` находит `getTitle` (см. `fuzzy.ts`), поэтому
    // имена из файла предлагаются по совпадению, а не по одному `startsWith`.
    return this.select(limit, (word) => word.toLowerCase() !== lowered && matchScore(word, prefix) !== null, exclude);
  }

  /**
   * Самые ходовые слова словаря — без ограничения по префиксу. Нужны подсказкам по
   * вызову (Ctrl+Space): там префикса нет, а показать надо самое полезное.
   */
  allWords(limit: number, exclude: ReadonlySet<string> = new Set()): string[] {
    return this.select(limit, () => true, exclude);
  }

  /** Общий отбор с сортировкой: сначала объявленные, потом по частоте, длине и порядку появления. */
  private select(limit: number, accept: (word: string) => boolean, exclude: ReadonlySet<string>): string[] {
    const found: Array<{ word: string; count: number; order: number; declared: boolean }> = [];
    let order = 0;
    for (const [word, count] of this.counts) {
      if (!exclude.has(word) && accept(word)) found.push({ word, count, order, declared: this.declared.has(word) });
      order += 1;
    }

    // Объявленное своим кодом — вперёд: `createRow` из этого файла вероятнее `create`
    // из библиотеки, даже если последнее встретилось чаще (в файле — оно же в чужих строках).
    found.sort((a, b) => {
      if (a.declared !== b.declared) return a.declared ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      if (a.word.length !== b.word.length) return a.word.length - b.word.length;
      return a.order - b.order;
    });

    return found.slice(0, limit).map((item) => item.word);
  }
}

/** Имя из объявления в строке: `const activeRow =` → `activeRow`. Нет объявления — `null`. */
function declaredIn(text: string): string | null {
  const afterKeyword = DECLARES.exec(text);
  const rest = afterKeyword ? text.slice(afterKeyword.index + afterKeyword[0].length) : text;
  const assigned = ASSIGNS.exec(rest);
  if (assigned) return assigned[1] ?? null;
  // `function parse(` — слово идёт сразу после ключевого слова, даже без `=` и `:`.
  const bare = /^([\w$][\w$\d]*)\s*[(<]/u.exec(rest);
  return bare?.[1] ?? null;
}
