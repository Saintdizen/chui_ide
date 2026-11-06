import { beforeEach, describe, expect, it } from 'vitest';
import { Minimap, minimapBar, minimapScale, minimapSlider, rowForMinimapY } from '../src/renderer/editor/view/minimap';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Арифметика миникарты (`editor/view/minimap.ts`).
 *
 * Рисование — дело холста, но опасная часть здесь численная: сколько черт брать на
 * большом файле, какой высоты ползунок, в какую строку попадает клик. Ошибка тут
 * выглядит как «клик по карте отправляет не туда» и ловится только руками, поэтому
 * чистые функции проверяются отдельно от DOM.
 */

describe('соотношение строк и высоты карты', () => {
  it('файл короче высоты — строка выше пикселя, берём каждую', () => {
    const scale = minimapScale(10, 100);

    expect(scale.rowHeight).toBe(10);
    expect(scale.step).toBe(1);
  });

  it('файл в высоту — пиксель на строку', () => {
    expect(minimapScale(100, 100)).toEqual({ rowHeight: 1, step: 1 });
  });

  it('огромный файл — берём каждую n-ю строку', () => {
    // 100000 строк на 400px: строка файла — 1/250 пикселя.
    const scale = minimapScale(100_000, 400);

    expect(scale.step).toBe(250);
    // Черт порядка высоты карты: больше точек, чем пикселей, не рисуем.
    expect(Math.ceil(100_000 / scale.step)).toBeCloseTo(400, 0);
  });

  it('пустой файл и нулевая высота — нули, а не деление на ноль', () => {
    expect(minimapScale(0, 100)).toEqual({ rowHeight: 0, step: 1 });
    expect(minimapScale(100, 0)).toEqual({ rowHeight: 0, step: 1 });
    expect(Number.isFinite(minimapScale(0, 0).rowHeight)).toBe(true);
  });
});

describe('ползунок видимой части', () => {
  it('ползунок стоит там, где прокрутка', () => {
    expect(minimapSlider(50, 10, 100, 200)).toEqual({ top: 100, height: 20 });
  });

  it('у верха карты ползунок начинается с нуля', () => {
    expect(minimapSlider(0, 25, 100, 200)?.top).toBe(0);
  });

  it('слишком тонкий ползунок не бывает: мышью не поймать', () => {
    expect(minimapSlider(0, 10, 100_000, 400)?.height).toBeGreaterThanOrEqual(16);
  });

  it('у конца файла ползунок не вылезает за карту', () => {
    const slider = minimapSlider(99, 10, 100, 200);

    expect(slider?.top).toBeLessThanOrEqual(200);
    expect((slider?.top ?? 0) + (slider?.height ?? 0)).toBeLessThanOrEqual(200);
  });

  it('видимых строк больше, чем всего — ползунок во всю карту', () => {
    expect(minimapSlider(0, 50, 10, 200)).toEqual({ top: 0, height: 200 });
  });

  it('пустой файл и нулевая высота — ползунка нет', () => {
    expect(minimapSlider(0, 10, 0, 200)).toBeNull();
    expect(minimapSlider(0, 10, 100, 0)).toBeNull();
  });
});

describe('строка под точкой карты', () => {
  it('верх карты — первая строка', () => {
    expect(rowForMinimapY(0, 100, 200)).toBe(0);
  });

  it('середина — середина файла', () => {
    expect(rowForMinimapY(100, 100, 200)).toBe(50);
  });

  it('низ карты — последняя строка, а не строка за концом', () => {
    // Клик у самого низа не должен уводить в несуществующую строку.
    expect(rowForMinimapY(200, 100, 200)).toBe(99);
    expect(rowForMinimapY(500, 100, 200)).toBe(99);
  });

  it('отрицательное смещение — первая строка', () => {
    expect(rowForMinimapY(-10, 100, 200)).toBe(0);
  });

  it('пустой файл — строка 0', () => {
    expect(rowForMinimapY(50, 0, 200)).toBe(0);
  });
});

describe('черта строки на карте', () => {
  it('обычная строка идёт от нуля', () => {
    const bar = minimapBar('const a = 1;', 120);

    expect(bar?.x).toBe(0);
    expect(bar?.width).toBeCloseTo(12, 1);
  });

  it('отступ сдвигает черту вправо, а не растягивает', () => {
    const flat = minimapBar('x = 1', 120);
    const indented = minimapBar('        x = 1', 120);

    expect(indented?.x).toBeCloseTo(8, 1);
    expect(indented?.width).toBeCloseTo(flat?.width ?? 0, 1);
  });

  it('пробелы в конце не удлиняют черту', () => {
    const trailing = minimapBar('x = 1      ', 120);
    const plain = minimapBar('x = 1', 120);

    expect(trailing?.width).toBeCloseTo(plain?.width ?? 0, 5);
  });

  it('пустая строка и только пробелы — черты нет', () => {
    expect(minimapBar('', 120)).toBeNull();
    expect(minimapBar('     ', 120)).toBeNull();
  });

  it('строка длиннее карты обрезается по краю', () => {
    const bar = minimapBar('x'.repeat(500), 120);

    expect(bar?.x).toBe(0);
    expect(bar?.width).toBe(120);
  });

  it('отступ длиннее карты — черты нет', () => {
    // Рисовать нечего: видимая часть строки целиком за краем карты. Нулевая по
    // ширине черта была бы мусором в разметке на каждую такую строку.
    expect(minimapBar(`${' '.repeat(300)}x`, 120)).toBeNull();
  });
});

