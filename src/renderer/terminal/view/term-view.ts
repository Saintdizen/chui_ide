/**
 * Вид своего терминала: сетку ячеек из модели (`core/screen.ts`) рисуем DOM-слоями —
 * так же, как устроен редактор (`editor/view/editor-view.ts`). Отсюда и «единый вид»:
 * шрифт, кегль, лигатуры и ширина клетки берутся теми же средствами, что у кода
 * (`editor/view/glyph-metrics`), поэтому строка консоли и строка файла совпадают по
 * пикселю, а `=>` и `->` выглядят одинаково в обоих местах.
 *
 * Рисуем только видимые строки плюс запас: полную высоту имитирует распорка, а не
 * настоящие узлы — иначе длинная история съела бы память (та же арифметика окна, что
 * в редакторе, `editor/view/viewport`).
 *
 * Цвет знака приходит из модели ролью; вид подставляет его либо переменной темы
 * (базовые 16 цветов), либо точным значением (`view/palette.ts`). Цветов в разметке
 * нет: `--own-term-*` задаёт тема, а точные оттенки 256-палитры и RGB одинаковы в
 * обеих схемах.
 */

import { TERMINAL_THEME } from '../../core/theme';
import { measureFont, type GlyphMetrics } from '../../editor/view/glyph-metrics';
import { visibleLines } from '../../editor/view/viewport';
import type { Attr } from '../core/attrs';
import type { Line, Terminal as TermModel } from '../core/screen';
import {
  isEmptySelection,
  normalizeSelection,
  selectionText,
  type SelectionPoint,
  type SelectionRange,
} from '../core/selection';
import type { MouseAction, MouseButton, MouseEventData } from '../input/keys';
import { cellRange, type TermMatch } from '../core/search';
import { colorToCss, type TerminalPalette } from './palette';

/** Класс корня и его частей — за него цепляется оформление (`styles/terminal.css`). */
const ROOT_CLASS = 'own-term';

/** Сколько строк держим за краями экрана: небольшой запас, чтобы прокрутка не мигала. */
const OVERSCAN = 3;

export interface TermViewOptions {
  /** Включать ли лигатуры шрифта — то же правило, что у редактора (настройка общая). */
  ligatures?: boolean;
  /**
   * Событие мыши на полотне. Вид только определяет клетку и кнопку, а решение «отдать
   * программе или выделять текст» принимает вызывающая сторона: она знает режим мыши.
   */
  onMouse?: (event: MouseEventData) => void;
  /** Сменилось выделение: наружу уходит текст (или null, если выделения нет). */
  onSelectionChange?: (text: string | null) => void;
  /** Клик по гиперссылке (OSC 8): адрес открывает вызывающая сторона. */
  onLink?: (url: string) => void;
}

/**
 * Представление терминала. Живёт рядом с моделью: модель разбирает вывод, вид рисует
 * её строки. `render` вызывается на каждый кадр вывода — вызывающая сторона решает,
 * как часто (обычно после `write`).
 */
export class TermView {
  readonly element: HTMLElement;
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly rowsLayer: HTMLElement;
  private readonly selectionLayer: HTMLElement;
  private readonly searchLayer: HTMLElement;
  private readonly cursor: HTMLElement;
  private metrics: GlyphMetrics;
  private ligatures: boolean;
  private focused = false;
  private disposed = false;
  /** Текущее выделение — в координатах всей ленты (история и экран вместе). */
  private selection: SelectionRange | null = null;
  /** Идёт протяжка мышью от нажатия. */
  private selecting = false;
  /** За протяжку выделили текст: клик по ссылке тогда не открываем. */
  private dragged = false;
  /** Найденные поиском совпадения и номер текущего (-1 — ни одного). */
  private searchMatches: readonly TermMatch[] = [];
  private searchCurrent = -1;

