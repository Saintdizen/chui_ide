import { describe, expect, it } from 'vitest';
import { completionQuery, parseGotoInput } from '../src/shared/goto-target';

describe('parseGotoInput', () => {
  it('голое число — строка текущего файла', () => {
    expect(parseGotoInput('412')).toEqual({ query: { path: null, line: 412, column: 1 }, error: null });
  });

  it('пустое поле — не ошибка', () => {
    expect(parseGotoInput('')).toEqual({ query: null, error: null });
    expect(parseGotoInput('   ')).toEqual({ query: null, error: null });
  });

  it('файл и строка', () => {
    expect(parseGotoInput('src/main.ts:12')).toEqual({
      query: { path: 'src/main.ts', line: 12, column: 1 },
      error: null,
    });
  });

  it('файл, строка и столбец', () => {
    expect(parseGotoInput('src/main.ts:12:5')).toEqual({
      query: { path: 'src/main.ts', line: 12, column: 5 },
      error: null,
    });
  });

  it('файл без номера — открыть с начала', () => {
    expect(parseGotoInput('src/main.ts')).toEqual({
      query: { path: 'src/main.ts', line: null, column: 1 },
      error: null,
    });
  });

  it('двоеточие диска не путается с разделителем', () => {
    expect(parseGotoInput('C:\\src\\main.ts:12')).toEqual({
      query: { path: 'C:\\src\\main.ts', line: 12, column: 1 },
      error: null,
    });
  });

  it('диск с точкой: C:\\src\\a.ts', () => {
    expect(parseGotoInput('C:\\src\\a.ts:7:3')).toEqual({
      query: { path: 'C:\\src\\a.ts', line: 7, column: 3 },
      error: null,
    });
  });

  it('пробелы по краям не мешают', () => {
    expect(parseGotoInput('  src/a.ts:9  ')).toEqual({ query: { path: 'src/a.ts', line: 9, column: 1 }, error: null });
  });

  it('кавычки по краям снимаются — так путь копируют из логов', () => {
    expect(parseGotoInput('"src/a.ts:9"')).toEqual({ query: { path: 'src/a.ts', line: 9, column: 1 }, error: null });
    expect(parseGotoInput("'src/a.ts'")).toEqual({ query: { path: 'src/a.ts', line: null, column: 1 }, error: null });
  });

  it('строка 0 — опечатка, а не «первая строка»', () => {
    expect(parseGotoInput('a.ts:0')).toEqual({ query: null, error: 'Номер строки — от 1' });
  });

  it('отрицательная строка — тоже опечатка', () => {
    expect(parseGotoInput('a.ts:-3')).toEqual({ query: null, error: 'Номер строки — от 1' });
  });

  it('номер без файла — сказать, что файл не понять', () => {
    expect(parseGotoInput(':12')).toEqual({ query: null, error: 'Не понял, в каком файле искать' });
  });

  it('перевод строки в имени файла — не путь', () => {
    expect(parseGotoInput('a\nb.ts:3')).toEqual({ query: null, error: null });
  });

  it('нечисловой хвост остаётся частью пути', () => {
    expect(parseGotoInput('src/a:b.ts')).toEqual({ query: { path: 'src/a:b.ts', line: null, column: 1 }, error: null });
  });
});

describe('completionQuery', () => {
  it('пусто и число — подсказывать нечем', () => {
    expect(completionQuery('')).toBe('');
    expect(completionQuery('   ')).toBe('');
    expect(completionQuery('12')).toBe('');
  });

  it('путь целиком', () => {
    expect(completionQuery('src/ma')).toBe('src/ma');
  });

  it('числовой хвост отрезается — по нему ищем файл', () => {
    expect(completionQuery('src/main.ts:12')).toBe('src/main.ts');
    expect(completionQuery('src/main.ts:12:5')).toBe('src/main.ts');
  });

  it('двоеточие диска не отрезается', () => {
    expect(completionQuery('C:\\src\\a.ts:12')).toBe('C:\\src\\a.ts');
  });

  it('хвост двоеточия без числа — не отсекается', () => {
    // `C:` может оказаться началом пути `C:\\src`; решать ранжированию.
    expect(completionQuery('C:')).toBe('C:');
  });

  it('нечисловой хвост остаётся в запросе', () => {
    expect(completionQuery('src/a:b')).toBe('src/a:b');
  });
});
