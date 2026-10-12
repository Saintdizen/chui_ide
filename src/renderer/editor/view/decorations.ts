/**
 * Украшения строк: полоски изменений, значки, фон строки, подписи и подчёркивания.
 *
 * В Monaco всё это рисовалось «декорациями» модели (`deltaDecorations`): строка +
 * класс оформления + подсказка. У своего редактора тот же набор, но без чужой модели —
 * здесь лежит только ОПИСАНИЕ украшений и их хранение. Ни DOM, ни раскладки: как это
 * выглядит на экране, решает представление, а какие украшения есть — решает хозяин
 * редактора (в приложении — по данным git, отладки, покрытия и языкового сервера).
 *
 * Разделение по видам не косметическое, а по геометрии. Каждое украшение относится к
 * одной из пяти областей строки, и от этого зависит, что вообще надо считать:
 *
 *   • `glyph` — значок на поле слева от номеров (точки останова, запуск, тесты). Ему
 *     довольно строки: место в поле задаётся слоем, а не координатой;
 *   • `strip` — узкая черта в полосе украшений справа от номеров (изменения git). Тоже
 *     строка и класс, без координат;
 *   • `lineBackground` — заливка всей строки (покрытие, строка отладчика). Тянется на
 *     ширину полотна, а не строки;
 *   • `after` — текст ПОСЛЕ конца строки (подпись blame): он не трогает содержимое файла,
 *     но и в раскладку самого кода не входит;
 *   • `squiggly` — волнистое подчёркивание под участком строки (пометки языка). Вот ему
 *     уже нужны столбцы, и его геометрия считается здесь: волнистая линия идёт под
 *     знаками участка, а не под всей строкой.
 *
 * Поэтому хранение — словари «строка → украшение» для тех видов, где строка одна, и
 * «строка → список» для подчёркиваний: под строкой бывает несколько пометок сразу.
 * Поиск по строке — из словаря, а не перебором: представление спрашивает про каждую
 * видимую строку каждый кадр, и перебор списка файла тут был бы квадратом.
 */

import type { GlyphMetrics } from './glyph-metrics';
import { xForColumn } from './line-layout';

/** Значок на поле значков слева от номеров строк. Класс — глобальный (`main.css`). */
export interface GlyphDecoration {
  /** Строка с единицы. */
  readonly line: number;
  /** Классы значка: `run-glyph`, `breakpoint-glyph is-log` и подобные. */
  readonly className: string;
  /** Всплывающая подсказка браузера (`.title`). */
  readonly tooltip?: string;
}

/** Полоска в полосе украшений справа от номеров: `change-gutter is-added`. */
export interface StripDecoration {
  readonly line: number;
  readonly className: string;
  readonly tooltip?: string;
}

/** Заливка всей строки: класс берётся глобальный (`coverage-line`, `debug-line`). */
export interface LineBackgroundDecoration {
  readonly line: number;
  readonly className: string;
}

/** Текст после конца строки — подпись blame (`blame-inline`). */
export interface AfterDecoration {
  readonly line: number;
  readonly content: string;
  readonly className: string;
}

/**
 * Код-линза: кликабельная подпись у строки (от языкового сервера). Ставится ПОСЛЕ
 * текста строки, до подписи blame: она не часть файла и в раскладку кода не входит.
 * Клик по ней представление отдаёт хозяину — тот решает, что исполнить.
 */
export interface LensDecoration {
  readonly line: number;
  readonly content: string;
  readonly className: string;
  readonly tooltip?: string;
}

/**
 * Волнистое подчёркивание под участком строки. Столбцы — как у правок LSP: начало
 * включительно, конец исключительно, оба с единицы.
 */
export interface SquigglyDecoration {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  /** Класс серьёзности (`is-error`, `is-warning`, `is-info`). */
  readonly className: string;
}

/** Прямоугольник украшения в координатах полотна: слева и сверху — от начала документа. */
export interface DecorationRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Украшения одного файла. Собираются заново при каждом изменении набора (новые
 * данные git, шаг отладки, прогон тестов) — так же, как это делали декорации Monaco:
 * снять прежние и поставить текущие.
 */
export class FileDecorations {
  private glyphs = new Map<number, GlyphDecoration>();
  private strips = new Map<number, StripDecoration>();
  private backgrounds = new Map<number, LineBackgroundDecoration>();
  private afters = new Map<number, AfterDecoration>();
  private lenses = new Map<number, LensDecoration>();
  private squiggles = new Map<number, SquigglyDecoration[]>();

  setGlyphs(items: readonly GlyphDecoration[]): void {
    this.glyphs = indexByLine(items);
  }

  setStrips(items: readonly StripDecoration[]): void {
    this.strips = indexByLine(items);
  }

  setLineBackgrounds(items: readonly LineBackgroundDecoration[]): void {
    this.backgrounds = indexByLine(items);
  }

  setAfterContents(items: readonly AfterDecoration[]): void {
    this.afters = indexByLine(items);
  }

  setLenses(items: readonly LensDecoration[]): void {
    this.lenses = indexByLine(items);
  }

  setSquiggles(items: readonly SquigglyDecoration[]): void {
    const grouped = new Map<number, SquigglyDecoration[]>();
    for (const item of items) {
      const list = grouped.get(item.line);
      if (list) list.push(item);
      else grouped.set(item.line, [item]);
    }
    this.squiggles = grouped;
  }

  glyphFor(line: number): GlyphDecoration | undefined {
    return this.glyphs.get(line);
  }

  stripFor(line: number): StripDecoration | undefined {
    return this.strips.get(line);
  }

  backgroundFor(line: number): LineBackgroundDecoration | undefined {
    return this.backgrounds.get(line);
  }

  afterFor(line: number): AfterDecoration | undefined {
    return this.afters.get(line);
  }

  lensFor(line: number): LensDecoration | undefined {
    return this.lenses.get(line);
  }

  squigglesFor(line: number): readonly SquigglyDecoration[] {
    return this.squiggles.get(line) ?? EMPTY_SQUIGGLES;
  }

  /** Есть ли хоть что-то: пустые украшения представление рисует не заходя в слои. */
  get isEmpty(): boolean {
    return (
      this.glyphs.size === 0 &&
      this.strips.size === 0 &&
      this.backgrounds.size === 0 &&
      this.afters.size === 0 &&
      this.lenses.size === 0 &&
      this.squiggles.size === 0
    );
  }
}

const EMPTY_SQUIGGLES: readonly SquigglyDecoration[] = [];

/** Разложить список украшений по строкам. Одно украшение на строку — так и рисуем. */
function indexByLine<T extends { line: number }>(items: readonly T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const item of items) map.set(item.line, item);
  return map;
}

/**
 * Прямоугольник волнистого подчёркивания. `startColumn` и `endColumn` — те же, что у
 * правок LSP: начало включительно, конец исключительно, с единицы. Пустой участок
 * (`endColumn <= startColumn`) даёт нулевую ширину — рисовать нечего.
 *
 * `offsets` — раскладка строки по x (см. `line-layout.ts`): её считает представление
 * и переиспользует, чтобы не раскладывать строку второй раз ради подчёркивания.
 */
export function squigglyRect(
  offsets: readonly number[],
  line: number,
  startColumn: number,
  endColumn: number,
  metrics: GlyphMetrics,
): DecorationRect {
  const left = xForColumn(offsets, startColumn - 1);
  const right = Math.max(left, xForColumn(offsets, endColumn - 1));
  return {
    left,
    top: (line - 1) * metrics.lineHeight,
    width: right - left,
    height: metrics.lineHeight,
  };
}
