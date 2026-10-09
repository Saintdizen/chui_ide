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
