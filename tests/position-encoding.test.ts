import { describe, expect, it } from 'vitest';
import { columnLength, fromServerColumn, negotiateEncoding, toServerColumn } from '../src/shared/position-encoding';

const EMOJI = '\u{1F600}'; // улыбка: 2 единицы UTF-16, 1 код UTF-32

describe('positionEncoding: выбор кодировки', () => {
  it('нет списка — utf-16 (по умолчанию протокола)', () => {
    expect(negotiateEncoding(undefined)).toBe('utf-16');
  });
  it('сервер предлагает utf-32 — берём его', () => {
    expect(negotiateEncoding(['utf-32'])).toBe('utf-32');
  });
  it('utf-16 в списке — предпочитаем его (нативно, без пересчёта)', () => {
    expect(negotiateEncoding(['utf-32', 'utf-16'])).toBe('utf-16');
  });
  it('только utf-8 — откат к utf-16', () => {
    expect(negotiateEncoding(['utf-8'])).toBe('utf-16');
  });
});

describe('positionEncoding: длина колонки', () => {
  it('ASCII одинаков в обеих кодировках', () => {
    expect(columnLength('abc', 'utf-16')).toBe(3);
    expect(columnLength('abc', 'utf-32')).toBe(3);
  });
  it('эмодзи — 2 в utf-16, 1 в utf-32', () => {
    expect(columnLength(`a${EMOJI}b`, 'utf-16')).toBe(4);
    expect(columnLength(`a${EMOJI}b`, 'utf-32')).toBe(3);
  });
  it('кириллица — по единице в обеих (BMP)', () => {
    expect(columnLength('привет', 'utf-32')).toBe(6);
  });
});

describe('positionEncoding: колонка редактора -> сервер', () => {
  it('utf-16 — без изменений', () => {
    expect(toServerColumn(`a${EMOJI}b`, 3, 'utf-16')).toBe(3);
  });
  it('utf-32 — после эмодзи сдвиг на единицу', () => {
    // 'a' + emoji: в редакторе это 3 UTF-16 единицы, у сервера — 2 кода.
    expect(toServerColumn(`a${EMOJI}b`, 3, 'utf-32')).toBe(2);
  });
  it('позиция между суррогатами не забегает вперёд', () => {
    // Середина пары — 2 единицы, но ещё внутри первого кода → 1.
    expect(toServerColumn(`a${EMOJI}b`, 2, 'utf-32')).toBe(1);
  });
  it('колонка за концом строки упирается в конец', () => {
    expect(toServerColumn('abc', 99, 'utf-32')).toBe(3);
  });
});

describe('positionEncoding: колонка сервера -> редактор', () => {
  it('utf-16 — обратная операция', () => {
    expect(fromServerColumn(`a${EMOJI}b`, 3, 'utf-16')).toBe(3);
  });
  it('utf-32 — возвращает UTF-16 индекс после эмодзи', () => {
    expect(fromServerColumn(`a${EMOJI}b`, 2, 'utf-32')).toBe(3);
  });
  it('туда-обратно на строке с эмодзи — сходится', () => {
    const line = `x${EMOJI}${EMOJI}y`;
    for (let col = 0; col <= line.length; col += 1) {
      const back = fromServerColumn(line, toServerColumn(line, col, 'utf-32'), 'utf-32');
      // На середине пары возврат идёт к краю пары — это допустимо, остальное точно.
      const mid = line.charCodeAt(col - 1) >= 0xd800 && line.charCodeAt(col - 1) <= 0xdbff;
      expect(mid ? back === col || back === col - 1 : back === col).toBe(true);
    }
  });
  it('character за концом — конец строки', () => {
    expect(fromServerColumn('abc', 99, 'utf-32')).toBe(3);
  });
});
