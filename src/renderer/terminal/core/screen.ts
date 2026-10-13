/**
 * Модель экрана терминала: сетка ячеек, курсор, прокрутка и режимы.
 *
 * Парсер (`vt-parse.ts`) отдаёт события — «напечатай это», «перемести курсор»,
 * «задай цвет». Здесь события применяются к экрану: так и получается терминал.
 * Модель чистая — ни DOM, ни шрифта: вид (`view/…`) читает готовые строки и рисует
 * их, замеряя ширину теми же метриками, что и редактор (`editor/view/glyph-metrics`).
 * Поэтому сетка ячеек терминала и каретка редактора совпадают по пикселю.
 *
 * Единица хранения — ЯЧЕЙКА, а не строка: у знака свой цвет и начертание, а широкий
 * знак (иероглиф, эмодзи) занимает две клетки. Ширину знака берём из `cellsOf` —
 * то же правило East Asian Width, что и в редакторе.
 *
 * Доска строк — «лента» фиксированной ширины: печать поверх края переносится на
 * следующую строку, а на нижней строке доска прокручивается вверх. Лишнее уходит в
 * историю (`scrollback`), пока доска — основная, а не альтернативная.
 */

import { cellsOf } from '../../editor/view/glyph-metrics';
import { applySgr, DEFAULT_ATTR, type Attr } from './attrs';
import { VtParser, type CsiEvent, type EscEvent, type VtEvent } from './vt-parse';

/** Сколько строк истории держим: этого хватает, чтобы вернуться к недавнему выводу. */
const SCROLLBACK_LIMIT = 1000;

/** Сколько столбцов отбивает табуляция по умолчанию. */
const TAB_WIDTH = 8;

/** Одна клетка экрана. `chars` — знак вместе с комбинирующими пометками, `width` — 0, 1 или 2. */
export interface Cell {
  readonly chars: string;
  readonly width: number;
  readonly attr: Attr;
}

/** Строка экрана. `wrapped` — строка продолжилась на следующей без перевода (для копирования/переноса). */
export interface Line {
  cells: Cell[];
  wrapped: boolean;
}

interface BufferState {
  lines: Line[];
  /** Столбец курсора (0-based). */
  cx: number;
  /** Строка курсора (0-based). */
  cy: number;
  savedX: number;
  savedY: number;
  savedAttr: Attr;
}

/**
 * Как программа просит сообщать о мыши. Значения — это коды DECSET: чем «шире»
 * режим, тем больше событий программа хочет знать (`?1000` — только нажатия,
 * `?1002` — и перетаскивание с зажатой кнопкой, `?1003` — и просто движение).
 */
export type MouseTracking = 'none' | 'click' | 'drag' | 'move';

interface Modes {
  /** Перенос длинной строки на следующую (DECAWM, `?7`). Выключенный — знаки у края затираются. */
  wraparound: boolean;
  cursorVisible: boolean;
  /** Вставка со сдвигом (IRM, `4`): набранное раздвигает строку, а не затирает. */
  insert: boolean;
  /** Начало отсчёта — верхняя граница области прокрутки (DECOM, `?6`). */
  origin: boolean;
  /** Стрелки и прочие клавиши шлют «прикладные» коды (DECCKM, `?1`). */
  applicationCursorKeys: boolean;
  /** Вставка через `Ctrl+V` обрамляется маркерами (bracketed paste, `?2004`). */
  bracketedPaste: boolean;
  /** Режим мыши (`?9`, `?1000`, `?1002`, `?1003`): `none` — программе мышь не нужна. */
  mouseTracking: MouseTracking;
  /** Форма события мыши с большими координатами (SGR, `?1006`). */
  mouseSgr: boolean;
}

function blankAttrCell(attr: Attr): Cell {
  return { chars: ' ', width: 1, attr };
}

function blankLine(cols: number, attr: Attr): Line {
  const cells: Cell[] = [];
  for (let i = 0; i < cols; i += 1) cells.push(blankAttrCell(attr));
  return { cells, wrapped: false };
}

