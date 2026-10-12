import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';

/**
 * Наивная модель документа — независимая реализация того же контракта.
 *
 * Она нарочно написана «в лоб»: обычная строка и пересчёт строк делением. Именно
 * поэтому ею можно проверять структуру кусков и индекс строк: общего кода у них
 * только строки текста, а значит, общая ошибка не спрячется.
 */
function naiveLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\r') {
      if (text[index + 1] === '\n') continue;
      lines.push(current);
      current = '';
    } else if (char === '\n') {
      lines.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  lines.push(current);
  return lines;
}

/** Простой воспроизводимый генератор: тест с падением можно повторить тем же зерном. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Сдвинуть смещение влево, если оно стоит между половинами суррогатной пары.
 * Нужно самому фаззеру: правка, задевшая половину символа, честно расширяется до
 * целого (см. `piece-table.ts`), и без выравнивания наивная модель разошлась бы
 * не из-за ошибки, а из-за другой границы правки.
 */
function alignToCodepoint(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  if (at > 0 && at < text.length) {
    const code = text.charCodeAt(at);
    if (code >= 0xdc00 && code <= 0xdfff) return at - 1;
  }
  return at;
}

const BITS = ['a', ' ', '\n', '\r\n', 'ё', 'Ж', '😀', '\t', 'function', '()', '{}', 'e\u0301', '\r'];

describe('TextBuffer', () => {
  it('пустой документ — одна пустая строка', () => {
    const buffer = new TextBuffer();
    expect(buffer.lineCount).toBe(1);
    expect(buffer.lineText(1)).toBe('');
    expect(buffer.positionAt(0)).toEqual({ line: 1, column: 1 });
  });

  it('строка — то же, что видит человек: разрыв один, а текст с разрывом даёт пустую строку после', () => {
    const buffer = new TextBuffer('a\nb\r\nc\rd');
    expect(buffer.lineCount).toBe(4);
    expect(buffer.lineText(1)).toBe('a');
    expect(buffer.lineText(2)).toBe('b');
    expect(buffer.lineText(3)).toBe('c');
    expect(buffer.lineText(4)).toBe('d');

    const trailing = new TextBuffer('a\n');
    expect(trailing.lineCount).toBe(2);
    expect(trailing.lineText(2)).toBe('');
  });

  it('смещение и позиция переводятся друг в друга', () => {
    const buffer = new TextBuffer('первая\nвторая\n');
    expect(buffer.positionAt(0)).toEqual({ line: 1, column: 1 });
    expect(buffer.positionAt(7)).toEqual({ line: 2, column: 1 });
    // Смещение 14 — начало третьей строки (вторая кончается на 13-м, перед разрывом).
    expect(buffer.positionAt(14)).toEqual({ line: 3, column: 1 });
    expect(buffer.offsetAt({ line: 2, column: 3 })).toBe(9);
    // Столбец за концом строки прижимается к её концу.
    expect(buffer.offsetAt({ line: 1, column: 99 })).toBe(6);
    expect(buffer.offsetAt({ line: 99, column: 1 })).toBe(14);
  });

  it('правка поднимает версию — по ней представление понимает, что кэши устарели', () => {
    const buffer = new TextBuffer('abc');
    const before = buffer.version;
    buffer.insert(0, 'x');
    expect(buffer.version).toBeGreaterThan(before);
    expect(buffer.insert(0, '')).toBe(0);
  });

  it('вставка и удаление правят только затронутые строки', () => {
    const buffer = new TextBuffer('раз\nдва\nтри');
    // Смещение 7 — конец второй строки: «два» занимает смещения 4, 5, 6.
    buffer.insert(7, ' ТРИ-ПОЛОВИНЫ');
    expect(buffer.lineText(1)).toBe('раз');
    expect(buffer.lineText(2)).toBe('два ТРИ-ПОЛОВИНЫ');
    expect(buffer.lineText(3)).toBe('три');
    buffer.delete(7, ' ТРИ-ПОЛОВИНЫ'.length);
    expect(buffer.text).toBe('раз\nдва\nтри');
  });

  it('вставка текста с разрывами добавляет строки, удаление — убирает', () => {
    const buffer = new TextBuffer('a');
    buffer.insert(1, '\n\nb');
    expect(buffer.lineCount).toBe(3);
    expect(buffer.lineText(2)).toBe('');
    expect(buffer.lineText(3)).toBe('b');
    // Убираем один разрыв — строк снова две.
    buffer.delete(1, 1);
    expect(buffer.lineCount).toBe(2);
    expect(buffer.text).toBe('a\nb');
  });

  const SEED = 20251012;
  const STEPS = 1200;

  it('случайные правки не расходятся с наивной моделью', () => {
    const random = rng(SEED);
    const buffer = new TextBuffer();
    let naive = '';

    for (let step = 0; step < STEPS; step += 1) {
      const pick = random();
      const at = alignToCodepoint(naive, Math.floor(random() * (naive.length + 1)));
      if (pick < 0.6 || naive.length === 0) {
        const text = BITS[Math.floor(random() * BITS.length)];
        buffer.insert(at, text);
        naive = naive.slice(0, at) + text + naive.slice(at);
      } else {
        // От 1 до 12 единиц, не выходя за конец и не разрезая символ.
        const length = 1 + Math.floor(random() * Math.min(12, naive.length - at));
        const end = alignToCodepoint(naive, at + length);
        buffer.delete(at, end - at);
        naive = naive.slice(0, at) + naive.slice(end);
      }

      // Текст сверяем на каждом шаге — ошибка видна сразу на своей правке.
      expect(buffer.text, `шаг ${step}`).toBe(naive);
    }

    // Индекс строк и перевод позиций сверяем на итоговом документе.
    const lines = naiveLines(naive);
    expect(buffer.lineCount).toBe(lines.length);
    for (let line = 1; line <= lines.length; line += 1) {
      expect(buffer.lineText(line), `строка ${line}`).toBe(lines[line - 1]);
    }

    for (let probe = 0; probe < 200; probe += 1) {
      const offset = Math.floor(random() * (naive.length + 1));
      const position = buffer.positionAt(offset);
      // Обратный перевод возвращает то же смещение: столбец внутри строки.
      expect(buffer.offsetAt(position), `смещение ${offset}`).toBe(offset);
      expect(buffer.lineAt(offset)).toBe(position.line);
    }
  });

  it('документ в 2000 строк: правка в начале не сдвигает строки после неё', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => `строка ${index}`).join('\n');
    const buffer = new TextBuffer(rows);
    expect(buffer.lineCount).toBe(2000);
    buffer.insert(0, 'НАЧАЛО\n');
    expect(buffer.lineCount).toBe(2001);
    expect(buffer.lineText(1)).toBe('НАЧАЛО');
    expect(buffer.lineText(2)).toBe('строка 0');
    expect(buffer.lineText(2001)).toBe('строка 1999');
  });
});
