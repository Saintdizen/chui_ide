import { describe, expect, it } from 'vitest';
import { Terminal } from '../src/renderer/terminal/core/screen';

/**
 * Управляющие строки OSC: имя окна (OSC 0/2) и гиперссылки (OSC 8). Проверяется без окна:
 * имя читается с модели, ссылка — с клеток. Главные случаи: имя ставится и снимается,
 * ссылка ведёт знаки до самого снятия, пробелы ссылку не получают, а полный сброс
 * очищает и имя, и ссылку.
 */

/** Ссылка на знаке по столбцу строки 0. */
const linkAt = (term: Terminal, col: number): string | undefined => term.line(0)?.cells[col]?.link;

describe('Terminal: имя окна (OSC 0/2)', () => {
  it('OSC 2 задаёт имя окна', () => {
    const term = new Terminal(20, 3);
    term.write('\x1b]2;мой заголовок\x07');
    expect(term.title).toBe('мой заголовок');
  });

  it('OSC 0 задаёт имя окна так же', () => {
    const term = new Terminal(20, 3);
    term.write('\x1b]0;проект\x07');
    expect(term.title).toBe('проект');
  });

  it('пустая строка снимает имя', () => {
    const term = new Terminal(20, 3);
    term.write('\x1b]2;было\x07');
    term.write('\x1b]2;\x07');
    expect(term.title).toBe('');
  });

  it('имя приходит и через ST (ESC \\\\)', () => {
    const term = new Terminal(20, 3);
    term.write('\x1b]2;через ST\x1b\\');
    expect(term.title).toBe('через ST');
  });

  it('полный сброс (RIS) очищает имя', () => {
    const term = new Terminal(20, 3);
    term.write('\x1b]2;было\x07');
    term.write('\x1bc');
    expect(term.title).toBe('');
  });
});

describe('Terminal: гиперссылки (OSC 8)', () => {
  it('знаки после ссылки её получают', () => {
    const term = new Terminal(40, 3);
    term.write('\x1b]8;;https://example.com\x07клик\x1b]8;;\x07');
    expect(linkAt(term, 0)).toBe('https://example.com');
    expect(linkAt(term, 3)).toBe('https://example.com');
  });

  it('после снятия ссылки знаки её не получают', () => {
    const term = new Terminal(40, 3);
    term.write('\x1b]8;;https://a\x07да\x1b]8;;\x07нет');
    expect(linkAt(term, 0)).toBe('https://a'); // «д»
    expect(linkAt(term, 1)).toBe('https://a'); // «а» — ссылка ещё стоит
    expect(linkAt(term, 2)).toBeUndefined(); // «н» — ссылку уже сняли
  });

  it('пробел ссылку не получает: он заливка фона, а не текст', () => {
    const term = new Terminal(40, 3);
    term.write('\x1b]8;;https://a\x07 \x1b]8;;\x07');
    expect(linkAt(term, 0)).toBeUndefined();
  });

  it('параметры ссылки не мешают адресу', () => {
    const term = new Terminal(40, 3);
    term.write('\x1b]8;id=42;https://example.com/a\x07x\x1b]8;;\x07');
    expect(linkAt(term, 0)).toBe('https://example.com/a');
  });

  it('вторая клетка широкого знака несёт ту же ссылку', () => {
    const term = new Terminal(40, 3);
    term.write('\x1b]8;;https://a\x07あ\x1b]8;;\x07');
    const cells = term.line(0)?.cells ?? [];
    expect(cells[0]?.link).toBe('https://a');
    expect(cells[1]?.link).toBe('https://a');
  });

  it('обычный текст ссылки не имеет', () => {
    const term = new Terminal(40, 3);
    term.write('просто текст');
    expect(linkAt(term, 0)).toBeUndefined();
  });

  it('полный сброс (RIS) снимает ссылку', () => {
    const term = new Terminal(40, 3);
    term.write('\x1b]8;;https://a\x07');
    term.write('\x1bc');
    term.write('x');
    expect(linkAt(term, 0)).toBeUndefined();
  });
});