/**
 * Последняя СОДЕРЖАТЕЛЬНАЯ строка доски (-1 — пусто). Хвостовые пустые строки — это
 * распорка до размера экрана, а не содержимое; при переносе их надо отбросить.
 */
function trailingBlankStart(lines: readonly Line[]): number {
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    const line = lines[row];
    if (!line) continue;
    if (line.wrapped || line.cells.some((cell) => cell.chars !== '' && cell.chars !== ' ')) return row;
  }
  return -1;
}

/** Срезать хвостовые пробелы: при расширении они дали бы лишние пустые ряды. */
function trimTrailingBlank(cells: Cell[]): void {
  while (cells.length > 0) {
    const last = cells[cells.length - 1];
    if (last && last.chars === ' ' && last.width === 1) cells.pop();
    else break;
  }
}

interface WrappedCells {
  readonly rows: Line[];
  /** Номер ряда в `rows`, куда попала отслеживаемая клетка, и её столбец в нём. */
  readonly trackRow: number;
  readonly trackCol: number;
}

/**
 * Разложить плоский список клеток по строкам шириной `cols`.
 *
 * Широкий знак не разрывается: если в строке осталась одна клетка, знак целиком уходит
 * на следующую (в конце предыдущей остаётся пробел). Каждая строка кроме последней
 * помечается `wrapped` — по этой пометке следующий reflow соберёт строки обратно.
 *
 * `trackCell` — индекс клетки, за которой следить (обычно позиция курсора): её новое
 * место вернётся в `trackRow`/`trackCol`. Пересчитать столбец курсора делением нельзя:
 * из-за неразрывных широких знаков строки не всегда полны.
 */
function wrapCells(cells: readonly Cell[], cols: number, trackCell: number | null): WrappedCells {
  const rows: Line[] = [];
  let current = blankLine(cols, DEFAULT_ATTR);
  let col = 0;
  let trackRow = 0;
  let trackCol = 0;
  let lastCol = 0;

  const flush = (wrapped: boolean): void => {
    current.wrapped = wrapped;
    lastCol = col;
    rows.push(current);
    current = blankLine(cols, DEFAULT_ATTR);
    col = 0;
  };

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (!cell || cell.width === 0) continue; // вторую клетку широкого ставим вместе с базой
    // Широкому знаку нужно две клетки — переносим его целиком, если места нет.
    const width = cell.width === 2 && cols >= 2 ? 2 : 1;
    if (col + width > cols && col > 0) flush(true);
    current.cells[col] = cell;
    if (width === 2 && col + 1 < cols) current.cells[col + 1] = { chars: '', width: 0, attr: cell.attr };
    if (trackCell === index) {
      trackRow = rows.length;
      trackCol = col;
    }
    col += width;
  }
  flush(false);

  // Клетка за концом содержимого (курсор на срезанных пробелах): ставим в конец строки.
  if (trackCell !== null && trackCell >= cells.length) {
    trackRow = Math.max(0, rows.length - 1);
    trackCol = Math.max(0, Math.min(lastCol, cols - 1));
  }

  return { rows, trackRow, trackCol };
}

function defaultModes(): Modes {
  return {
    wraparound: true,
    cursorVisible: true,
    insert: false,
    origin: false,
    applicationCursorKeys: false,
    bracketedPaste: false,
    mouseTracking: 'none',
    mouseSgr: false,
  };
}

/**
 * Экран терминала. Создаётся с размером в клетках, дальше живёт потоком: `write`
 * принимает вывод pty, `resize` — новый размер окна, `line` и `scrollback` читает вид.
 */
export class Terminal {
  private colsCount: number;
  private rowsCount: number;
  private primary: BufferState;
  private alt: BufferState | null = null;
  private active: BufferState;
  private scrollback: Line[] = [];
  private pen: Attr = DEFAULT_ATTR;
  private modes: Modes = defaultModes();
  private scrollTop = 0;
  private scrollBottom: number;
  private tabs: boolean[];
  /** Курсор стоит у правого края и перенесёт следующий знак на новую строку. */
  private wrapPending = false;
  private readonly parser = new VtParser();

