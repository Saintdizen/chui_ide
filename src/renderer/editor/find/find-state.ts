/**
 * Состояние поиска: запрос, настройки и найденные совпадения.
 *
 * Панель поиска — это не только окошко с полем: за ней стоит «что сейчас ищется» и
 * «сколько нашлось». Такое состояние удобно держать отдельно от разметки, потому что
 * его спрашивают и панель, и подсветка совпадений в представлении, и команды перехода
 * к следующему совпадению. Виджет тут — только вид.
 *
 * Пересчёт делается по запросу, а не на каждое нажатие клавиши: поиск по большому
 * файлу занимает время, и если пересчитывать на каждый символ, набор в поле начнёт
 * отставать. Кто вызывает `update` — решает вызывающий (виджет соберёт это по времени).
 *
 * Модуль чистый: он не знает ни о DOM, ни о выделении. Что делать с найденным —
 * подсветить, перейти, заменить — решает вызывающий.
 */

import { findMatches, matchIndexAt, type FindMatch, type FindOptions } from './search';

/** Что нужно знать, чтобы искать: где взять строки и сколько их. */
export interface SearchSource {
  getLine(line0: number): string;
  readonly lineCount: number;
}

export interface SearchSnapshot {
  readonly query: string;
  readonly options: FindOptions;
  readonly matches: readonly FindMatch[];
  /** Номер текущего совпадения (с нуля) или `-1`, если совпадений нет. */
  readonly current: number;
  /** Ошибка разбора регулярки, если она есть. */
  readonly error: string | null;
  /** Список оборван по пределу — совпадений больше, чем помещается. */
  readonly truncated: boolean;
}

export class FindState {
  private source: SearchSource;
  private query = '';
  private options: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };
  private matches: FindMatch[] = [];
  private current = -1;
  private error: string | null = null;
  private truncated = false;

  constructor(source: SearchSource) {
    this.source = source;
  }

  /** Сменить документ: совпадения прежнего к нему не относятся. */
  setSource(source: SearchSource): void {
    this.source = source;
    this.update();
  }

  get snapshot(): SearchSnapshot {
    return {
      query: this.query,
      options: this.options,
      matches: this.matches,
      current: this.current,
      error: this.error,
      truncated: this.truncated,
    };
  }

  get isEmpty(): boolean {
    return this.query.length === 0 || this.matches.length === 0;
  }

  /** Количество совпадений — для счётчика в панели. */
  get count(): number {
    return this.matches.length;
  }

  get currentMatch(): FindMatch | null {
    return this.current >= 0 ? (this.matches[this.current] ?? null) : null;
  }

  /** Задать запрос и настройки; `from` — смещение курсора, чтобы встать на ближайшее совпадение. */
  setQuery(query: string, options: Partial<FindOptions> = {}, from = 0): void {
    this.query = query;
    this.options = { ...this.options, ...options };
    this.update(from);
  }

  /** Пересчитать совпадения. Документ мог измениться — тогда зовите без аргумента. */
  update(from = 0): void {
    if (this.query.length === 0) {
      this.matches = [];
      this.current = -1;
      this.error = null;
      this.truncated = false;
      return;
    }
    const result = findMatches((line0) => this.source.getLine(line0), this.source.lineCount, this.query, this.options);
    this.matches = result.matches;
    this.error = result.error;
    this.truncated = result.truncated;
    // Текущим становится совпадение у курсора, а если его нет — ближайшее справа.
    this.current = this.matches.length === 0 ? -1 : matchIndexAt(this.matches, from);
  }

  /**
   * Перевести текущее совпадение на `delta` вперёд или назад ПО КРУГУ: после
   * последнего идёт первое. Так и ведут себя все редакторы, и человек к этому привык.
   */
  move(delta: number): FindMatch | null {
    if (this.matches.length === 0) return null;
    const size = this.matches.length;
    this.current = (((this.current + delta) % size) + size) % size;
    return this.matches[this.current] ?? null;
  }

  /** Встать на совпадение с номером (с нуля). */
  select(index: number): FindMatch | null {
    if (index < 0 || index >= this.matches.length) return null;
    this.current = index;
    return this.matches[index] ?? null;
  }
}
