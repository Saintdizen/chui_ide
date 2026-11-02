import { describe, expect, it, vi } from 'vitest';
import { codebaseSearch, searchDocs } from '../src/main/ai/agent-code';
import type { ToolContext } from '../src/main/ai/tool-context';

/**
 * Поиск по коду и документации для модели (`main/ai/agent-code.ts`).
 *
 * Три решения, которые проверяются, видны человеку в ответе агента:
 * - отказ сервера символов не отменяет поиск: символы — уточнение, а не условие;
 * - запрос словами («read file») ищется по склеенной форме (`readFile`), иначе по
 *   словам не находится ничего;
 * - пути отдаются ОТНОСИТЕЛЬНО рабочей папки, иначе модель видит длинный абсолютный
 *   путь и не понимает, что файл рядом.
 */

function makeContext(options: { symbols?: boolean; symbolError?: boolean; hits?: number } = {}) {
  const searchCalls: unknown[] = [];
  const ctx = {
    workspace: {
      rootPath: () => '/proj',
      search: vi.fn(async (params: unknown) => {
        searchCalls.push(params);
        const count = options.hits ?? 1;
        return {
          hits: Array.from({ length: count }, (_, index) => ({
            path: `/proj/src/file${index}.ts`,
            line: index + 1,
            text: `строка ${index}`,
          })),
          scanned: 12,
          truncated: false,
        };
      }),
    },
    symbols: options.symbols
      ? {
          projectSymbols: vi.fn(async () => {
            if (options.symbolError) throw new Error('нет сервера');
            return [
              { name: 'readFile', kind: 'function', path: '/proj/src/io.ts', line: 4, column: 1 },
              { name: 'unrelated', kind: 'function', path: '/proj/src/x.ts', line: 9, column: 1 },
            ];
          }),
        }
      : undefined,
    signal: undefined,
  } as unknown as ToolContext;
  return { ctx, searchCalls };
}

describe('поиск по коду', () => {
  it('без запроса инструмент падает на разборе аргументов', async () => {
    const { ctx } = makeContext();

    await expect(codebaseSearch(ctx, {})).rejects.toThrow('query');
  });

  it('текстовый поиск идёт по СКЛЕЕННОЙ форме запроса', async () => {
    // «read file» по словам не найдёт `readFile`: пробелы ломают совпадение.
    const { ctx, searchCalls } = makeContext();

    await codebaseSearch(ctx, { query: 'read file' });

    expect((searchCalls[0] as { query: string }).query).toBe('readfile');
  });

  it('пути в ответе относительные, а не абсолютные', async () => {
    const { ctx } = makeContext({ symbols: true });

    const outcome = await codebaseSearch(ctx, { query: 'readFile' });

    expect(outcome.detail).toContain('src/file0.ts');
    expect(outcome.detail).not.toContain('/proj/src/file0.ts');
  });

  it('символы из сервера попадают в ответ с путём объявления', async () => {
    // Точное объявление полезнее совпадения в комментарии.
    const { ctx } = makeContext({ symbols: true });

    const outcome = await codebaseSearch(ctx, { query: 'readFile' });

    expect(outcome.detail).toContain('src/io.ts');
  });

  it('сервер символов отказал — поиск текстом всё равно выполнен', async () => {
    // Символы — уточнение, а не условие: отказ не должен отменять поиск.
    const { ctx } = makeContext({ symbols: true, symbolError: true });

    const outcome = await codebaseSearch(ctx, { query: 'readFile' });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('src/file0.ts');
  });

  it('без сервера символов поиск тоже работает', async () => {
    const { ctx } = makeContext({ symbols: false });

    const outcome = await codebaseSearch(ctx, { query: 'foo' });

    expect(outcome.ok).toBe(true);
    expect(outcome.summary.length).toBeGreaterThan(0);
  });

  it('ничего не найдено — честный пустой ответ, а не ошибка', async () => {
    const { ctx } = makeContext({ hits: 0 });

    const outcome = await codebaseSearch(ctx, { query: 'нетакого' });

    expect(outcome.ok).toBe(true);
  });
});

describe('поиск по документации', () => {
  it('без запроса инструмент падает на разборе аргументов', async () => {
    const { ctx } = makeContext();

    await expect(searchDocs(ctx, {})).rejects.toThrow('query');
  });

  it('ищет в документации и отдаёт путь с заголовком', async () => {
    const ctx = {
      workspace: {
        rootPath: () => '/proj',
        // Форма ответа: `hits` с выдержками, `files` и `chunks` — счётчики просмотра.
        searchDocs: vi.fn(async () => ({
          query: 'установка',
          hits: [{ path: '/proj/docs/setup.md', heading: 'Установка', line: 12, snippet: 'шаги' }],
          files: 5,
          chunks: 8,
        })),
      },
    } as unknown as ToolContext;

    const outcome = await searchDocs(ctx, { query: 'установка' });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('docs/setup.md');
    expect(outcome.detail).toContain('Установка');
  });

  it('ничего не нашлось — пустой ответ, а не ошибка', async () => {
    const ctx = {
      workspace: {
        rootPath: () => '/proj',
        searchDocs: vi.fn(async () => ({ query: 'нетакого', hits: [], files: 3, chunks: 4 })),
      },
    } as unknown as ToolContext;

    const outcome = await searchDocs(ctx, { query: 'нетакого' });

    expect(outcome.ok).toBe(true);
  });
});