  constructor(
    cols: number,
    rows: number,
    /**
     * Ответ терминала на запросы (DSR: где курсор). Через этот шов модель остаётся
     * без ввода-вывода, а мост решает, как доставить ответ обратно в pty.
     */
    private readonly respond: (data: string) => void = () => undefined,
  ) {
    this.colsCount = Math.max(1, cols);
    this.rowsCount = Math.max(1, rows);
    this.primary = this.freshBuffer(this.colsCount, this.rowsCount);
    this.active = this.primary;
    this.scrollBottom = this.rowsCount - 1;
    this.tabs = this.freshTabs(this.colsCount);
  }

  get cols(): number {
    return this.colsCount;
  }

  get rows(): number {
    return this.rowsCount;
  }

  get cursor(): { x: number; y: number } {
    return { x: this.active.cx, y: this.active.cy };
  }

  get cursorVisible(): boolean {
    return this.modes.cursorVisible;
  }

  /** Открыта ли альтернативная доска: у неё нет своей истории, и прошлый вывод не виден. */
  get alternate(): boolean {
    return this.active === this.alt;
  }

  get applicationCursorKeys(): boolean {
    return this.modes.applicationCursorKeys;
  }

  get bracketedPaste(): boolean {
    return this.modes.bracketedPaste;
  }

  /** Как программе сообщать о мыши: `none` — мышь остаётся выделению текста. */
  get mouseTracking(): MouseTracking {
    return this.modes.mouseTracking;
  }

  /** Форма события мыши: SGR (`?1006`) или старый формат с байтами по 223 позиции. */
  get mouseSgr(): boolean {
    return this.modes.mouseSgr;
  }

  /** Строка доски для отрисовки. */
  line(row: number): Line | undefined {
    return this.active.lines[row];
  }

  /** История строк основной доски (снизу вверх она же — прокрутка вверх). */
  history(): readonly Line[] {
    return this.scrollback;
  }

  /** Применить порцию вывода. */
  write(data: string): void {
    for (const event of this.parser.write(data)) this.applyEvent(event);
  }

  private freshBuffer(cols: number, rows: number): BufferState {
    const lines: Line[] = [];
    for (let i = 0; i < rows; i += 1) lines.push(blankLine(cols, DEFAULT_ATTR));
    return { lines, cx: 0, cy: 0, savedX: 0, savedY: 0, savedAttr: DEFAULT_ATTR };
  }

  private freshTabs(cols: number): boolean[] {
    const tabs: boolean[] = [];
    for (let i = 0; i < cols; i += 1) tabs.push(i > 0 && i % TAB_WIDTH === 0);
    return tabs;
  }

  private applyEvent(event: VtEvent): void {
    switch (event.type) {
      case 'print':
        this.printText(event.text);
        return;
      case 'control':
        this.control(event.code);
        return;
      case 'esc':
        this.escape(event);
        return;
      case 'csi':
        this.csi(event);
        return;
      case 'osc':
        // Заголовок окна и гиперссылки OSC-8 — следующим шагом; пока не мешают выводу.
        return;
    }
  }

  // ── печать ────────────────────────────────────────────────────────────────

  private printText(text: string): void {
    for (const ch of text) {
      const codePoint = ch.codePointAt(0) ?? 0;
      const width = cellsOf(codePoint);
      // Комбинирующий знак своей клетки не занимает: дописываем его к знаку слева.
      if (width === 0) {
        this.combine(ch);
        continue;
      }
      if (this.wrapPending) {
        this.wrapPending = false;
        this.markWrapped();
        this.lineFeed();
        this.active.cx = 0;
      }
      if (this.active.cx + width > this.colsCount) {
        if (this.modes.wraparound) {
          this.markWrapped();
          this.lineFeed();
          this.active.cx = 0;
        } else {
          this.active.cx = Math.max(0, this.colsCount - width);
        }
      }
      this.putCell(ch, width);
    }
  }

  /**
   * Пометить строку продолженной: она заполнена и следующий знак уйдёт на новую строку
   * без перевода. По этой пометке `resize` собирает обратно логическую строку (reflow).
   */
  private markWrapped(): void {
    const line = this.active.lines[this.active.cy];
    if (line) line.wrapped = true;
  }

