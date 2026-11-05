import type { ExpandedSnippet } from './snippet';

/**
 * Обход мест раскрытого сниппета по `Tab` / `Shift+Tab` (TASKS 45).
 *
 * После вставки каретка стоит на первом месте. `Tab` переводит на следующее, `Shift+Tab` —
 * на предыдущее; за последним местом `Tab` выходит из сниппета (каретка за текстом заготовки),
 * перед первым `Shift+Tab` — остаётся на первом. Сами места уже посчитаны разбором
 * (`snippet.ts`): здесь только порядок и границы — ни буфера, ни DOM.
 */

/** Место: выделить его текст, чтобы набираемое заменяло черновик. */
export interface SnippetStop {
  readonly start: number;
  readonly end: number;
}

/** Куда встать: `stop` — выделение места, `null` — вышли за сниппет. */
interface SnippetJump {
  readonly stop: SnippetStop | null;
  readonly done: boolean;
}

export class SnippetSession {
  /** Места в смещенияниях документа; `$0` пробела не имеет — туда просто встать. */
  private readonly stops: readonly SnippetStop[];
  private readonly lastIndex: number;
  private index = 0;

  constructor(expanded: ExpandedSnippet, base: number) {
    this.stops = expanded.tabstops.map((stop) => ({ start: base + stop.start, end: base + stop.end }));
    this.lastIndex = Math.max(this.stops.length - 1, 0);
  }

  get isEmpty(): boolean {
    return this.stops.length === 0;
  }

  /** Место, на котором стоим; `null` — уже вышли. */
  get current(): SnippetStop | null {
    return this.stops[this.index] ?? null;
  }

  /**
   * Укладывается ли правка в заготовку: набранное меняет текст места — это законно,
   * а правка в стороне значит, что сниппет уже не тот, и места после неё сдвинулись.
   */
  coversChange(from: number): boolean {
    const first = this.stops[0];
    const last = this.stops[this.lastIndex];
    if (!first || !last) return false;
    return from >= first.start && from <= last.end;
  }

  /**
   * `Tab`. Последнее место — выходим: каретка за ним и без выделения, дальше Tab — уже
   * отступ. `done` говорит обработчику клавиши, что сниппет кончился.
   */
  next(): SnippetJump {
    if (this.isEmpty) return { stop: null, done: true };
    if (this.index >= this.lastIndex) {
      const last = this.stops[this.lastIndex]!;
      this.index = this.stops.length;
      return { stop: { start: last.end, end: last.end }, done: true };
    }
    this.index += 1;
    return { stop: this.current, done: false };
  }

  /** `Shift+Tab`. На первом месте — остаёмся (уступать клавишу нечему). */
  previous(): SnippetJump {
    if (this.index > 0) this.index -= 1;
    return { stop: this.current, done: false };
  }
}
