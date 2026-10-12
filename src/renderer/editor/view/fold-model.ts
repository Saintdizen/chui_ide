/**
 * Свёрнутые строки: какие строки скрыты и как из строк получаются ряды экрана.
 *
 * Экран рисует РЯДЫ (одна видимая строка — один ряд), а текст живёт СТРОКАМИ
 * буфера. Пока ничего не свёрнуто, это одно и то же, и представление пользовалось
 * номерами строк напрямую. Свёртка ломает это равенство: скрытые строки ряда не
 * занимают, поэтому любому месту, которое считает «строка → y» или «y → строка»,
 * нужен перевод. Он весь здесь и в одном виде: `rowOf` (строка → ряд) и
 * `lineAtRow` (ряд → строка).
 *
 * Модель чистая и знает только номера строк, поэтому её видно в тестах без окна.
 */

import type { FoldRange } from '../../../shared/fold-ranges';

export class FoldModel {
  /** Все известные диапазоны свёртки (от языкового сервера или по отступам). */
  private ranges: readonly FoldRange[] = [];
  /** Начала схлопнутых блоков: только они и решают, что скрыто. */
  private readonly collapsed = new Set<number>();

  /** Новый файл: диапазоны и схлопнутое состояние прошлого к нему не относятся. */
  reset(): void {
    this.ranges = [];
    this.collapsed.clear();
  }

  /**
   * Заменить набор диапазонов. Схлопнутое состояние СОХРАНЯЕМ: правка файла
   * пересобирает диапазоны, но раскрывать то, что человек сложил, из-за неё нельзя.
   * Схлопнутые блоки, которых больше нет, забываем.
   */
  setRanges(ranges: readonly FoldRange[]): void {
    this.ranges = ranges;
    const starts = new Set(ranges.map((range) => range.startLine));
    for (const start of [...this.collapsed]) if (!starts.has(start)) this.collapsed.delete(start);
  }

  get all(): readonly FoldRange[] {
    return this.ranges;
  }

  /** Свёрнут ли блок, начинающийся на этой строке. */
  isCollapsed(startLine: number): boolean {
    return this.collapsed.has(startLine);
  }

  /** Сложить или раскрыть блок. `true` — он теперь свёрнут. */
  toggle(startLine: number): boolean {
    if (this.collapsed.has(startLine)) {
      this.collapsed.delete(startLine);
      return false;
    }
    this.collapsed.add(startLine);
    return true;
  }

  /** Сложить всё, что можно. Вложенное складывать незачем: оно и так скрыто. */
  collapseAll(): void {
    for (const range of this.ranges) this.collapsed.add(range.startLine);
  }

  /** Раскрыть всё. */
  expandAll(): void {
    this.collapsed.clear();
  }

  /** Скрыта ли строка (она внутри свёрнутого блока, но не первая в нём). */
  isHidden(line: number): boolean {
    return this.hiddenBefore(line + 1) !== this.hiddenBefore(line);
  }

  /** Сколько строк скрыто ДО этой строки — на столько рядов она поднялась. */
  hiddenLinesBefore(line: number): number {
    return this.hiddenBefore(line);
  }

  /**
   * Блок, который сворачивает строка: начинающийся на ней (самый длинный), а если
   * такого нет — самый внутренний из вмещающих её. По этому работает Ctrl+Shift+[.
   */
  regionAt(line: number): FoldRange | null {
    const starting = this.ranges.filter((range) => range.startLine === line);
    if (starting.length > 0)
      return starting.reduce((longest, range) => (range.endLine > longest.endLine ? range : longest));
    const containing = this.ranges.filter((range) => range.startLine < line && range.endLine >= line);
    if (containing.length === 0) return null;
    // Вмещающих может быть несколько (вложенные блоки): берём тот, что начинается ниже.
    return containing.reduce((inner, range) => (range.startLine > inner.startLine ? range : inner));
  }

  /** Самый внутренний СХЛОПНУТЫЙ блок, вмещающий строку: его и раскрывает Ctrl+Shift+]. */
  collapsedAt(line: number): FoldRange | null {
    if (this.collapsed.has(line)) return this.ranges.find((range) => range.startLine === line) ?? null;
    const inside = this.hiddenRegions().filter((range) => range.startLine < line && range.endLine >= line);
    if (inside.length === 0) return null;
    return inside.reduce((inner, range) => (range.startLine > inner.startLine ? range : inner));
  }

  /**
   * Ряд строки (с нуля) — по нему считается её место на экране. Строка внутри
   * свёрнутого блока получает ряд первой строки блока: рисовать такие всё равно
   * не надо, а арифметика остаётся определённой.
   */
  rowOf(line: number): number {
    return Math.max(0, line - 1 - this.hiddenBefore(line));
  }

  /** Строка, которой принадлежит ряд (с нуля). */
  lineAtRow(row: number): number {
    let line = Math.max(0, row) + 1;
    for (const range of this.hiddenRegions()) {
      // Строка стоит после начала блока — значит, часть её ряда «съедена» скрытыми.
      if (line > range.startLine) line += range.endLine - range.startLine;
    }
    return line;
  }

  /** Сколько рядов занимает документ из `lineCount` строк. */
  rowCount(lineCount: number): number {
    return Math.max(1, lineCount - this.hiddenTotal());
  }

  /** Начала схлопнутых блоков — по ним рисуются стрелки в жёлобе. */
  collapsedStarts(): number[] {
    return [...this.collapsed].sort((a, b) => a - b);
  }

  /**
   * Скрытые блоки, которые действительно скрывают строки: вложенные в другой
   * схлопнутый блок не считаем — их строки уже посчитаны внешним.
   */
  private hiddenRegions(): FoldRange[] {
    const regions = this.ranges.filter((range) => this.collapsed.has(range.startLine));
    return regions.filter(
      (range) =>
        !regions.some(
          (other) => other !== range && other.startLine < range.startLine && other.endLine >= range.endLine,
        ),
    );
  }

  /** Сколько строк скрыто ДО строки `line` (включительно с её началом). */
  private hiddenBefore(line: number): number {
    let hidden = 0;
    for (const range of this.hiddenRegions()) {
      // Скрыты строки `startLine + 1 … endLine`; считаем те, что до `line`.
      hidden += Math.max(0, Math.min(line - 1, range.endLine) - range.startLine);
    }
    return hidden;
  }

  /** Сколько строк скрыто всего. */
  private hiddenTotal(): number {
    let hidden = 0;
    for (const range of this.hiddenRegions()) hidden += range.endLine - range.startLine;
    return hidden;
  }
}
