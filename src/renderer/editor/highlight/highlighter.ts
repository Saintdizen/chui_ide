/**
 * Подсветка с памятью: разбираем строку один раз и помним результат.
 *
 * Разбор строки дёшев, но не бесплатен, а спрашивают токены на каждую отрисовку —
 * то есть на каждое движение курсора и на каждую прокрутку. Переразбирать сорок
 * видимых строк каждый кадр незачем: пока текст строки не менялся, её токены те же.
 * Поэтому здесь кэш по строкам вместе с состоянием, в котором строка начинается.
 *
 * Ключевая мысль — СОСТОЯНИЕ строки. Если правка не изменила состояние на выходе,
 * то и все строки ниже разберутся ровно как раньше, и пересчитывать их не нужно.
 * Отсюда и правило «правка в начале файла не переразбирает файл целиком»: пока
 * правка не открыла блочный комментарий (или другую многострочную конструкцию),
 * состояние сходится на первой же строке, и подсветка останавливается.
 *
 * Отдельная тонкость — правка, меняющая ЧИСЛО строк (вставили перевод строки).
 * Тогда все строки ниже сдвинулись, и их старые токены описывают уже другой текст.
 * Такая правка помечается как структурная: догадки о следующих строках выбрасываются,
 * и сходиться состоянию уже не с чем — разбор идёт от места правки.
 *
 * Модуль чистый: он не знает ни о DOM, ни о модели текста — текст строки приходит
 * функцией. Поэтому его видно в тестах без окна.
 */

import { ST_NORMAL, type Grammar } from './grammar';
import type { Token } from './tokens';

/** Пустой результат: одна и та же ссылка, чтобы не создавать массив на каждую строку. */
const NO_TOKENS: readonly Token[] = [];

export class LineHighlighter {
  private grammar: Grammar | null;
  /**
   * Текст строки по её номеру с нуля. Функция, а не буфер: подсветке не нужно знать,
   * откуда берётся текст, — в приложении это модель, в тестах массив строк.
   */
  private readonly getLine: (line: number) => string;
  /** `states[i]` — состояние в начале строки `i`. Значения ниже `frontier` верны. */
  private states: number[] = [ST_NORMAL];
  private tokens: Array<Token[] | null> = [];
  /** Строк с верными токенами — префикс документа. */
  private frontier = 0;
  /**
   * Наивысшая строка, для которой вообще есть догадки (токены и состояния).
   * Служит целью, к которой можно вернуться, если состояние сошлось.
   */
  private knownEnd = 0;

  constructor(grammar: Grammar | null, getLine: (line: number) => string) {
    this.grammar = grammar;
    this.getLine = getLine;
  }

  /** Есть ли для этого языка подсветка. */
  get active(): boolean {
    return this.grammar !== null;
  }

  /** Идентификатор языка или `null`, если подсветки нет. */
  get language(): string | null {
    return this.grammar?.id ?? null;
  }

  /** Сменить язык. Разбор начинается заново: состояния прежней грамматики не годятся. */
  setGrammar(grammar: Grammar | null): void {
    if (this.grammar?.id === grammar?.id) return;
    this.grammar = grammar;
    this.reset();
  }

  /** Забыть всё: новый документ или смена языка. */
  reset(): void {
    this.states = [ST_NORMAL];
    this.tokens = [];
    this.frontier = 0;
    this.knownEnd = 0;
  }

  /**
   * Текст изменился начиная со строки `fromLine` (с нуля). `structural` — правка
   * изменила число строк: тогда догадки о строках ниже недействительны.
   */
  invalidate(fromLine: number, structural = false): void {
    const from = Math.max(0, fromLine);
    if (structural) {
      // Строки ниже сдвинулись: их токены — о другом тексте, выбрасываем.
      for (let line = from; line < this.tokens.length; line += 1) this.tokens[line] = null;
      if (this.states.length > from + 1) this.states.length = from + 1;
      this.knownEnd = Math.min(this.knownEnd, from);
    }
    if (from < this.frontier) this.frontier = from;
  }

  /** Токены строки. Разбирает строку и то, что перед ней, если ещё не разобрано. */
  tokensFor(line: number): readonly Token[] {
    if (!this.grammar) return NO_TOKENS;
    this.ensure(line);
    return this.tokens[line] ?? NO_TOKENS;
  }

  /** Довести разбор до строки `line` включительно. */
  private ensure(line: number): void {
    const grammar = this.grammar;
    if (!grammar) return;

    while (this.frontier <= line) {
      const index = this.frontier;
      const result = grammar.line(this.getLine(index), this.states[index] ?? ST_NORMAL);
      // Догадка о состоянии следующей строки — до того, как перезапишем её.
      const guess = this.states[index + 1];
      this.tokens[index] = result.tokens;
      this.states[index + 1] = result.state;
      this.frontier = index + 1;

      // Состояние сошлось с прежним — значит, ниже всё разберётся как раньше, и
      // догадки остаются верными: возвращаемся к прежнему краю кэша и выходим.
      if (guess !== undefined && guess === result.state && this.frontier <= this.knownEnd) {
        this.frontier = this.knownEnd;
        break;
      }
    }

    if (this.frontier > this.knownEnd) this.knownEnd = this.frontier;
  }
}
