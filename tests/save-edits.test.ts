import { describe, expect, it } from 'vitest';
import { applySaveEdits } from '../src/shared/save-edits';

/** Обе правки выключены — текст остаётся как есть. */
const none = { trimTrailingWhitespace: false, insertFinalNewline: false };
const trim = { trimTrailingWhitespace: true, insertFinalNewline: false };
const newline = { trimTrailingWhitespace: false, insertFinalNewline: true };
const both = { trimTrailingWhitespace: true, insertFinalNewline: true };

describe('правки при сохранении', () => {
  it('с выключенными настройками текст не трогает', () => {
    expect(applySaveEdits('a  \nb\t\n', none)).toBe('a  \nb\t\n');
  });

  it('срезает хвостовые пробелы в каждой строке', () => {
    expect(applySaveEdits('a  \nb\t\nc ', trim)).toBe('a\nb\nc');
  });

  it('подрезает хвост последней строки без перевода', () => {
    expect(applySaveEdits('a\nb   ', trim)).toBe('a\nb');
  });

  it('не трогает пробелы в начале и внутри строки', () => {
    expect(applySaveEdits('  a b  \n  c ', trim)).toBe('  a b\n  c');
  });

  it('делает строку из одних пробелов пустой', () => {
    expect(applySaveEdits('a\n   \nb', trim)).toBe('a\n\nb');
  });

  it('добавляет перевод строки в конце, если его нет', () => {
    expect(applySaveEdits('a\nb', newline)).toBe('a\nb\n');
  });

  it('не удваивает уже существующий перевод строки', () => {
    expect(applySaveEdits('a\nb\n', newline)).toBe('a\nb\n');
  });

  it('пустой файл не превращает в файл из одного перевода', () => {
    expect(applySaveEdits('', both)).toBe('');
  });

  it('обе правки вместе: подрезка, затем завершающий перевод', () => {
    expect(applySaveEdits('a  \nb   ', both)).toBe('a\nb\n');
  });

  it('текст без перевода строки целиком остаётся одной строкой', () => {
    expect(applySaveEdits('x = 1   ', both)).toBe('x = 1\n');
  });

  it('сохраняет CRLF: подрезка идёт перед \\r\\n', () => {
    expect(applySaveEdits('a  \r\nb\t\r\n', trim)).toBe('a\r\nb\r\n');
  });
});