  private putCell(ch: string, width: number): void {
    if (this.modes.insert) this.insertCells(1);
    const line = this.active.lines[this.active.cy];
    if (!line) return;
    const x = this.active.cx;
    // Затираем половинку широкого знака, если пишем поверх него.
    this.clearWideAt(line, x);
    if (width === 2 && x + 1 < this.colsCount) this.clearWideAt(line, x + 1);

    line.cells[x] = { chars: ch, width, attr: this.pen };
    // Вторая клетка широкого знака — продолжение без своего знака.
    if (width === 2 && x + 1 < this.colsCount) line.cells[x + 1] = { chars: '', width: 0, attr: this.pen };

    this.active.cx += width;
    if (this.active.cx >= this.colsCount) {
      this.active.cx = this.colsCount - 1;
      this.wrapPending = this.modes.wraparound;
    }
  }

  private clearWideAt(line: Line, x: number): void {
    const cell = line.cells[x];
    if (!cell) return;
    if (cell.width === 2 && x + 1 < this.colsCount) line.cells[x + 1] = blankAttrCell(this.pen);
    else if (cell.width === 0 && x - 1 >= 0) line.cells[x - 1] = blankAttrCell(this.pen);
  }

  private combine(ch: string): void {
    const x = this.active.cx - 1;
    if (x < 0) return;
    const line = this.active.lines[this.active.cy];
    const cell = line?.cells[x];
    if (!cell) return;
    line.cells[x] = { ...cell, chars: cell.chars + ch };
  }

  // ── управляющие символы ─────────────────────────────────────────────────────

  private control(code: number): void {
    switch (code) {
      case 0x07: // BEL — звук оставляем виду
      case 0x0e: // SO / G1
      case 0x0f: // SI / G0
        return;
      case 0x08: // BS
        this.active.cx = Math.max(0, this.active.cx - 1);
        this.wrapPending = false;
        return;
      case 0x09: // HT
        this.tab();
        return;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.lineFeed();
        return;
      case 0x0d: // CR
        this.active.cx = 0;
        this.wrapPending = false;
        return;
      default:
        return;
    }
  }

  private tab(): void {
    let x = this.active.cx + 1;
    while (x < this.colsCount && !this.tabs[x]) x += 1;
    this.active.cx = Math.min(x, this.colsCount - 1);
    this.wrapPending = false;
  }

  /** Перевод строки: на нижней границе области доска прокручивается вверх. */
  private lineFeed(): void {
    this.wrapPending = false;
    if (this.active.cy === this.scrollBottom) this.scrollUp(1);
    else this.active.cy = Math.min(this.active.cy + 1, this.rowsCount - 1);
  }

  private reverseIndex(): void {
    if (this.active.cy === this.scrollTop) this.scrollDown(1);
    else this.active.cy = Math.max(this.active.cy - 1, 0);
  }

  // ── ESC ─────────────────────────────────────────────────────────────────────

  private escape(event: EscEvent): void {
    switch (event.final) {
      case '7':
        this.saveCursor();
        return;
      case '8':
        this.restoreCursor();
        return;
      case 'D':
        this.lineFeed();
        return;
      case 'M':
        this.reverseIndex();
        return;
      case 'E':
        this.active.cx = 0;
        this.lineFeed();
        return;
      case 'c':
        this.resetScreen();
        return;
      default:
        // Прочее (выбор набора знаков `( B`, выравнивание `# 8`, режимы клавиатуры) —
        // на сетку не влияет: за пределами спайка.
        return;
    }
  }

  // ── CSI ─────────────────────────────────────────────────────────────────────

  /** Параметр с учётом «по умолчанию»: пусто (0) подменяется на нужное команде число. */
  private param(event: CsiEvent, index: number, fallback: number): number {
    const value = event.params[index]?.[0];
    if (value === undefined || value === 0) return fallback;
    return value;
  }

