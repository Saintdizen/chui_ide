import { describe, expect, it } from 'vitest';
import { bodyText, languageOfSnippetFile, prefixText, snippetsFromCodeSnippets } from '../src/shared/code-snippets';

/**
 * Сниппеты чужого проекта. Формат почти наш, но с двумя отличиями, которые и
 * ловили бы людей при импорте: `body` бывает массивом строк, а язык лежит в
 * имени файла.
 */
describe('languageOfSnippetFile', () => {
  it('язык из имени', () => {
    expect(languageOfSnippetFile('python.code-snippets')).toBe('python');
  });

  it('путь до файла не мешает', () => {
    expect(languageOfSnippetFile('/p/.vscode/go.code-snippets')).toBe('go');
  });

  it('своё имя — не язык', () => {
    expect(languageOfSnippetFile('my-helpers.code-snippets')).toBeNull();
  });

  it('чужое расширение — не сниппеты', () => {
    expect(languageOfSnippetFile('python.json')).toBeNull();
  });
});

describe('bodyText', () => {
  it('строка как есть', () => {
    expect(bodyText('console.log($1)')).toBe('console.log($1)');
  });

  it('массив склеивается через перевод строки, а не встык', () => {
    expect(bodyText(['if (x) {', '  $0', '}'])).toBe('if (x) {\n  $0\n}');
  });

  it('ничего не пришло — пусто', () => {
    expect(bodyText(undefined)).toBe('');
    expect(bodyText(42)).toBe('');
  });
});

describe('prefixText', () => {
  it('первый из списка триггеров', () => {
    expect(prefixText(['log', 'clg'])).toBe('log');
  });

  it('пустые строки пропускаются', () => {
    expect(prefixText(['', '  ', 'real'])).toBe('real');
  });
});

describe('snippetsFromCodeSnippets', () => {
  const file = `{
    // лог в консоль
    "log": {
      "prefix": "log",
      "body": ["console.log($1);", "$0"],
      "description": "Вывод в консоль",
    },
  }`;

  it('разбирает файл с комментариями и висячей запятой', () => {
    expect(snippetsFromCodeSnippets(file, 'javascript')).toEqual([
      { prefix: 'log', body: 'console.log($1);\n$0', description: 'Вывод в консоль', languages: ['javascript'] },
    ]);
  });

  it('ключ становится триггером, если prefix нет', () => {
    const text = '{"hello": {"body": "print(1)"}}';
    expect(snippetsFromCodeSnippets(text, 'python')[0]).toMatchObject({ prefix: 'hello', languages: ['python'] });
  });

  it('язык из записи сильнее языка файла', () => {
    const text = '{"a": {"prefix": "a", "body": "x", "languages": ["go", "go"]}}';
    expect(snippetsFromCodeSnippets(text, 'python')[0]?.languages).toEqual(['go']);
  });

  it('общий файл без языка — сниппет без languages', () => {
    expect(snippetsFromCodeSnippets('{"a":{"prefix":"a","body":"x"}}', null)[0]?.languages).toBeUndefined();
  });

  it('триггер с пробелом пропускается: его не набрать', () => {
    expect(snippetsFromCodeSnippets('{"a":{"prefix":"a b","body":"x"}}')).toEqual([]);
  });

  it('сниппет без тела пропускается', () => {
    expect(snippetsFromCodeSnippets('{"a":{"prefix":"a","body":"  "}}')).toEqual([]);
  });

  it('битый JSON — пусто, а не падение', () => {
    expect(snippetsFromCodeSnippets('{"a":')).toEqual([]);
  });

  it('несколько сниппетов в файле', () => {
    const text = '{"a":{"prefix":"a","body":"x"},"b":{"prefix":"b","body":"y"}}';
    expect(snippetsFromCodeSnippets(text).map((s) => s.prefix)).toEqual(['a', 'b']);
  });
});
