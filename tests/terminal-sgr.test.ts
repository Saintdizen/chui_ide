import { describe, expect, it } from 'vitest';
import { applySgr, DEFAULT_ATTR, type Attr } from '../src/renderer/terminal/core/attrs';

/**
 * SGR — как `\x1b[…m` меняет цвет и начертание. Правило чистое (атрибуты → атрибуты),
 * поэтому проверяется без экрана. Главные случаи: базовые и яркие цвета, 256 и точный
 * RGB в двух формах (через `;` и через `:`), а также выключение начертаний без сброса.
 */

const sgr = (...codes: number[]): Attr =>
  applySgr(
    DEFAULT_ATTR,
    codes.map((code) => [code]),
  );

describe('applySgr: базовые коды', () => {
  it('пустой список — это сброс', () => {
    const red = sgr(31);
    expect(applySgr(red, [])).toEqual(DEFAULT_ATTR);
  });

  it('30–37 задают цвет текста по номеру палитры', () => {
    expect(sgr(31).fg).toEqual({ kind: 'palette', index: 1 });
  });

  it('40–47 задают фон', () => {
    expect(sgr(44).bg).toEqual({ kind: 'palette', index: 4 });
  });

  it('90–97 и 100–107 — яркие цвета', () => {
    expect(sgr(92).fg).toEqual({ kind: 'palette', index: 10 });
    expect(sgr(100).bg).toEqual({ kind: 'palette', index: 8 });
  });

  it('39 и 49 возвращают цвета по умолчанию, не трогая начертание', () => {
    const attr = applySgr(sgr(1, 31, 44), [[39], [49]]);
    expect(attr.fg).toEqual({ kind: 'default' });
    expect(attr.bg).toEqual({ kind: 'default' });
    expect(attr.bold).toBe(true);
  });
});

describe('applySgr: начертания', () => {
  it('включает и выключает начертания по отдельности', () => {
    const on = applySgr(DEFAULT_ATTR, [[1], [3], [4], [7]]);
    expect(on).toMatchObject({ bold: true, italic: true, underline: true, inverse: true });
    const off = applySgr(on, [[23], [24], [27]]);
    expect(off).toMatchObject({ italic: false, underline: false, inverse: false, bold: true });
  });

  it('22 снимает и жирный, и приглушённый разом', () => {
    const attr = applySgr(DEFAULT_ATTR, [[1], [2], [22]]);
    expect(attr).toMatchObject({ bold: false, dim: false });
  });
});

describe('applySgr: расширенные цвета', () => {
  it('256 цветов через точку с запятой', () => {
    expect(applySgr(DEFAULT_ATTR, [[38], [5], [196]]).fg).toEqual({ kind: 'palette', index: 196 });
  });

  it('точный RGB через точку с запятой', () => {
    expect(applySgr(DEFAULT_ATTR, [[38], [2], [10], [20], [30]]).fg).toEqual({ kind: 'rgb', r: 10, g: 20, b: 30 });
  });

  it('точный RGB через двоеточие', () => {
    expect(applySgr(DEFAULT_ATTR, [[38, 2, 10, 20, 30]]).fg).toEqual({ kind: 'rgb', r: 10, g: 20, b: 30 });
  });

  it('точный RGB с пропущенным цветовым профилем (::)', () => {
    expect(applySgr(DEFAULT_ATTR, [[48, 2, 0, 1, 2, 3]]).bg).toEqual({ kind: 'rgb', r: 1, g: 2, b: 3 });
  });

  it('расширенный цвет продолжает разбор последующих кодов', () => {
    const attr = applySgr(DEFAULT_ATTR, [[1], [38], [5], [9], [4]]);
    expect(attr.fg).toEqual({ kind: 'palette', index: 9 });
    expect(attr).toMatchObject({ bold: true, underline: true });
  });
});