  private csi(event: CsiEvent): void {
    // Режимы (DECSET/DECRST) приходят с маркером `?`; остальные режимы — без.
    if (event.final === 'h' || event.final === 'l') {
      this.setModes(event, event.final === 'h');
      return;
    }

    switch (event.final) {
      case 'A':
        this.moveBy(0, -this.param(event, 0, 1));
        return;
      case 'B':
        this.moveBy(0, this.param(event, 0, 1));
        return;
      case 'C':
        this.moveBy(this.param(event, 0, 1), 0);
        return;
      case 'D':
        this.moveBy(-this.param(event, 0, 1), 0);
        return;
      case 'E':
        this.moveBy(0, this.param(event, 0, 1));
        this.active.cx = 0;
        return;
      case 'F':
        this.moveBy(0, -this.param(event, 0, 1));
        this.active.cx = 0;
        return;
      case 'G':
      case '`':
        this.active.cx = this.clampCol(this.param(event, 0, 1) - 1);
        this.wrapPending = false;
        return;
      case 'd':
        this.active.cy = this.clampRow(this.param(event, 0, 1) - 1);
        this.wrapPending = false;
        return;
      case 'H':
      case 'f':
        this.moveCursor(this.param(event, 0, 1) - 1, this.param(event, 1, 1) - 1);
        return;
      case 'J':
        this.eraseInDisplay(this.param(event, 0, 0));
        return;
      case 'K':
        this.eraseInLine(this.param(event, 0, 0));
        return;
      case 'm':
        this.pen = applySgr(this.pen, event.params);
        return;
      case 'L':
        this.insertLines(this.param(event, 0, 1));
        return;
      case 'M':
        this.deleteLines(this.param(event, 0, 1));
        return;
      case '@':
        this.insertCells(this.param(event, 0, 1));
        return;
      case 'P':
        this.deleteCells(this.param(event, 0, 1));
        return;
      case 'X':
        this.eraseChars(this.param(event, 0, 1));
        return;
      case 'S':
        this.scrollUp(this.param(event, 0, 1));
        return;
      case 'T':
        this.scrollDown(this.param(event, 0, 1));
        return;
      case 'r':
        this.setScrollRegion(event);
        return;
      case 'g':
        this.clearTab(this.param(event, 0, 0));
        return;
      case 's':
        this.saveCursor();
        return;
      case 'u':
        this.restoreCursor();
        return;
      case 'n':
        this.statusReport(event);
        return;
      default:
        return;
    }
  }

  private setModes(event: CsiEvent, enabled: boolean): void {
    const isPrivate = event.private === '?';
    for (const group of event.params) {
      const code = group[0] ?? 0;
      if (!isPrivate) {
        if (code === 4) this.modes.insert = enabled;
        continue;
      }
      switch (code) {
        case 1:
          this.modes.applicationCursorKeys = enabled;
          break;
        case 6:
          this.modes.origin = enabled;
          this.moveCursor(0, 0);
          break;
        case 7:
          this.modes.wraparound = enabled;
          break;
        case 25:
          this.modes.cursorVisible = enabled;
          break;
        case 47:
        case 1047:
        case 1049:
          this.switchAltScreen(enabled, code === 1049);
          break;
        case 2004:
          this.modes.bracketedPaste = enabled;
          break;
        // Мышь: режимы разной широты. Выключение `?1000`/`?1002`/`?1003` возвращает мышь
        // выделению; форму события (`?1006`) помним отдельно.
        case 9:
        case 1000:
          this.modes.mouseTracking = enabled ? 'click' : 'none';
          break;
        case 1002:
          this.modes.mouseTracking = enabled ? 'drag' : 'none';
          break;
        case 1003:
          this.modes.mouseTracking = enabled ? 'move' : 'none';
          break;
        case 1006:
          this.modes.mouseSgr = enabled;
          break;
        default:
          break;
      }
    }
  }

  /** Альтернативная доска: отдельный экран для полноэкранных программ (`vim`, `htop`). */
  private switchAltScreen(enabled: boolean, clear: boolean): void {
    if (enabled) {
      if (!this.alt || clear) this.alt = this.freshBuffer(this.colsCount, this.rowsCount);
      this.alt.savedAttr = this.pen;
      this.active = this.alt;
      this.wrapPending = false;
    } else if (this.alt) {
      this.active = this.primary;
      this.pen = this.alt.savedAttr;
      this.wrapPending = false;
    }
  }

