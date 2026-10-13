import { describe, expect, it } from 'vitest';
import { VtParser } from '../src/renderer/terminal/core/vt-parse';

/**
 * Разбор потока терминала: текст и последовательности вперемешку, границы — по байтам.
 * Правило чистое (строка → события), поэтому проверяется без окна и без pty. Главные
 * случаи: текст копится, последовательность может прийти по частям, а параметры бывают
 * с точкой с запятой, с двоеточием, пропущенные и с приватным маркером.
 */

const parser = () => new VtParser();

describe('VtParser: текст и управляющие символы', () => {
  it('обычный текст собирается в одно событие печати', () => {
    expect(parser().write('hello')).toEqual([{ type: 'print', text: 'hello' }]);
  });

  it('управляющий символ отделяется от текста и идёт по порядку', () => {
    expect(parser().write('a\r\nb')).toEqual([
      { type: 'print', text: 'a' },
      { type: 'control', code: 0x0d },
      { type: 'control', code: 0x0a },
      { type: 'print', text: 'b' },
    ]);
  });

  it('текст по обе стороны последовательности не сливается', () => {
    expect(parser().write('a\x1b[31mb')).toEqual([
      { type: 'print', text: 'a' },
      { type: 'csi', params: [[31]], private: '', intermediates: '', final: 'm' },
      { type: 'print', text: 'b' },
    ]);
  });
});

describe('VtParser: последовательность по частям', () => {
  it('недобранная CSI не теряется между порциями', () => {
    const vt = parser();
    expect(vt.write('\x1b[3')).toEqual([]);
    expect(vt.write('1m')).toEqual([{ type: 'csi', params: [[31]], private: '', intermediates: '', final: 'm' }]);
  });

  it('ESC в конце порции ждёт продолжения', () => {
    const vt = parser();
    expect(vt.write('\x1b')).toEqual([]);
    expect(vt.write('[2J')).toEqual([{ type: 'csi', params: [[2]], private: '', intermediates: '', final: 'J' }]);
  });

  it('сброс забывает недобранную последовательность', () => {
    const vt = parser();
    vt.write('\x1b[3');
    vt.reset();
    expect(vt.write('x')).toEqual([{ type: 'print', text: 'x' }]);
  });
});

describe('VtParser: параметры', () => {
  it('параметры делятся точкой с запятой', () => {
    expect(parser().write('\x1b[2;5H')[0]).toMatchObject({ params: [[2], [5]], final: 'H' });
  });

  it('пропущенный параметр читается как ноль', () => {
    expect(parser().write('\x1b[;5H')[0]).toMatchObject({ params: [[0], [5]] });
  });

  it('двоеточие задаёт подпараметры группы', () => {
    expect(parser().write('\x1b[38:2::255:0:0m')[0]).toMatchObject({ params: [[38, 2, 0, 255, 0, 0]] });
  });

  it('приватный маркер отделяется от параметров', () => {
    expect(parser().write('\x1b[?25l')[0]).toMatchObject({ private: '?', params: [[25]], final: 'l' });
  });

  it('без параметров список пуст, а не [0]', () => {
    expect(parser().write('\x1b[m')[0]).toMatchObject({ params: [], final: 'm' });
  });
});

describe('VtParser: ESC и OSC', () => {
  it('выбор набора знаков приходит с промежуточным байтом', () => {
    expect(parser().write('\x1b(B')).toEqual([{ type: 'esc', intermediates: '(', final: 'B' }]);
  });

  it('OSC завершается BEL', () => {
    expect(parser().write('\x1b]0;заголовок\x07')).toEqual([{ type: 'osc', data: '0;заголовок' }]);
  });

  it('OSC завершается ST (ESC \\\\)', () => {
    const vt = parser();
    vt.write('\x1b]8;;https://a');
    expect(vt.write('\x1b\\')).toEqual([{ type: 'osc', data: '8;;https://a' }]);
  });

  it('содержимое DCS пропускается целиком', () => {
    const vt = parser();
    expect(vt.write('\x1bP1$r\x1b\\')).toEqual([]);
    expect(vt.write('ok')).toEqual([{ type: 'print', text: 'ok' }]);
  });
});
