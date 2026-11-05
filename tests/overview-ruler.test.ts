import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeOverviewMarks,
  OVERVIEW_MIN_MARK,
  OverviewRuler,
  pointToLine,
  viewportFractions,
} from '../src/renderer/editor/view/overview';
import { EditorView } from '../src/renderer/editor/view/editor-view';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { installMiniDom } from './helpers/mini-dom';

beforeEach(() => {
  installMiniDom();
});

/**
 * Полоса меток справа (TASKS 47).
 *
 * Было: миникарта есть, а полосы меток нет — ошибки, совпадения поиска и правки
 * git были видны только по месту, то есть их надо было найти прокруткой.
 */

describe('раскладка меток', () => {
  it('доля файла, а не номер строки: середина файла — середина полосы', () => {
    const marks = computeOverviewMarks([{ line: 50, kind: 'error' }], 100, 200);
    expect(marks).toEqual([{ top: 98, height: OVERVIEW_MIN_MARK, kind: 'error' }]);
  });

  it('первая строка у верха, последняя не вылезает за низ', () => {
    const marks = computeOverviewMarks(
      [
        { line: 1, kind: 'error' },
        { line: 100, kind: 'warning' },
      ],
      100,
      200,
    );
    expect(marks[0]!.top).toBe(0);
    // 100-я строка дала бы top=198, и метка высотой 2 обрезалась бы полосой.
    expect(marks[1]!.top).toBe(198);
    expect(marks[1]!.top + marks[1]!.height).toBe(200);
  });

  it('одна строка на большой файл — не тоньше пары пикселей', () => {
    const marks = computeOverviewMarks([{ line: 5000, kind: 'error' }], 20000, 300);
    expect(marks[0]!.height).toBe(OVERVIEW_MIN_MARK);
  });

  it('метки сортируются по строке: узлы идут как на полосе', () => {
    const marks = computeOverviewMarks(
      [
        { line: 30, kind: 'added' },
        { line: 10, kind: 'error' },
        { line: 20, kind: 'search' },
      ],
      40,
      400,
    );
    expect(marks.map((mark) => mark.kind)).toEqual(['error', 'search', 'added']);
  });

  it('строки за пределами файла прижимаются, а не выбрасывают метку', () => {
    // Диагностика от отставшего сервера: файл уже короче, чем когда её прислали.
    const marks = computeOverviewMarks([{ line: 900, kind: 'error' }], 10, 100);
    expect(marks).toHaveLength(1);
    // Прижимается к НАЧАЛУ последней строки: 9 * (100 / 10) = 90.
    expect(marks[0]!.top).toBe(90);
  });

  it('пустой файл или нулевая высота — меток нет', () => {
    expect(computeOverviewMarks([{ line: 1, kind: 'error' }], 0, 100)).toEqual([]);
    expect(computeOverviewMarks([{ line: 1, kind: 'error' }], 10, 0)).toEqual([]);
    expect(computeOverviewMarks([], 10, 100)).toEqual([]);
  });
});

describe('клик по полосе', () => {
  it('верх — первая строка, низ — последняя', () => {
    expect(pointToLine(0, 100, 200)).toBe(1);
    expect(pointToLine(200, 100, 200)).toBe(100);
    expect(pointToLine(199, 100, 200)).toBe(100);
  });

  it('середина — середина файла', () => {
    expect(pointToLine(100, 100, 200)).toBe(51);
  });

  it('клик мимо полосы прижимается к файлу', () => {
    expect(pointToLine(-50, 100, 200)).toBe(1);
    expect(pointToLine(9999, 100, 200)).toBe(100);
  });

  it('пустой файл — всегда первая строка', () => {
    expect(pointToLine(50, 0, 200)).toBe(1);
  });
});

