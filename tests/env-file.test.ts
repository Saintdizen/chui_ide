import { describe, expect, it } from 'vitest';
import { parseEnvEntries, parseEnvFile } from '../src/shared/env-file';

describe('parseEnvFile', () => {
  it('простые пары ключ-значение', () => {
    expect(parseEnvFile('HOST=localhost\nPORT=8080')).toEqual({ HOST: 'localhost', PORT: '8080' });
  });

  it('комментарии и пустые строки пропускаются', () => {
    expect(parseEnvFile('# комментарий\n\nA=1\n   \n')).toEqual({ A: '1' });
  });

  it('префикс export и лишние пробелы', () => {
    expect(parseEnvFile('export TOKEN = abc ')).toEqual({ TOKEN: 'abc' });
  });

  it('двойные кавычки: экранирование раскрывается', () => {
    expect(parseEnvFile('A="line1\\nline2"')).toEqual({ A: 'line1\nline2' });
  });

  it('одинарные кавычки: значение берётся дословно', () => {
    expect(parseEnvFile("A='a # b'")).toEqual({ A: 'a # b' });
  });

  it('без кавычек хвостовой комментарий отрезается', () => {
    expect(parseEnvFile('PORT=8080 # dev')).toEqual({ PORT: '8080' });
  });

  it('повтор ключа — побеждает последний', () => {
    expect(parseEnvFile('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('некорректные ключи пропускаются', () => {
    expect(parseEnvFile('1BAD=x\nGOOD=y\n=z')).toEqual({ GOOD: 'y' });
  });

  it('многострочное значение в кавычках собирается целиком', () => {
    expect(parseEnvFile('KEY="line1\nline2"')).toEqual({ KEY: 'line1\nline2' });
  });
});

describe('parseEnvEntries', () => {
  it('сохраняет номер строки и порядок', () => {
    const entries = parseEnvEntries('# c\nA=1\nB=2');
    expect(entries.map((entry) => [entry.key, entry.line])).toEqual([
      ['A', 2],
      ['B', 3],
    ]);
  });
});

describe('экранирование и кавычки: крайние случаи', () => {
  it('раскрываются \\r и \\t, а не только \\n', () => {
    expect(parseEnvFile('A="a\\rb"')).toEqual({ A: 'a\rb' });
    expect(parseEnvFile('A="a\\tb"')).toEqual({ A: 'a\tb' });
  });

  it('обратный слэш в значении сохраняется', () => {
    expect(parseEnvFile('A="a\\\\b"')).toEqual({ A: 'a\\b' });
  });

  it('экранированная кавычка не закрывает значение', () => {
    expect(parseEnvFile('A="a\\"b"')).toEqual({ A: 'a"b' });
  });

  it('хвост после закрывающей кавычки отбрасывается', () => {
    expect(parseEnvFile('A="ab"c')).toEqual({ A: 'ab' });
  });

  it('закрывающая кавычка ищется с учётом экранирования', () => {
    expect(parseEnvFile('A="a"\\"')).toEqual({ A: 'a' });
  });

  it('незакрытая кавычка берётся до конца строки', () => {
    expect(parseEnvFile('A="unterminated')).toEqual({ A: 'unterminated' });
    expect(parseEnvFile("A='unterminated")).toEqual({ A: 'unterminated' });
  });
});