  private setScrollRegion(event: CsiEvent): void {
    const top = this.param(event, 0, 1) - 1;
    const bottom = this.param(event, 1, this.rowsCount) - 1;
    if (top < 0 || bottom >= this.rowsCount || top >= bottom) return;
    this.scrollTop = top;
    this.scrollBottom = bottom;
    this.moveCursor(0, 0);
  }

  private statusReport(event: CsiEvent): void {
    const code = this.param(event, 0, 0);
    if (code === 5) this.respond('\x1b[0n');
    else if (code === 6) {
      const row = this.active.cy - (this.modes.origin ? this.scrollTop : 0) + 1;
      this.respond(`\x1b[${row};${this.active.cx + 1}R`);
    }
  }

  private clearTab(mode: number): void {
    if (mode === 3) {
      this.tabs = this.tabs.map(() => false);
      return;
    }
    this.tabs[this.active.cx] = false;
  }

  private saveCursor(): void {
    this.active.savedX = this.active.cx;
    this.active.savedY = this.active.cy;
    this.active.savedAttr = this.pen;
  }

  private restoreCursor(): void {
    this.active.cx = this.clampCol(this.active.savedX);
    this.active.cy = this.clampRow(this.active.savedY);
    this.pen = this.active.savedAttr;
    this.wrapPending = false;
  }

  // ── перемещение и границы ─────────────────────────────────────────────────────

  private top(): number {
    return this.modes.origin ? this.scrollTop : 0;
  }

  private bottom(): number {
    return this.modes.origin ? this.scrollBottom : this.rowsCount - 1;
  }

  private clampCol(x: number): number {
    return Math.min(Math.max(x, 0), this.colsCount - 1);
  }

  private clampRow(y: number): number {
    return Math.min(Math.max(y, this.top()), this.bottom());
  }

  private moveCursor(row: number, col: number): void {
    this.active.cy = this.clampRow(row);
    this.active.cx = this.clampCol(col);
    this.wrapPending = false;
  }

  private moveBy(dx: number, dy: number): void {
    this.active.cx = this.clampCol(this.active.cx + dx);
    this.active.cy = this.clampRow(this.active.cy + dy);
    this.wrapPending = false;
  }

  // ── стирание и правка клеток ─────────────────────────────────────────────────