  constructor(
    host: HTMLElement,
    private readonly term: TermModel,
    private readonly options: TermViewOptions,
  ) {
    this.ligatures = options.ligatures ?? false;

    this.root = document.createElement('div');
    this.root.className = ROOT_CLASS;
    this.root.tabIndex = 0;
    this.element = this.root;

    this.viewport = document.createElement('div');
    this.viewport.className = `${ROOT_CLASS}-viewport`;
    this.content = document.createElement('div');
    this.content.className = `${ROOT_CLASS}-content`;
    this.rowsLayer = document.createElement('div');
    this.rowsLayer.className = `${ROOT_CLASS}-rows`;
    this.selectionLayer = document.createElement('div');
    this.selectionLayer.className = `${ROOT_CLASS}-selection`;
    this.searchLayer = document.createElement('div');
    this.searchLayer.className = `${ROOT_CLASS}-search`;
    this.cursor = document.createElement('div');
    this.cursor.className = `${ROOT_CLASS}-cursor`;
    // Порядок, снизу вверх: подсветка поиска, выделение, текст, курсор. Текст читается
    // поверх заливок (как в редакторе), а курсор лежит выше всех.
    this.content.append(this.searchLayer, this.selectionLayer, this.rowsLayer, this.cursor);
    this.viewport.append(this.content);
    this.root.append(this.viewport);
    host.append(this.root);

    // Метрики снимаем с самого корня: шрифт и кегль задаёт он, и мерять надо уже
    // вставленный узел — у узла вне DOM вычисленный стиль пуст (как в редакторе).
    this.metrics = this.measure();

    this.applyTheme();
    this.applyLigatures();
    this.applyMetrics();

    this.root.addEventListener('focus', () => {
      this.focused = true;
      this.renderCursor();
    });
    this.root.addEventListener('blur', () => {
      this.focused = false;
      this.renderCursor();
    });
    this.root.addEventListener('mousedown', (event) => this.onMouseDown(event));
    this.root.addEventListener('click', (event) => this.onClick(event));
    this.viewport.addEventListener('scroll', () => this.render());
    // Протяжку ведём на корне (а не на полотне): за краем текста выделение продолжается.
    this.root.addEventListener('mousemove', (event) => this.onMouseMove(event));
    this.root.addEventListener('mouseup', () => this.onMouseUp());
    this.root.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    // Правая кнопка в TUI — действие программы, а не меню браузера.
    this.root.addEventListener('contextmenu', (event) => {
      if (this.term.mouseTracking !== 'none') event.preventDefault();
    });

    if (typeof document.fonts?.ready?.then === 'function') {
      void document.fonts.ready.then(() => {
        if (this.disposed) return;
        this.metrics = this.measure();
        this.applyMetrics();
        this.render();
      });
    }

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.render()) : null;
    observer?.observe(this.viewport);
    this.render();
  }

  /** Рисунок на кадр: строки и курсор. */
  render(): void {
    if (this.disposed) return;
    const lineHeight = this.metrics.lineHeight;
    const total = this.totalRows();
    const viewportHeight = this.viewport.clientHeight;
    this.content.style.height = `${Math.max(1, total) * lineHeight}px`;

    const { first, last } = visibleLines(this.viewport.scrollTop, lineHeight, viewportHeight, total, OVERSCAN);
    const fragment = document.createDocumentFragment();
    for (let row = first; row <= last; row += 1) {
      const line = this.lineAt(row);
      if (line) fragment.append(this.renderRow(line, row));
    }
    this.rowsLayer.replaceChildren(fragment);
    this.renderCursor();
    this.renderSelection();
    this.renderSearch();
  }

  /** Спуститься к последней строке: обычное состояние, пока человек не отмотал вверх. */
  scrollToBottom(): void {
    this.viewport.scrollTop = this.viewport.scrollHeight;
  }

  /** Прижать прокрутку к низу, если человек не отматывал вверх (smooth-подобие терминала). */
  stickToBottom(): void {
    const nearBottom = this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop;
    if (nearBottom <= this.metrics.lineHeight) this.scrollToBottom();
  }

  /**
   * Подогнать сетку под размер окна и вернуть новый размер в клетках — или null, если
   * контейнер ещё не разложен (размеры нулевые, мерить нечего).
   */
  fit(): { cols: number; rows: number } | null {
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    if (width <= 0 || height <= 0) return null;
    const cols = Math.max(2, Math.floor(width / this.metrics.charWidth));
    const rows = Math.max(1, Math.floor(height / this.metrics.lineHeight));
    return { cols, rows };
  }

  /** Переснять метрики и перерисовать: нужно после смены кегля или догрузки шрифта. */
  remeasure(): void {
    this.metrics = this.measure();
    this.applyMetrics();
    this.render();
  }

  refreshTheme(): void {
    this.applyTheme();
    this.render();
  }

  setLigatures(on: boolean): void {
    if (this.ligatures === on) return;
    this.ligatures = on;
    this.applyLigatures();
  }

  /** Текст выделения (или null, если выделения нет). */
  selectedText(): string | null {
    if (!this.selection) return null;
    const text = selectionText(this.selection, (row) => this.columnsAt(row));
    return text === '' ? null : text;
  }

  /** Есть ли что копировать: нужно, чтобы отличать «копировать выделение» от «всё равно». */
  hasSelection(): boolean {
    return this.selectedText() !== null;
  }

  /** Снять выделение (например, после копирования или нового вывода). */
  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.renderSelection();
    this.options.onSelectionChange?.(null);
  }

  /** Число строк ленты (история + экран): по ним идёт поиск. */
  bufferRows(): number {
    return this.totalRows();
  }

  /** Текст строки ленты — то, по чему ищет поиск (`core/search`). */
  lineText(row: number): string {
    return this.columnsAt(row)?.join('') ?? '';
  }

  /** Показать совпадения поиска. `current` — номер текущего, по нему прокручиваем. */
  showSearch(matches: readonly TermMatch[], current: number): void {
    this.searchMatches = matches;
    this.searchCurrent = current;
    this.scrollToMatch();
    this.renderSearch();
    this.renderCursor();
  }

  /** Снять подсветку поиска вместе с закрытием панели поиска. */
  clearSearch(): void {
    if (this.searchMatches.length === 0 && this.searchCurrent < 0) return;
    this.searchMatches = [];
    this.searchCurrent = -1;
    this.renderSearch();
  }

  /** Прокрутить к текущему совпадению — с запасом, чтобы строка не липла к краю. */
  private scrollToMatch(): void {
    const match = this.searchMatches[this.searchCurrent];
    if (!match) return;
    const top = match.row * this.metrics.lineHeight;
    const height = this.viewport.clientHeight;
    const margin = this.metrics.lineHeight;
    const visible =
      top >= this.viewport.scrollTop + margin &&
      top + this.metrics.lineHeight <= this.viewport.scrollTop + height - margin;
    if (!visible) {
      // Ставим строку в середину: так видно и строки до, и после совпадения.
      this.viewport.scrollTop = Math.max(0, top - height / 2 + this.metrics.lineHeight / 2);
    }
  }

  focus(): void {
    this.root.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.root.remove();
  }

  // ── мышь и выделение ─────────────────────────────────────────────────────────

  /**
   * Нажатие: либо уходит программе (если она просила мышь), либо начинает выделение.
   * Shift — тот же «в обход программы», что в других терминалах: нужен, когда программа
   * заняла мышь, а выделить текст всё равно надо.
   */
  private onMouseDown(event: MouseEvent): void {
    this.focus();
    if (event.button === 2) return; // правая кнопка идёт через contextmenu
    if (this.reportsToProgram(event)) {
      this.reportMouse(event, 'press', buttonOf(event));
      return;
    }
    if (event.button !== 0) return;
    const point = this.cellAt(event);
    this.selecting = true;
    this.dragged = false;
    this.selection = normalizeSelection(point, point);
    this.renderSelection();
    event.preventDefault();
  }

  private onMouseMove(event: MouseEvent): void {
    if (this.selecting && !this.reportsToProgram(event)) {
      const point = this.cellAt(event);
      const anchor = this.selection?.start ?? point;
      if (point.row !== anchor.row || point.col !== anchor.col) this.dragged = true;
      // Точку протяжки держим отдельно от якоря: нормализация сводит их в отрезок.
      this.selection = normalizeSelection(anchor, point);
      this.renderSelection();
      return;
    }
    if (this.reportsToProgram(event)) {
      // Сообщаем о движении только в тех режимах, где программа его ждёт.
      const tracking = this.term.mouseTracking;
      if (tracking === 'move' || (tracking === 'drag' && event.buttons !== 0)) {
        const button = event.buttons !== 0 ? buttonOf(event) : 'none';
        this.reportMouse(event, 'move', button);
      }
    }
  }

  private onMouseUp(): void {
    if (this.selecting) {
      this.selecting = false;
      this.options.onSelectionChange?.(this.selectedText());
    }
  }

  /**
   * Клик по гиперссылке. Открываем только когда текст НЕ выделяли протяжкой: тянуть
   * по ссылке — это обычное выделение, а не «открой её».
   */
  private onClick(event: MouseEvent): void {
    if (this.dragged) return;
    const target = event.target as HTMLElement | null;
    const url = target?.closest<HTMLElement>('[data-url]')?.dataset.url;
    if (!url) return;
    event.preventDefault();
    this.options.onLink?.(url);
  }

  private onWheel(event: WheelEvent): void {
    if (!this.reportsToProgram(event)) return; // без режима — прокрутка страницы обычная
    const button: MouseButton = event.deltaY < 0 ? 'wheelUp' : 'wheelDown';
    this.reportMouse(event, 'press', button);
    event.preventDefault();
  }

  /**
   * Отдать событие мыши наружу. Строка — в координатах ЭКРАНА, а не всей ленты: так
   * его ждёт программа (`SGR`-координаты считаются от левого верхнего угла видимой
   * области). Столбец берём из клетки, уже ограниченной размером сетки.
   */
  private reportMouse(event: MouseEvent | WheelEvent, action: MouseAction, button: MouseButton): void {
    const handler = this.options.onMouse;
    if (!handler) return;
    const cell = this.cellAt(event);
    const row = cell.row - this.historyRows();
    handler({
      action,
      button,
      col: cell.col,
      row: Math.max(0, Math.min(this.term.rows - 1, row)),
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
    });
  }

  /** Идёт ли событие программе: она просила мышь и человек не нажал Shift (тот — «выделять»). */
  private reportsToProgram(event: MouseEvent | WheelEvent): boolean {
    return this.term.mouseTracking !== 'none' && !event.shiftKey;
  }

  /** Клетка под указателем: столбец и строка в координатах всей ленты (с учётом сдвига). */
  private cellAt(event: MouseEvent | WheelEvent): SelectionPoint {
    const rect = this.viewport.getBoundingClientRect();
    const x = event.clientX - rect.left + this.viewport.scrollLeft;
    const y = event.clientY - rect.top + this.viewport.scrollTop;
    const col = Math.max(0, Math.min(this.term.cols - 1, Math.floor(x / this.metrics.charWidth)));
    const row = Math.max(0, Math.min(this.totalRows() - 1, Math.floor(y / this.metrics.lineHeight)));
    return { col, row };
  }

  /** Столбцы строки: по записи на клетку, вторая половина широкого знака — пустая строка. */
  private columnsAt(row: number): readonly string[] | undefined {
    return this.lineAt(row)?.cells.map((cell) => cell.chars);
  }

  /** Заливка выделения: прямоугольники на видимых строках, пересечённые с отрезком. */
  private renderSelection(): void {
    const range = this.selection;
    if (!range || isEmptySelection(range)) {
      if (this.selectionLayer.childElementCount > 0) this.selectionLayer.replaceChildren();
      return;
    }
    const lineHeight = this.metrics.lineHeight;
    const charWidth = this.metrics.charWidth;
    const total = this.totalRows();
    const { first, last } = visibleLines(
      this.viewport.scrollTop,
      lineHeight,
      this.viewport.clientHeight,
      total,
      OVERSCAN,
    );
    const fragment = document.createDocumentFragment();
    for (let row = first; row <= last; row += 1) {
      if (row < range.start.row || row > range.end.row) continue;
      const from = row === range.start.row ? range.start.col : 0;
      const to = row === range.end.row ? range.end.col : this.term.cols - 1;
      if (to < from) continue;
      const rect = document.createElement('div');
      rect.className = `${ROOT_CLASS}-selection-rect`;
      rect.style.transform = `translate(${from * charWidth}px, ${row * lineHeight}px)`;
      rect.style.width = `${(to - from + 1) * charWidth}px`;
      rect.style.height = `${lineHeight}px`;
      fragment.append(rect);
    }
    this.selectionLayer.replaceChildren(fragment);
  }

  /** Подсветка совпадений поиска: прямоугольники на видимых строках. */
  private renderSearch(): void {
    if (this.searchMatches.length === 0) {
      if (this.searchLayer.childElementCount > 0) this.searchLayer.replaceChildren();
      return;
    }
    const lineHeight = this.metrics.lineHeight;
    const charWidth = this.metrics.charWidth;
    const total = this.totalRows();
    const { first, last } = visibleLines(
      this.viewport.scrollTop,
      lineHeight,
      this.viewport.clientHeight,
      total,
      OVERSCAN,
    );
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < this.searchMatches.length; index += 1) {
      const match = this.searchMatches[index]!;
      if (match.row < first || match.row > last) continue;
      const chars = this.columnsAt(match.row);
      if (!chars) continue;
      const range = cellRange(chars, match.start, match.end);
      const rect = document.createElement('div');
      rect.className = `${ROOT_CLASS}-search-rect${index === this.searchCurrent ? ' is-current' : ''}`;
      rect.style.transform = `translate(${range.from * charWidth}px, ${match.row * lineHeight}px)`;
      rect.style.width = `${(range.to - range.from + 1) * charWidth}px`;
      rect.style.height = `${lineHeight}px`;
      fragment.append(rect);
    }
    this.searchLayer.replaceChildren(fragment);
  }

  // ── построение DOM ──────────────────────────────────────────────────────────

  private renderRow(line: Line, row: number): HTMLElement {
    const element = document.createElement('div');
    element.className = `${ROOT_CLASS}-row`;
    element.style.transform = `translateY(${row * this.metrics.lineHeight}px)`;

    // Ячейки одной строки собираем в «прогоны» с одинаковым атрибутом и ссылкой: цвет,
    // начертание и адрес задаются на группу, а не на каждую букву — узлов меньше.
    let runAttr: Attr | null = null;
    let runLink: string | undefined;
    let runText = '';
    const flush = (): void => {
      if (runAttr === null || runText === '') return;
      element.append(this.renderRun(runText, runAttr, runLink));
      runAttr = null;
      runLink = undefined;
      runText = '';
    };
    for (const cell of line.cells) {
      if (cell.width === 0) continue; // вторая половина широкого знака — без своего текста
      if (runAttr === null || !sameAttr(runAttr, cell.attr) || runLink !== cell.link) {
        flush();
        runAttr = cell.attr;
        runLink = cell.link;
      }
      runText += cell.chars;
    }
    flush();
    return element;
  }

  private renderRun(text: string, attr: Attr, link?: string): HTMLElement {
    const span = document.createElement('span');
    span.textContent = text;
    // Гиперссылка (OSC 8): адрес кладём в данные, а вид у клика берёт его оттуда.
    // Схему не проверяем — это делает main (shell.openExternal пускает только http/https).
    if (link) {
      span.dataset.url = link;
      span.classList.add('is-link');
    }

    let fg = colorToCss(attr.fg);
    let bg = colorToCss(attr.bg);
    // Обратные цвета меняют местами текст и фон: чего нет — берём у корня переменной.
    if (attr.inverse) {
      const nextFg = bg ?? 'var(--own-term-bg)';
      const nextBg = fg ?? 'var(--own-term-fg)';
      fg = nextFg;
      bg = nextBg;
    }
    if (fg) span.style.color = fg;
    if (bg) span.style.background = bg;

    if (attr.bold) span.classList.add('is-bold');
    if (attr.dim) span.classList.add('is-dim');
    if (attr.italic) span.classList.add('is-italic');
    if (attr.underline) span.classList.add('is-underline');
    if (attr.blink) span.classList.add('is-blink');
    if (attr.strike) span.classList.add('is-strike');
    if (attr.invisible) span.classList.add('is-invisible');
    return span;
  }

  private renderCursor(): void {
    const visible = this.term.cursorVisible && this.focused;
    this.cursor.classList.toggle('is-hidden', !visible);
    if (!visible) return;

    const row = this.historyRows() + this.term.cursor.y;
    const col = this.term.cursor.x;
    this.cursor.style.transform = `translate(${col * this.metrics.charWidth}px, ${row * this.metrics.lineHeight}px)`;
    this.cursor.style.width = `${this.metrics.charWidth}px`;
    this.cursor.style.height = `${this.metrics.lineHeight}px`;
  }

  // ── сопоставление строк и метрик ─────────────────────────────────────────────

  private historyRows(): number {
    return this.term.alternate ? 0 : this.term.history().length;
  }

  private totalRows(): number {
    return this.historyRows() + this.term.rows;
  }

  private lineAt(row: number): Line | undefined {
    const history = this.historyRows();
    if (row < history) return this.term.history()[row];
    return this.term.line(row - history);
  }

  private measure(): GlyphMetrics {
    const style = window.getComputedStyle(this.root);
    const fontSize = Number.parseFloat(style.fontSize) || 13;
    const declared = Number.parseFloat(style.lineHeight);
    const lineHeight = Math.round(declared || fontSize * 1.4);
    return measureFont(this.root, fontSize, lineHeight, 8);
  }

  private applyMetrics(): void {
    this.root.style.setProperty('--own-term-line-height', `${this.metrics.lineHeight}px`);
    this.root.style.setProperty('--own-term-char-width', `${this.metrics.charWidth}px`);
  }

  private applyLigatures(): void {
    this.root.classList.toggle('is-ligatures', this.ligatures);
  }

  /**
   * Цвета консоли — переменными на корне. Базовые шестнадцать цветов берём из палитры
   * темы (`core/theme.ts`) — единый источник цвета консоли. Фон совпадает с полотном
   * редактора.
   */
  private applyTheme(): void {
    const palette = paletteFor();
    for (let i = 0; i < 16; i += 1) {
      this.root.style.setProperty(`--own-term-c${i}`, palette.ansi[i] ?? '#000000');
    }
    this.root.style.setProperty('--own-term-fg', palette.foreground);
    this.root.style.setProperty('--own-term-bg', palette.background);
    this.root.style.setProperty('--own-term-cursor', palette.cursor);
    this.root.style.setProperty('--own-term-selection', palette.selection);
    this.root.style.setProperty('--own-term-search', palette.search);
    this.root.style.setProperty('--own-term-search-current', palette.searchCurrent);
  }
}

