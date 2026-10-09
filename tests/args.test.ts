import { describe, expect, it } from 'vitest';
import { formatArguments, parseArguments } from '../src/shared/args';

/**
 * Разбор строки аргументов: то, что человек набирает в диалоге запуска.
 * Правило то же, что у оболочки, — пробел разделяет, кавычки сохраняют.
 */
describe('parseArguments', () => {
  it('пустая строка и одни пробелы — нет аргументов', () => {
    expect(parseArguments('')).toEqual([]);
    expect(parseArguments('   ')).toEqual([]);
  });

  it('разделяет по пробелам', () => {
    expect(parseArguments('--port 8080 --verbose')).toEqual(['--port', '8080', '--verbose']);
  });

  it('лишние пробелы не создают пустых аргументов', () => {
    expect(parseArguments('  a    b  ')).toEqual(['a', 'b']);
  });

  it('двойные кавычки сохраняют пробелы внутри', () => {
    expect(parseArguments('--name "my file.txt"')).toEqual(['--name', 'my file.txt']);
  });

  it('одинарные кавычки берут символы как есть', () => {
    // В одинарных кавычках экранирования нет: `\n` остаётся двумя символами.
    expect(parseArguments("--msg 'hello \\n world'")).toEqual(['--msg', 'hello \\n world']);
  });

  it('экранирование внутри двойных кавычек', () => {
    expect(parseArguments('--q "a \\"b\\" c"')).toEqual(['--q', 'a "b" c']);
    expect(parseArguments('--path "c:\\\\temp"')).toEqual(['--path', 'c:\\temp']);
  });

  it('пустой аргумент из пары кавычек сохраняется', () => {
    expect(parseArguments('--x ""')).toEqual(['--x', '']);
  });

  it('незакрытая кавычка — берём набранное', () => {
    expect(parseArguments('--name "unterminated')).toEqual(['--name', 'unterminated']);
  });
});

/**
 * Обратная сборка: то, что диалог показывает человеку при повторном открытии.
 * Главное — чтобы строка снова разобралась в те же аргументы.
 */
describe('formatArguments', () => {
  it('простые аргументы печатаются без кавычек', () => {
    expect(formatArguments(['--port', '8080', '--verbose'])).toBe('--port 8080 --verbose');
  });

  it('аргумент с пробелом закавычивается', () => {
    expect(formatArguments(['--name', 'my file.txt'])).toBe('--name "my file.txt"');
  });

  it('пустой аргумент сохраняется кавычками', () => {
    expect(formatArguments(['--x', ''])).toBe('--x ""');
  });

  it('кавычки и слэши внутри экранируются', () => {
    expect(formatArguments(['a"b'])).toBe('"a\\"b"');
    expect(formatArguments(['c:\\temp'])).toBe('"c:\\\\temp"');
  });

  it('пустой список — пустая строка', () => {
    expect(formatArguments([])).toBe('');
  });

  it('сборка и разбор обратны для сложных случаев', () => {
    const args = ['--name', 'my file.txt', '', 'a"b', 'c:\\dir'];
    expect(parseArguments(formatArguments(args))).toEqual(args);
  });
});