/**
 * Сам виджет миникарты: холст, ползунок и переход по клику.
 *
 * Холст подменён заглушкой, которая записывает `fillRect`: в Node настоящего canvas
 * нет, но всё, что выше (раскладка, ползунок, клик), — настоящий код.
 */
describe('виджет миникарты', () => {
  beforeEach(() => {
    installMiniDom();
  });

  function fakeCanvas() {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const context = {
      fillStyle: '',
      globalAlpha: 1,
      setTransform() {},
      clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) {
        rects.push({ x, y, w, h });
      },
    };
    return { context, rects };
  }

  function makeMinimap(options: { rowCount?: number; scrollTop?: number } = {}) {
    const canvas = fakeCanvas();
    const scrolled: number[] = [];
    const element = new Minimap({
      text: (line) => `строка ${line}`,
      rowCount: () => options.rowCount ?? 100,
      lineHeight: () => 20,
      scrollTop: () => options.scrollTop ?? 0,
      viewportHeight: () => 400,
      color: () => '#fff',
      scrollToRow: (row) => scrolled.push(row),
    });
    // Холст создаёт сам виджет: подменяем `getContext` у его canvas-узла.
    const node = element.element.querySelector('.own-editor-minimap-canvas') as unknown as {
      getContext(): unknown;
      width: number;
      height: number;
      handlers: Record<string, ((event: unknown) => void)[]>;
    };
    node.getContext = () => canvas.context;
    (element.element as unknown as { clientHeight: number }).clientHeight = 400;
    return { minimap: element, scrolled, rects: canvas.rects, node };
  }

  it('закладки рисуются полосой у правого края, чужие строки игнорируются', () => {
    const { minimap, rects } = makeMinimap({ rowCount: 40 });

    minimap.setBookmarks([5, 1, 999, 0]);

    // 40 строк на 400px: черта — 10px на строку, шаг 1. Четыре закладки заданы,
    // но 0 и 999 вне файла — их не рисуем, остаются 1 и 5.
    const marks = rects.slice(-2);
    expect(marks).toHaveLength(2);
    // Строка 1 — верх, строка 5 — на 40px ниже (полоса стоит по строке).
    expect(marks[0]!.y).toBe(0);
    expect(marks[1]!.y).toBe(40);
    // У правого края: x сдвинут вправо, ширина мала — текст карты не закрыт.
    expect(marks[0]!.x).toBeGreaterThan(0);
    expect(marks[0]!.w).toBeLessThanOrEqual(4);
  });

  it('тот же набор закладок не перерисовывает карту заново', () => {
    const { minimap, rects } = makeMinimap({ rowCount: 40 });

    minimap.setBookmarks([3, 7]);
    const afterFirst = rects.length;
    minimap.setBookmarks([7, 3]); // тот же набор, другой порядок

    expect(rects.length).toBe(afterFirst);
  });

  it('рисует по черте на каждую строку и ставит ползунок по прокрутке', () => {
    const { minimap, rects } = makeMinimap({ rowCount: 40, scrollTop: 200 });

    minimap.render();

    // 40 строк на 400px — строка 10px, каждую видно: 40 черт.
    expect(rects).toHaveLength(40);
    const slider = minimap.element.querySelector('.own-editor-minimap-slider') as unknown as {
      style: { top?: string; height?: string };
      hidden: boolean;
    };
    expect(slider.hidden).toBe(false);
    // Прокрутка 200px при строке 20px — первая видимая строка 10, из 40 строк на
    // карте 400px это четверть высоты: ползунок на 100px.
    expect(slider.style.top).toBe('100px');
  });

  it('пустой файл — ползунка нет, черт нет', () => {
    const { minimap, rects } = makeMinimap({ rowCount: 0 });

    minimap.render();

    expect(rects).toEqual([]);
    const slider = minimap.element.querySelector('.own-editor-minimap-slider') as unknown as {
      hidden: boolean;
    };
    expect(slider.hidden).toBe(true);
  });

  it('клик по карте переводит редактор к строке под указателем', () => {
    const { minimap, scrolled, node } = makeMinimap({ rowCount: 100 });
    minimap.render();

    // Клик по середине карты (400px высоты) — 50-я строка.
    for (const handler of node.handlers.mousedown ?? []) {
      handler({ clientY: 200, preventDefault() {} });
    }

    expect(scrolled).toEqual([50]);
  });

  it('прокрутка в начало даёт первую строку', () => {
    const { minimap, scrolled, node } = makeMinimap({ rowCount: 100 });
    minimap.render();

    for (const handler of node.handlers.mousedown ?? []) {
      handler({ clientY: 0, preventDefault() {} });
    }

    expect(scrolled).toEqual([0]);
  });
});