describe('рамка видимой части', () => {
  it('виден весь файл — рамка на всю полосу', () => {
    expect(viewportFractions(0, 500, 500)).toEqual({ top: 0, height: 1 });
  });

  it('прокрутка вниз двигает рамку', () => {
    const fractions = viewportFractions(150, 50, 1000);
    expect(fractions.top).toBeCloseTo(0.15);
    expect(fractions.height).toBeCloseTo(0.05);
  });

  it('у конца файла рамка не вылезает за низ', () => {
    const fractions = viewportFractions(990, 100, 1000);
    expect(fractions.top + fractions.height).toBeLessThanOrEqual(1.0000001);
  });

  it('содержимое не разложено — рамка на всю полосу', () => {
    expect(viewportFractions(0, 100, 0)).toEqual({ top: 0, height: 1 });
  });
});

describe('слой на странице', () => {
  const sized = (height: number): OverviewRuler => {
    const ruler = new OverviewRuler(() => undefined);
    // Мини-DOM не считает высоту — задаём её сами, как это сделал бы браузер.
    Object.defineProperty(ruler.element, 'clientHeight', { value: height, configurable: true });
    return ruler;
  };

  it('метки становятся полосками с видом и положением', () => {
    const ruler = sized(100);
    ruler.setState({
      marks: [
        { line: 1, kind: 'error' },
        { line: 50, kind: 'search' },
      ],
      lineCount: 100,
      scrollTop: 0,
      viewportHeight: 20,
      contentHeight: 1000,
    });
    const drawn = [...ruler.element.querySelectorAll('.own-editor-overview-mark')] as HTMLElement[];
    expect(drawn).toHaveLength(2);
    expect(drawn[0]!.className).toContain('is-error');
    expect(drawn[0]!.style.top).toBe('0px');
    expect(drawn[1]!.className).toContain('is-search');
    expect(parseFloat(drawn[1]!.style.top)).toBeCloseTo(49, 0);
  });

  it('виден весь файл — рамка прячется', () => {
    const ruler = sized(100);
    ruler.setState({ marks: [], lineCount: 10, scrollTop: 0, viewportHeight: 200, contentHeight: 200 });
    const slider = ruler.element.querySelector('.own-editor-overview-slider') as HTMLElement;
    expect(slider.hidden).toBe(true);
  });

  it('клик зовёт переход к строке', () => {
    let picked = -1;
    const ruler = new OverviewRuler((line) => {
      picked = line;
    });
    Object.defineProperty(ruler.element, 'getBoundingClientRect', {
      value: () => ({ top: 0, left: 0, height: 200, width: 10, bottom: 200, right: 10, x: 0, y: 0 }),
      configurable: true,
    });
    ruler.setState({ marks: [], lineCount: 100, scrollTop: 0, viewportHeight: 100, contentHeight: 2000 });
    // Мини-DOM не знает `MouseEvent`: обработчику нужны только `button` и `clientY`.
    ruler.element.dispatchEvent({ type: 'mousedown', button: 0, clientY: 100 } as unknown as Event);
    expect(picked).toBe(51);
  });
});

describe('полоса в редакторе', () => {
  const host = () => {
    const element = document.createElement('div');
    document.body.append(element);
    return element as unknown as HTMLElement;
  };
  const METRICS = {
    charWidth: 8,
    lineHeight: 20,
    tabSize: 4,
    widthOf: () => 8,
  };

  it('по умолчанию скрыта: лишняя колонка справа не появляется сама', () => {
    const element = host();
    const view = new EditorView(element, new TextBuffer('a\nb'), { metrics: METRICS });
    const ruler = (element as unknown as { querySelector(s: string): HTMLElement | null }).querySelector?.(
      '.own-editor-overview',
    );
    // Слой создаётся, но спрятан — место не занимает.
    expect(ruler).not.toBeNull();
    expect(ruler?.hidden).toBe(true);
    view.dispose();
  });

  it('включение и выключение показывают и прячут полосу', () => {
    const element = host();
    const view = new EditorView(element, new TextBuffer('a\nb'), { metrics: METRICS, overview: true });
    const ruler = (element as unknown as { querySelector(s: string): HTMLElement | null }).querySelector?.(
      '.own-editor-overview',
    ) as HTMLElement;
    expect(ruler.hidden).toBe(false);
    view.setOverview(false);
    expect(ruler.hidden).toBe(true);
    expect(view.overviewShown).toBe(false);
    view.dispose();
  });
});