  private eraseInLine(mode: number): void {
    const line = this.active.lines[this.active.cy];
    if (!line) return;
    const from = mode === 1 || mode === 2 ? 0 : this.active.cx;
    const to = mode === 0 || mode === 2 ? this.colsCount - 1 : this.active.cx;
    // Стирание идёт текущим цветом фона — так работают и «залить строку фоном».
    for (let x = from; x <= to; x += 1) line.cells[x] = blankAttrCell(this.pen);
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 3) {
      this.scrollback = [];
      return;
    }
    if (mode === 2) {
      for (let y = 0; y < this.rowsCount; y += 1) {
        this.active.lines[y] = blankLine(this.colsCount, this.pen);
      }
      return;
    }
    if (mode === 0) {
      this.eraseInLine(0);
      for (let y = this.active.cy + 1; y < this.rowsCount; y += 1) {
        this.active.lines[y] = blankLine(this.colsCount, this.pen);
      }
      return;
    }
    // mode 1 — от начала экрана до курсора.
    this.eraseInLine(1);
    for (let y = 0; y < this.active.cy; y += 1) {
      this.active.lines[y] = blankLine(this.colsCount, this.pen);
    }
  }

  private eraseChars(count: number): void {
    const line = this.active.lines[this.active.cy];
    if (!line) return;
    for (let i = 0; i < count && this.active.cx + i < this.colsCount; i += 1) {
      line.cells[this.active.cx + i] = blankAttrCell(this.pen);
    }
  }

  private insertCells(count: number): void {
    const line = this.active.lines[this.active.cy];
    if (!line) return;
    const blanks: Cell[] = [];
    for (let i = 0; i < count; i += 1) blanks.push(blankAttrCell(this.pen));
    line.cells.splice(this.active.cx, 0, ...blanks);
    line.cells.length = this.colsCount;
  }

  private deleteCells(count: number): void {
    const line = this.active.lines[this.active.cy];
    if (!line) return;
    line.cells.splice(this.active.cx, count);
    while (line.cells.length < this.colsCount) line.cells.push(blankAttrCell(this.pen));
  }

  // ── прокрутка и области ──────────────────────────────────────────────────────

  private scrollUp(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const removed = this.active.lines.splice(this.scrollTop, 1)[0];
      // В историю уходит только то, что ушло с основной доски целиком сверху.
      if (removed && this.active === this.primary && this.scrollTop === 0 && this.scrollBottom === this.rowsCount - 1) {
        this.scrollback.push(removed);
        if (this.scrollback.length > SCROLLBACK_LIMIT) this.scrollback.shift();
      }
      this.active.lines.splice(this.scrollBottom, 0, blankLine(this.colsCount, this.pen));
    }
  }

  private scrollDown(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.active.lines.splice(this.scrollBottom, 1);
      this.active.lines.splice(this.scrollTop, 0, blankLine(this.colsCount, this.pen));
    }
  }

  private insertLines(count: number): void {
    if (this.active.cy < this.scrollTop || this.active.cy > this.scrollBottom) return;
    for (let i = 0; i < count; i += 1) {
      this.active.lines.splice(this.scrollBottom, 1);
      this.active.lines.splice(this.active.cy, 0, blankLine(this.colsCount, this.pen));
    }
  }

  private deleteLines(count: number): void {
    if (this.active.cy < this.scrollTop || this.active.cy > this.scrollBottom) return;
    for (let i = 0; i < count; i += 1) {
      this.active.lines.splice(this.active.cy, 1);
      this.active.lines.splice(this.scrollBottom, 0, blankLine(this.colsCount, this.pen));
    }
  }

  private resetScreen(): void {
    this.pen = DEFAULT_ATTR;
    this.modes = defaultModes();
    this.scrollTop = 0;
    this.scrollBottom = this.rowsCount - 1;
    this.tabs = this.freshTabs(this.colsCount);
    this.scrollback = [];
    this.primary = this.freshBuffer(this.colsCount, this.rowsCount);
    this.alt = null;
    this.active = this.primary;
    this.wrapPending = false;
  }

  /**
   * Сменить размер окна. Столбцы меняются — содержимое ПЕРЕНОСИТСЯ (reflow): строки,
   * заполненные и продолженные (пометка `wrapped`), собираются в логические и снова
   * раскладываются по новой ширине. Иначе при сжатии длинная строка теряла бы хвост, а
   * при расширении оставалась разбитой там, где места уже хватает.
   *
   * Альтернативная доска через reflow не проходит: её содержимое рисует полноэкранная
   * программа, и она сама перерисует его по новому размеру (так делает и xterm).
   */
  resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    if (nextCols === this.colsCount && nextRows === this.rowsCount) return;

    if (nextCols !== this.colsCount) this.reflowPrimary(nextCols, nextRows);
    else this.resizeSimple(this.primary, nextCols, nextRows);
    if (this.alt) this.resizeSimple(this.alt, nextCols, nextRows);

    this.colsCount = nextCols;
    this.rowsCount = nextRows;
    this.scrollTop = 0;
    this.scrollBottom = nextRows - 1;
    this.tabs = this.freshTabs(nextCols);
    this.wrapPending = false;
  }

  /** Простой размер без переноса: клетки обрезаются и дополняются, строки тоже. */
  private resizeSimple(buffer: BufferState, cols: number, rows: number): void {
    for (const line of buffer.lines) {
      if (cols > line.cells.length) {
        while (line.cells.length < cols) line.cells.push(blankAttrCell(DEFAULT_ATTR));
      } else if (cols < line.cells.length) {
        line.cells.length = cols;
      }
    }
    while (buffer.lines.length < rows) buffer.lines.push(blankLine(cols, DEFAULT_ATTR));
    if (buffer.lines.length > rows) buffer.lines.length = rows;
    buffer.cy = Math.min(buffer.cy, rows - 1);
    buffer.cx = Math.min(buffer.cx, cols - 1);
  }

  /**
   * Пере-перенос основной доски на новую ширину.
   *
   * История и экран сливаются в один список строк: логическая строка может начинаться
   * в истории и продолжаться на экране, и разрезать её по этой границе нельзя. Дальше:
   * строки, помеченные `wrapped`, собираются в логические; из каждой берётся плоский
   * список клеток (хвостовые пробелы срезаны — иначе при расширении они дали бы пустые
   * ряды); клетки раскладываются заново по `cols` (широкий знак не разрывается), а по
   * ходу раскладки видим, где оказался курсор (`trackCell`). Готовый список делится:
   * хвост в `rows` строк — экран, остальное — история: что не влезло на экран, уходит
   * в историю, а не пропадает.
   */
  private reflowPrimary(cols: number, rows: number): void {
    const primaryEnd = trailingBlankStart(this.primary.lines);
    const kept = this.primary.lines.slice(0, Math.max(primaryEnd, this.primary.cy) + 1);
    const all = [...this.scrollback, ...kept];
    const history = this.scrollback.length;
    const cursorAbs = history + this.primary.cy;
    let cursorCol = this.primary.cx;
    // Строка полна и ждала переноса (`wrapPending`): курсор стоит на последней клетке,
    // но после переноса перенос уже не нужен, и по смыслу курсор ЗА строкой.
    if (this.wrapPending && cursorCol === this.colsCount - 1) cursorCol = this.colsCount;
    // Курсор на второй половине широкого знака — считаем его позицией самого знака.
    const cursorLine = this.primary.lines[this.primary.cy];
    if (cursorLine && cursorLine.cells[cursorCol]?.width === 0 && cursorCol > 0) cursorCol -= 1;

    const out: Line[] = [];
    let cursorOutRow = 0;
    let cursorOutCol = cursorCol;
    let index = 0;

    while (index < all.length) {
      let end = index;
      while (end + 1 < all.length && all[end]?.wrapped) end += 1;

      const cells: Cell[] = [];
      for (let row = index; row <= end; row += 1) {
        const line = all[row];
        if (line) cells.push(...line.cells);
      }
      trimTrailingBlank(cells);

      const inGroup = cursorAbs >= index && cursorAbs <= end;
      let track: number | null = null;
      if (inGroup) {
        track = (cursorAbs - index) * this.colsCount + cursorCol;
        // Позиция ЗА последним знаком — тоже допустима: оставляем её за концом строки.
        track = Math.max(0, Math.min(track, cells.length));
        // Попали на вторую половину широкого знака — сдвигаемся к его началу.
        while (track > 0 && cells[track]?.width === 0) track -= 1;
      }

      const wrapped = wrapCells(cells, cols, track);
      if (track !== null) {
        cursorOutRow = out.length + wrapped.trackRow;
        cursorOutCol = wrapped.trackCol;
      }
      out.push(...wrapped.rows);
      index = end + 1;
    }

    if (out.length <= rows) {
      while (out.length < rows) out.push(blankLine(cols, DEFAULT_ATTR));
      this.scrollback = [];
      this.primary.lines = out;
      this.primary.cy = Math.min(cursorOutRow, rows - 1);
    } else {
      const start = out.length - rows;
      this.scrollback = out.slice(0, start);
      if (this.scrollback.length > SCROLLBACK_LIMIT) {
        this.scrollback.splice(0, this.scrollback.length - SCROLLBACK_LIMIT);
      }
      this.primary.lines = out.slice(start);
      this.primary.cy = Math.max(0, Math.min(cursorOutRow - start, rows - 1));
    }

    this.primary.cx = Math.max(0, Math.min(cursorOutCol, cols - 1));
    this.primary.savedX = Math.min(this.primary.savedX, cols - 1);
    this.primary.savedY = Math.min(this.primary.savedY, rows - 1);
  }
}
