/**
 * Миникарта: сжатый вид всего файла в узкой колонке у правого края.
 *
 * Рисуем на `<canvas>`, а не разметкой: строк бывает сто тысяч, и держать их узлами
 * нельзя. Каждая строка файла — короткая черта, сдвинутая вправо по её отступу и
 * длиной по видимой части строки: плотный код читается как рисунок, по которому видно
 * форму файла. Соотношение «строка файла — пиксель карты» считает чистая часть
 * (`minimapScale`, `minimapSlider`), её и проверяют тесты; рисование — дело DOM.
 *
 * Столбцов берём не больше `MINIMAP_COLUMNS`: карта узкая, и строка длиннее этого
 * всё равно упрётся в край. Так не нужен отдельный проход за самой длинной строкой.
 */

/** Столбцов, которые вмещает ширина карты: длиннее — обрезаем по краю. */
const MINIMAP_COLUMNS = 120;

/** Ползунок видимой части не бывает ниже этого: совсем тонкий не поймать мышью. */
const MIN_SLIDER_PX = 16;

/** Как строка файла ложится на пиксели карты. */
export interface MinimapScale {
  /** Высота строки документа в пикселях карты (меньше пикселя на больших файлах). */
  readonly rowHeight: number;
  /** Через сколько строк брать образец, чтобы не рисовать больше точек, чем пикселей. */
  readonly step: number;
}

/**
 * Соотношение высоты карты и числа строк. На большом файле строка файла тоньше
 * пикселя: тогда берём каждую `step`-ю строку, чтобы число черт было порядка высоты
 * карты, и каждая черта рисовалась высотой в пиксель, а не тонула в соседней.
 */
export function minimapScale(rowCount: number, height: number): MinimapScale {
  if (rowCount <= 0 || height <= 0) return { rowHeight: 0, step: 1 };
  const rowHeight = height / rowCount;
  const step = Math.max(1, Math.ceil(1 / rowHeight));
  return { rowHeight, step };
}

/** Ползунок видимой части карты: где его верх и какой он высоты. */
export function minimapSlider(
  firstRow: number,
  visibleRows: number,
  rowCount: number,
  height: number,
): { top: number; height: number } | null {
  if (rowCount <= 0 || height <= 0) return null;
  const scale = height / rowCount;
  const top = Math.max(0, Math.min(height, firstRow * scale));
  const size = Math.max(MIN_SLIDER_PX, Math.min(visibleRows, rowCount) * scale);
  return { top, height: Math.max(MIN_SLIDER_PX, Math.min(size, height - top)) };
}

/** Ряд строки под точкой карты: куда перейти по клику. */
export function rowForMinimapY(y: number, rowCount: number, height: number): number {
  if (rowCount <= 0 || height <= 0) return 0;
  return Math.max(0, Math.min(rowCount - 1, Math.floor((y / height) * rowCount)));
}

/** Ширина черты строки на карте: по её видимой части, со сдвигом по отступу. */
export function minimapBar(text: string, width: number): { x: number; width: number } | null {
  const visible = text.trimEnd().length;
  const start = text.length - text.trimStart().length;
  if (visible <= start) return null;
  const colScale = width / MINIMAP_COLUMNS;
  const x = Math.min(width, start * colScale);
  const w = Math.min(width - x, (visible - start) * colScale);
  if (w <= 0) return null;
  return { x, width: w };
}

/** Что нужно карте от редактора. Всё — функциями: карта читает состояние в момент отрисовки. */
export interface MinimapOptions {
  /** Текст строки (с единицы). */
  readonly text: (line: number) => string;
  /** Сколько сейчас рядов (со свёртками). */
  readonly rowCount: () => number;
  /** Высота строки текста в редакторе, px. */
  readonly lineHeight: () => number;
  /** Прокрутка редактора по вертикали, px. */
  readonly scrollTop: () => number;
  /** Высота окна редактора, px. */
  readonly viewportHeight: () => number;
  /** Цвет черт: берём цвет текста редактора, чтобы карта шла за темой. */
  readonly color: () => string;
  /** Перейти к ряду (поставить его в верх окна). */
  readonly scrollToRow: (row: number) => void;
  /** Ширина карты, px. */
  readonly width?: number;
}

/** Карта: холст с чертами строк и ползунок видимой части поверх него. */
export class Minimap {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly slider: HTMLElement;
  private readonly width: number;

  constructor(private readonly options: MinimapOptions) {
    this.width = options.width ?? 80;
    this.element = document.createElement('div');
    this.element.className = 'own-editor-minimap';
    this.element.style.width = `${this.width}px`;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'own-editor-minimap-canvas';
    this.slider = document.createElement('div');
    this.slider.className = 'own-editor-minimap-slider';
    this.element.append(this.canvas, this.slider);
    this.bind();
  }

  /** Перерисовать черты и переставить ползунок: зовётся из перерисовки редактора. */
  render(): void {
    const height = this.element.clientHeight;
    const rowCount = this.options.rowCount();
    this.draw(height, rowCount);
    this.positionSlider(height, rowCount);
  }

  private draw(height: number, rowCount: number): void {
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(this.width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, height);
    if (rowCount <= 0 || height <= 0) return;

    ctx.fillStyle = this.options.color();
    ctx.globalAlpha = 0.55;
    const { rowHeight, step } = minimapScale(rowCount, height);
    const barHeight = Math.max(1, rowHeight * step);
    for (let row = 0; row < rowCount; row += step) {
      const bar = minimapBar(this.options.text(row + 1), this.width);
      if (bar) ctx.fillRect(bar.x, row * rowHeight, bar.width, barHeight);
    }
    ctx.globalAlpha = 1;
  }

  private positionSlider(height: number, rowCount: number): void {
    const lineHeight = this.options.lineHeight();
    const visibleRows = height / lineHeight;
    const firstRow = this.options.scrollTop() / lineHeight;
    const rect = minimapSlider(firstRow, visibleRows, rowCount, height);
    if (!rect) {
      this.slider.hidden = true;
      return;
    }
    this.slider.hidden = false;
    this.slider.style.top = `${rect.top}px`;
    this.slider.style.height = `${rect.height}px`;
  }

  private bind(): void {
    // Клик по карте (не по ползунку) ведёт к этой строке: ползунок слушает сам и
    // гасит событие, поэтому сюда доходит только «мимо ползунка».
    this.canvas.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.scrollToClientY(event.clientY);
    });
    // За ползунок тянем: так по длинному файлу прокручивают, а не целятся в строку.
    this.slider.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const offset = event.clientY - this.slider.getBoundingClientRect().top;
      const onMove = (move: MouseEvent): void => {
        const top = move.clientY - this.element.getBoundingClientRect().top - offset;
        this.scrollToOffset(top);
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /** Прокрутить так, чтобы выбранный ряд оказался сверху. */
  private scrollToClientY(clientY: number): void {
    const rect = this.element.getBoundingClientRect();
    this.scrollToOffset(clientY - rect.top);
  }

  /** Прокрутить так, чтобы ряд под смещением `offset` (px от верха карты) встал в верх. */
  private scrollToOffset(offset: number): void {
    const height = this.element.clientHeight;
    const row = rowForMinimapY(offset, this.options.rowCount(), height);
    this.options.scrollToRow(row);
  }
}