/** Какая кнопка зажата по битовой маске `MouseEvent.buttons` (1 левая, 2 правая, 4 средняя). */
function buttonOf(event: MouseEvent): MouseButton {
  if (event.buttons & 1) return 'left';
  if (event.buttons & 4) return 'middle';
  if (event.buttons & 2) return 'right';
  return 'none';
}

/** Совпадают ли атрибуты ячеек: по ним ячейки склеиваются в один прогон. */
function sameAttr(a: Attr, b: Attr): boolean {
  return (
    a === b ||
    (a.bold === b.bold &&
      a.dim === b.dim &&
      a.italic === b.italic &&
      a.underline === b.underline &&
      a.blink === b.blink &&
      a.inverse === b.inverse &&
      a.invisible === b.invisible &&
      a.strike === b.strike &&
      a.fg === b.fg &&
      a.bg === b.bg)
  );
}

/**
 * Палитра консоли: источник — `TERMINAL_THEME` (`core/theme.ts`). Цвета приходят
 * типом `TerminalTheme` со всеми обязательными полями, но подстановки ниже оставлены
 * как страховка: вид не должен остаться без значения переменной.
 */
export function paletteFor(): TerminalPalette {
  const theme = TERMINAL_THEME;
  const white = theme.white ?? '#ffffff';
  return {
    ansi: [
      theme.black ?? '#000000',
      theme.red ?? '#cd3131',
      theme.green ?? '#0dbc79',
      theme.yellow ?? '#e5e510',
      theme.blue ?? '#2472c8',
      theme.magenta ?? '#bc3fbc',
      theme.cyan ?? '#11a8cd',
      white,
      theme.brightBlack ?? '#666666',
      theme.brightRed ?? '#f14c4c',
      theme.brightGreen ?? '#23d18b',
      theme.brightYellow ?? '#f5f543',
      theme.brightBlue ?? '#3b8eea',
      theme.brightMagenta ?? '#d670d6',
      theme.brightCyan ?? '#29b8db',
      theme.brightWhite ?? white,
    ],
    background: theme.background ?? '#1e1e1e',
    foreground: theme.foreground ?? '#d4d4d4',
    cursor: theme.cursor ?? '#d4d4d4',
    selection: theme.selectionBackground ?? '#264f78',
    // Подсветка поиска одинакова в обеих схемах: она должна бросаться в глаза, но не
    // закрывать буквы — это полупрозрачные плашки над текстом.
    search: 'rgba(255, 205, 60, 0.35)',
    searchCurrent: 'rgba(255, 140, 0, 0.65)',
  };
}
