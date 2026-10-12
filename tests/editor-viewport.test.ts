import { describe, expect, it } from 'vitest';
import {
  clamp,
  contentHeight,
  lineAtY,
  maxScrollLeft,
  maxScrollTop,
  revealLine,
  visibleLines,
  yOfLine,
} from '../src/renderer/editor/view/viewport';

describe('размеры полотна', () => {
  it('высота документа — число строк на высоту строки', () => {
    expect(contentHeight(100, 20)).toBe(2000);
  });

  it('пустой документ всё равно занимает одну строку', () => {
    expect(contentHeight(0, 20)).toBe(20);
  });

  it('предел прокрутки вниз: когда документ короче экрана — ноль', () => {
    expect(maxScrollTop(100, 20, 200)).toBe(1800);
    expect(maxScrollTop(5, 20, 200)).toBe(0);
  });

  it('предел прокрутки вправо — по самой длинной строке', () => {
    expect(maxScrollLeft(1000, 300)).toBe(700);
    expect(maxScrollLeft(200, 300)).toBe(0);
  });

  it('прокрутка прижимается к отрезку [0, max]', () => {
    expect(clamp(-10, 500)).toBe(0);
    expect(clamp(250, 500)).toBe(250);
    expect(clamp(900, 500)).toBe(500);
    expect(clamp(Number.NaN, 500)).toBe(0);
  });
});

describe('видимые строки', () => {
  it('в начало экрана попадает столько строк, сколько влезает, плюс запас', () => {
    // Экран 200 px, строка 20 px — 10 строк видно, запас 2 даёт 0..12.
    const visible = visibleLines(0, 20, 200, 100, 2);
    expect(visible.first).toBe(0);
    expect(visible.last).toBe(12);
  });

  it('с прокруткой диапазон сдвигается', () => {
    // scrollTop 1000 → первая видимая 50, запас — 48.
    const visible = visibleLines(1000, 20, 200, 100, 2);
    expect(visible.first).toBe(48);
    expect(visible.last).toBe(62);
  });

  it('в коротком документе прокрутка не выводит диапазон за конец файла', () => {
    const visible = visibleLines(9999, 20, 200, 5, 0);
    expect(visible.first).toBe(0);
    expect(visible.last).toBe(4);
  });
});

describe('координата y и строка', () => {
  it('строка по y, крайние значения прижимаются к ближайшей строке', () => {
    expect(lineAtY(-5, 20, 10)).toBe(0);
    expect(lineAtY(45, 20, 10)).toBe(2);
    expect(lineAtY(1_000_000, 20, 10)).toBe(9);
  });

  it('верх строки по её номеру', () => {
    expect(yOfLine(0, 20)).toBe(0);
    expect(yOfLine(3, 20)).toBe(60);
  });
});

describe('прокрутка к строке', () => {
  const lineHeight = 20;
  const viewportHeight = 200;
  const lineCount = 1000;

  it('строка ниже экрана прокручивается к нему с полем у нижнего края', () => {
    // Строка 300 занимает y 6000..6020; прокручиваем так, чтобы она встала с полем
    // 20 px от нижнего края: 6020 - 200 + 20 = 5840.
    expect(revealLine(300, 0, lineHeight, viewportHeight, lineCount)).toBe(5840);
  });

  it('строка выше экрана прокручивается к верхнему краю с полем', () => {
    expect(revealLine(50, 4000, lineHeight, viewportHeight, lineCount)).toBe(1000 - 20);
  });

  it('строка, стоящая ровно у края, видна и не дёргает прокрутку', () => {
    // Строка 50 занимает y от 1000 до 1020; прокрутка 1000 — она вверху экрана.
    expect(revealLine(50, 1000, lineHeight, viewportHeight, lineCount)).toBe(1000);
  });

  it('строка у самого конца документа не выводит прокрутку за предел', () => {
    const revealed = revealLine(999, 0, lineHeight, viewportHeight, lineCount);
    expect(revealed).toBe(19800);
  });
});
