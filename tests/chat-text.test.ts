import { describe, expect, it } from 'vitest';
import type { FileEdit } from '../src/shared/edits';
import { countLines, fileWord, formatBytes, plural, snippetFor, titleFrom } from '../src/renderer/ui/chat-text';

describe('plural', () => {
  it('формы 1 / 2–4 / 5+', () => {
    expect(plural(1, 'файл', 'файла', 'файлов')).toBe('файл');
    expect(plural(2, 'файл', 'файла', 'файлов')).toBe('файла');
    expect(plural(5, 'файл', 'файла', 'файлов')).toBe('файлов');
  });

  it('исключения 11–14 всегда «много»', () => {
    expect(plural(11, 'файл', 'файла', 'файлов')).toBe('файлов');
    expect(plural(12, 'файл', 'файла', 'файлов')).toBe('файлов');
    expect(plural(114, 'файл', 'файла', 'файлов')).toBe('файлов');
  });

  it('21 — снова «один»', () => {
    expect(plural(21, 'файл', 'файла', 'файлов')).toBe('файл');
    expect(plural(22, 'файл', 'файла', 'файлов')).toBe('файла');
  });
});

describe('fileWord', () => {
  it('подставляет правильную форму', () => {
    expect(fileWord(1)).toBe('файл');
    expect(fileWord(3)).toBe('файла');
    expect(fileWord(10)).toBe('файлов');
  });
});

describe('formatBytes', () => {
  it('байты', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(1023)).toBe('1023 Б');
  });

  it('килобайты', () => {
    expect(formatBytes(1024)).toBe('1 КБ');
    expect(formatBytes(1536)).toBe('2 КБ');
  });

  it('мегабайты', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 МБ');
    expect(formatBytes(2516582)).toBe('2.4 МБ');
  });
});

describe('titleFrom', () => {
  it('пустой текст → «Новая беседа»', () => {
    expect(titleFrom('')).toBe('Новая беседа');
    expect(titleFrom('   \n  ')).toBe('Новая беседа');
  });

  it('схлопывает пробелы и переносы', () => {
    expect(titleFrom('привет\n\n  мир')).toBe('привет мир');
  });

  it('короткий текст остаётся целиком', () => {
    expect(titleFrom('кратко')).toBe('кратко');
  });

  it('длинный текст обрезается до 24 символов с многоточием', () => {
    const long = 'очень длинный заголовок беседы, который не поместится';
    const result = titleFrom(long);
    expect(result).toHaveLength(24);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('countLines', () => {
  const edits: FileEdit[] = [
    {
      path: '/p/a.ts',
      edits: [
        // Замена одной строки на одну.
        { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5, newText: 'new' },
        // Замена одной строки на три.
        { startLine: 3, startColumn: 1, endLine: 3, endColumn: 2, newText: 'a\nb\nc' },
      ],
    },
    {
      path: '/p/b.ts',
      edits: [{ startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, newText: '' }],
    },
  ];

  it('считает добавленные и убранные строки', () => {
    expect(countLines(edits, '/p/a.ts')).toEqual({ added: 4, removed: 2 });
  });

  it('пустой newText — не добавляет строк, но убирает', () => {
    expect(countLines(edits, '/p/b.ts')).toEqual({ added: 0, removed: 2 });
  });

  it('неизвестный файл → нули', () => {
    expect(countLines(edits, '/p/none.ts')).toEqual({ added: 0, removed: 0 });
  });
});

describe('snippetFor', () => {
  it('не найдено → null', () => {
    expect(snippetFor('привет мир', 'нет')).toBeNull();
  });

  it('регистр не важен', () => {
    expect(snippetFor('Hello World', 'WORLD')).toContain('World');
  });

  it('возвращает окрестность совпадения', () => {
    const text = 'а'.repeat(100) + 'ИСКОМОЕ' + 'б'.repeat(100);
    const snippet = snippetFor(text, 'искомое');
    expect(snippet).toContain('ИСКОМОЕ');
    expect(snippet!.length).toBeLessThan(text.length);
  });

  it('переносы строк схлопываются в пробел', () => {
    expect(snippetFor('ИСКОМОЕ\n\nдальше', 'искомое')).toBe('ИСКОМОЕ дальше');
  });
});
