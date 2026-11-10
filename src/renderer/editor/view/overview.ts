/**
 * Полоса меток справа от кода (overview ruler).
 *
 * Миникарта показывает, КАК выглядит текст; полоса — что в файле важно: где ошибки,
 * где совпадения поиска, где правки git. По ней видно состояние всего файла, не
 * пролистывая его, а клик уводит к метке.
 *
 * Считать и рисовать — разное дело, и здесь они разделены нарочно: раскладка
 * (`computeOverviewMarks`, `pointToLine`, `viewportFractions`) — чистые функции от
 * меток и размеров, их можно проверить без DOM. Слой (`OverviewRuler`) только
 * переносит результат в узлы.
 *
 * По вертикали метка — доля от всего файла, а не номер строки: файл на 20 000 строк
 * и файл на 40 строк делят полосу поровну, и ошибка в середине всегда в середине
 * полосы.
 */

export type OverviewKind = 'error' | 'warning' | 'info' | 'search' | 'added' | 'modified' | 'deleted';

/** Метка: строка файла (с единицы) и вид. */
export interface OverviewInput {
  readonly line: number;
  readonly kind: OverviewKind;
}

/** Метка, готовая к рисованию: отрезок полосы в пикселях (от верха). */
export interface OverviewMark {
  readonly top: number;
  readonly height: number;
  readonly kind: OverviewKind;
}

/** Минимальная высота метки: одна ошибка на 20 000 строк иначе была бы тоньше пикселя. */
export const OVERVIEW_MIN_MARK = 2;

/**
 * Раскладка меток на полосе высотой `height`.
 *
 * `lineCount` — сколько строк в файле (0 — документ пуст, меток не будет). Метки
 * сортируются по строке, чтобы порядок узлов совпадал с порядком на полосе.
 */
export function computeOverviewMarks(
  marks: readonly OverviewInput[],
  lineCount: number,
  height: number,
): OverviewMark[] {
  if (lineCount <= 0 || height <= 0 || marks.length === 0) return [];
  const rowHeight = height / lineCount;
  const markHeight = Math.max(OVERVIEW_MIN_MARK, rowHeight);
  const sorted = [...marks].sort((a, b) => a.line - b.line);
  const result: OverviewMark[] = [];
  for (const mark of sorted) {
    // Строки у вызывающего с единицы, а доли — с нуля; заодно прижимаем к файлу:
    // метка «за концом» — не ошибка вызова, а устаревшие данные сервера.
    const row = Math.min(Math.max(mark.line - 1, 0), lineCount - 1);
    // Метка прижимается к низу полосы целиком, а не обрезается: иначе у последней
    // строки оставалась бы половина и она выглядела бы мельче остальных.
    const top = Math.min(Math.max(row * rowHeight, 0), Math.max(height - markHeight, 0));
    result.push({ top, height: markHeight, kind: mark.kind });
  }
  return result;
}

/**
 * Строка (с единицы), к которой ведёт точка на полосе.
 *
 * `offset` — координата клика от верха полосы. Пустой файл — строка 1: прокручивать
 * некуда, но 0 не вернуть — строки с номером 0 не бывает.
 */
export function pointToLine(offset: number, lineCount: number, height: number): number {
  if (lineCount <= 0 || height <= 0) return 1;
  const ratio = Math.min(Math.max(offset, 0), height) / height;
  const line = Math.floor(ratio * lineCount) + 1;
  return Math.min(Math.max(line, 1), lineCount);
}

/** Куда поставить рамку «видимой части» на полосе (доли 0..1). */
export function viewportFractions(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
): { top: number; height: number } {
  // Содержимое ещё не разложено — рамка на всю полосу: пусть видна, чем прячется.
  if (contentHeight <= 0) return { top: 0, height: 1 };
  const top = Math.min(Math.max(scrollTop / contentHeight, 0), 1);
  const height = Math.min(Math.max(viewportHeight / contentHeight, 0), Math.max(1 - top, 0));
  return { top, height };
}

/** Что рисуем: метки, число строк и состояние прокрутки. */
export interface OverviewState {
  readonly marks: readonly OverviewInput[];
  readonly lineCount: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}

/**
 * Слой полосы: узкий столбик справа, метки — абсолютные полоски, поверх них —
 * рамка видимой части. Клик по полосе уводит к строке; за рамку не тянем — это
 * не скроллбар, и притворяться им значило бы обещать больше, чем полоса умеет.
 */
export class OverviewRuler {
  readonly element: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly slider: HTMLElement;
  /** Что уже нарисовано в слое меток: на прокрутке не меняется. */
  private painted: { marks: readonly OverviewInput[]; lineCount: number; height: number } | null = null;
  private state: OverviewState = {
    marks: [],
    lineCount: 0,
    scrollTop: 0,
    viewportHeight: 0,
    contentHeight: 0,
  };

  constructor(private readonly onPick: (line: number) => void) {
    this.element = document.createElement('div');
    this.element.className = 'own-editor-overview';
    this.marks = document.createElement('div');
    this.marks.className = 'own-editor-overview-marks';
    this.slider = document.createElement('div');
    this.slider.className = 'own-editor-overview-slider';
    this.element.append(this.marks, this.slider);
    this.element.addEventListener('mousedown', (event) => this.pick(event));
  }

  /** Метки или прокрутка поменялись — перерисовать. */
  setState(next: OverviewState): void {
    this.state = next;
    this.render();
  }

  render(): void {
    const height = this.element.clientHeight;
    // Метки — только по изменению меток, числа строк или высоты полосы; на
    // прокрутке едет одна рамка (ниже). Раньше на каждый кадр создавались
    // заново все узлы меток — на прокрутке это была работа впустую.
    const painted = this.painted;
    if (
      !painted ||
      painted.marks !== this.state.marks ||
      painted.lineCount !== this.state.lineCount ||
      painted.height !== height
    ) {
      this.painted = { marks: this.state.marks, lineCount: this.state.lineCount, height };
      const marks = computeOverviewMarks(this.state.marks, this.state.lineCount, height);
      this.marks.replaceChildren(
        ...marks.map((mark) => {
          const node = document.createElement('div');
          node.className = `own-editor-overview-mark is-${mark.kind}`;
          node.style.top = `${mark.top}px`;
          node.style.height = `${mark.height}px`;
          return node;
        }),
      );
    }
    const fractions = viewportFractions(this.state.scrollTop, this.state.viewportHeight, this.state.contentHeight);
    this.slider.style.top = `${fractions.top * 100}%`;
    this.slider.style.height = `${fractions.height * 100}%`;
    // Весь файл виден целиком — рамка не нужна и только путает.
    this.slider.hidden = fractions.height >= 0.999;
  }

  private pick(event: MouseEvent): void {
    if (event.button !== 0) return;
    const rect = this.element.getBoundingClientRect();
    if (rect.height <= 0) return;
    this.onPick(pointToLine(event.clientY - rect.top, this.state.lineCount, rect.height));
  }
}
