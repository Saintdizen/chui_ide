import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../src/shared/edits';
import { detectLineEnding, lineEndingEdits, lineEndingLabel, withLineEndings } from '../src/shared/line-endings';

describe('концы строк в файле', () => {
  it('файл в CRLF опознаётся как CRLF', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('\r\n');
  });

  it('файл в LF опознаётся как LF', () => {
    expect(detectLineEnding('a\nb\nc')).toBe('\n');
  });

  it('CRLF не считается дважды — иначе смешанный файл всегда выходил бы LF', () => {
    // Три CRLF и один LF: если бы `\n` внутри CRLF считался отдельно, вышло бы 3 на 4.
    expect(detectLineEnding('a\r\nb\r\nc\r\nd\ne')).toBe('\r\n');
  });

  it('в смешанном файле побеждает тот конец, которого больше', () => {
    expect(detectLineEnding('a\r\nb\r\nc\nd')).toBe('\r\n');
    expect(detectLineEnding('a\nb\nc\r\nd')).toBe('\n');
  });

  it('файл без переводов — запасной вариант', () => {
    expect(detectLineEnding('одна строка')).toBe('\n');
    expect(detectLineEnding('одна строка', '\r\n')).toBe('\r\n');
    expect(detectLineEnding('', '\r\n')).toBe('\r\n');
  });

  it('подпись для статусбара', () => {
    expect(lineEndingLabel('\n')).toBe('LF');
    expect(lineEndingLabel('\r\n')).toBe('CRLF');
  });

  it('запись в LF оставляет текст как есть', () => {
    expect(withLineEndings('a\nb\n', '\n')).toBe('a\nb\n');
  });

  it('запись в CRLF переводит все переводы строк', () => {
    expect(withLineEndings('a\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
  });

  it('запись в CRLF не удваивает уже стоящий `\r`', () => {
    expect(withLineEndings('a\r\nb', '\r\n')).toBe('a\r\nb');
  });

  it('правок нет, когда документ уже в нужном формате', () => {
    expect(lineEndingEdits('a\nb\nc', '\n')).toEqual([]);
    expect(lineEndingEdits('', '\r\n')).toEqual([]);
    expect(lineEndingEdits('строка без перевода', '\r\n')).toEqual([]);
  });

  it('перевод документа в CRLF — правки дают CRLF на выходе', () => {
    const text = 'a\nbb\n\nc';
    const edits = lineEndingEdits(text, '\r\n');
    expect(edits).toHaveLength(3);
    expect(applyTextEdits(text, edits)).toBe('a\r\nbb\r\n\r\nc');
  });

  it('обратный перевод в LF снимает `\r`, пришедший извне', () => {
    const text = 'a\r\nbb\r\n';
    const edits = lineEndingEdits(text, '\n');
    expect(edits).toHaveLength(2);
    expect(applyTextEdits(text, edits)).toBe('a\nbb\n');
  });

  it('повторный выбор того же формата вторых правок не даёт', () => {
    const text = 'a\nb';
    const once = applyTextEdits(text, lineEndingEdits(text, '\r\n'));
    expect(once).toBe('a\r\nb');
    // Документ теперь в CRLF — новых `\r` не вставляем.
    expect(lineEndingEdits(once, '\r\n')).toEqual([]);
  });

  it('снятие `\r` сверяет текст: промах позиции не пройдёт молча', () => {
    const [edit] = lineEndingEdits('a\r\nb', '\n');
    expect(edit?.oldText).toBe('\r');
  });

  it('перевод в обратную сторону возвращает исходный текст', () => {
    const text = 'первая\nвторая\n';
    const crlf = applyTextEdits(text, lineEndingEdits(text, '\r\n'));
    expect(applyTextEdits(crlf, lineEndingEdits(crlf, '\n'))).toBe(text);
  });
});
