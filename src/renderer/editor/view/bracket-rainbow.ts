/**
 * Радужные скобки: цвет парных скобок по уровню вложенности.
 *
 * Одинаково вложенные скобки одного уровня красятся одним цветом, следующий уровень —
 * следующим: по цвету видно, какая скобка какую закрывает, не водя по ним курсором.
 * Уровень считается по всему документу, а не по видимой части, — иначе цвет скобки
 * менялся бы при прокрутке. Считаем дешёво: вложенность строки на входе — обычное
 * число, и по нему уровень считается по строке без заглядывания в соседей.
 *
 * Скобки внутри комментариев и строк не считаем: там они — часть текста, а не код, и
 * `// (a)` не должно поднимать уровень ниже. Какие куски пропускать, подсказывает
 * разбор подсветки (`highlight/tokens.ts`): скобка под токеном `comment`/`string` молчит.
 *
 * Уровень меняется от строки к строке, поэтому кэш повторяет приём подсветки: помним
 * вложенность в начале каждой строки и сходимся, как только правка не изменила уровень
 * на выходе. Так правка в начале файла не пересчитывает весь файл.
 *
 * Модуль чистый: ни DOM, ни модели текста — текст и токены приходят функциями. Поэтому
 * его видно в тестах без окна.
 */

import { COMMENT, STRING, type Token } from '../highlight/tokens';

/** Сколько цветов в радуге — столько и классов `is-depth-0…`. */
export const RAINBOW_SIZE = 3;

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

/** Типы токенов, внутри которых скобка — часть текста, а не вложенность. */
const IGNORED = new Set([COMMENT, STRING]);

/** Скобка строки и её уровень: 0 — самый внешний. */
export interface BracketMark {
  /** Столбец скобки в строке (единицы UTF-16). */
  readonly start: number;
  readonly depth: number;
}

/**
 * Скобки строки с уровнем вложенности. `startDepth` — вложенность в начале строки
 * (её знает кэш), `tokens` — разбор строки: скобки внутри комментариев и строк
 * пропускаем. Возвращаем и вложенность на выходе — её унаследует строка ниже.
 */
export function bracketMarks(
  text: string,
  startDepth: number,
  tokens: readonly Token[],
): { marks: BracketMark[]; endDepth: number } {
  // Кто из знаков строки «не код»: скобки там считать не должны.
  const skip = new Uint8Array(text.length);
  for (const token of tokens) {
    if (!IGNORED.has(token.type)) continue;
    const from = Math.max(0, token.start);
    const to = Math.min(text.length, token.end);
    for (let i = from; i < to; i += 1) skip[i] = 1;
  }

  const marks: BracketMark[] = [];
  let depth = Math.max(0, startDepth);
  for (let i = 0; i < text.length; i += 1) {
    if (skip[i]) continue;
    const char = text[i]!;
    if (OPENERS.has(char)) {
      marks.push({ start: i, depth });
      depth += 1;
    } else if (CLOSERS.has(char)) {
      depth = Math.max(0, depth - 1);
      marks.push({ start: i, depth });
    }
  }
  return { marks, endDepth: depth };
}

/**
 * Вложенность в начале каждой строки с кэшем и сходимостью, как у подсветки.
 * Текст и токены строки приходят функциями — модуль не знает, откуда они.
 */
export class BracketDepth {
  /** `states[i]` — вложенность в начале строки `i`. Значения ниже `frontier` верны. */
  private states: number[] = [0];
  /** Скобки строки — по ним рисуется радуга; у прошедших строк уже посчитаны. */
  private marks: Array<BracketMark[] | null> = [];
  private frontier = 0;
  private knownEnd = 0;

  constructor(
    private readonly getLine: (line: number) => string,
    private readonly getTokens: (line: number) => readonly Token[],
  ) {}

  /** Забыть всё: новый документ или смена языка (пропуск строк зависит от разбора). */
  reset(): void {
    this.states = [0];
    this.marks = [];
    this.frontier = 0;
    this.knownEnd = 0;
  }

  /** Текст изменился начиная со строки `fromLine` (с нуля). `structural` — сдвинулись строки. */
  invalidate(fromLine: number, structural = false): void {
    const from = Math.max(0, fromLine);
    if (structural) {
      for (let line = from; line < this.marks.length; line += 1) this.marks[line] = null;
      if (this.states.length > from + 1) this.states.length = from + 1;
      this.knownEnd = Math.min(this.knownEnd, from);
    }
    if (from < this.frontier) this.frontier = from;
  }

  /** Скобки строки с уровнем. Считает по пути всё, что ещё не посчитано. */
  marksFor(line: number): readonly BracketMark[] {
    this.ensure(line);
    return this.marks[line] ?? [];
  }

  private ensure(line: number): void {
    while (this.frontier <= line) {
      const index = this.frontier;
      const result = bracketMarks(this.getLine(index), this.states[index] ?? 0, this.getTokens(index));
      // Догадка о вложенности следующей строки — до того, как перезапишем её.
      const guess = this.states[index + 1];
      this.marks[index] = result.marks;
      this.states[index + 1] = result.endDepth;
      this.frontier = index + 1;

      // Уровень сошёлся — ниже посчитается как раньше; возвращаемся к краю кэша.
      if (guess !== undefined && guess === result.endDepth && this.frontier <= this.knownEnd) {
        this.frontier = this.knownEnd;
        break;
      }
    }
    if (this.frontier > this.knownEnd) this.knownEnd = this.frontier;
  }
}
