import { describe, expect, it, vi } from 'vitest';
import { hoverText, LspFeatures } from '../src/renderer/editor/host/lsp-features';
import type { RpcClient } from '../src/renderer/core/rpc';

/** Подставной rpc: запоминает запрос, отдаёт заданный ответ или ошибку. */
function fakeRpc(answer: unknown, options: { fail?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (options.fail) throw new Error('нет сервера');
      return answer;
    }),
  } as unknown as RpcClient;
  return { rpc, calls };
}

describe('разбор наведения', () => {
  it('строка — как есть', () => {
    expect(hoverText({ contents: 'def f(): ...' })).toBe('def f(): ...');
  });

  it('MarkupContent берёт значение', () => {
    expect(hoverText({ contents: { kind: 'markdown', value: '`x` — число' } })).toBe('`x` — число');
  });

  it('массив частей склеивается пустой строкой', () => {
    expect(hoverText({ contents: [{ value: 'первое' }, 'второе'] })).toBe('первое\n\nвторое');
  });

  it('пустое и битое — null, а не пустая строка', () => {
    expect(hoverText(null)).toBeNull();
    expect(hoverText({})).toBeNull();
    expect(hoverText({ contents: '' })).toBeNull();
    expect(hoverText({ contents: [] })).toBeNull();
  });
});

describe('LspFeatures', () => {
  it('наведение переводит позицию в 0-based и отдаёт текст', async () => {
    const { rpc, calls } = fakeRpc({ contents: { value: 'подсказка' } });
    const features = new LspFeatures(rpc);

    const text = await features.hover('/p/a.py', { line: 3, column: 5 });
    expect(text).toBe('подсказка');
    expect(calls[0]!.method).toBe('lsp.request');
    const params = calls[0]!.params as { method: string; params: { position: unknown } };
    expect(params.method).toBe('textDocument/hover');
    // Строка 3, столбец 5 (1-based) → 2 и 4 (0-based).
    expect(params.params.position).toEqual({ line: 2, character: 4 });
  });

  it('определение разбирает локации в наши места', async () => {
    const { rpc } = fakeRpc({
      uri: 'file:///p/b.py',
      range: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } },
    });
    const features = new LspFeatures(rpc);
    const locations = await features.definition('/p/a.py', { line: 1, column: 1 });
    expect(locations).toEqual([{ path: '/p/b.py', line: 10, column: 5 }]);
  });

  it('ссылки перечисляются', async () => {
    const { rpc } = fakeRpc([
      { uri: 'file:///p/a.py', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
      { uri: 'file:///p/b.py', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } } },
    ]);
    const features = new LspFeatures(rpc);
    const locations = await features.references('/p/a.py', { line: 1, column: 1 });
    expect(locations.map((item) => item.path)).toEqual(['/p/a.py', '/p/b.py']);
  });

  it('символы файла разбираются в структуру', async () => {
    const { rpc } = fakeRpc([
      {
        name: 'f',
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
      },
    ]);
    const features = new LspFeatures(rpc);
    const symbols = await features.documentSymbols('/p/a.py');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: 'f', kind: 'функция', line: 1 });
  });

  it('подсказки сервера переводятся в элементы списка как внешние', async () => {
    const { rpc, calls } = fakeRpc({ items: [{ label: 'print', kind: 3, insertText: 'print()' }] });
    const features = new LspFeatures(rpc);
    const items = await features.completion('/p/a.py', { line: 2, column: 3 });
    // Кроме полей для показа переносится исходный элемент (`resolve`) —
    // по нему список доводит строку через `completionItem/resolve`.
    expect(items[0]).toMatchObject({ label: 'print', kind: 'external', detail: 'функция', insert: 'print()' });
    expect(items[0]!.resolve).toMatchObject({ label: 'print' });
    const params = calls[0]!.params as { method: string; params: { position: unknown } };
    expect(params.method).toBe('textDocument/completion');
    expect(params.params.position).toEqual({ line: 1, character: 2 });
  });

  it('разметка сниппета от сервера доезжает до элемента', async () => {
    const { rpc } = fakeRpc({ items: [{ label: 'for', insertText: 'for ${1:x} in y:', insertTextFormat: 2 }] });
    const features = new LspFeatures(rpc);
    const items = await features.completion('/p/a.py', { line: 1, column: 1 });
    expect(items[0]!.snippet).toBe('for ${1:x} in y:');
  });

  it('переименование разбирает правки по файлам', async () => {
    const { rpc, calls } = fakeRpc({
      changes: {
        'file:///p/a.py': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'bar' },
        ],
        'file:///p/b.py': [
          { range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }, newText: 'bar' },
        ],
      },
    });
    const features = new LspFeatures(rpc);
    const edits = await features.rename('/p/a.py', { line: 1, column: 1 }, 'bar');
    expect(edits?.map((file) => file.path)).toEqual(['/p/a.py', '/p/b.py']);
    expect(edits?.[0]?.edits[0]).toMatchObject({ startLine: 1, startColumn: 1, newText: 'bar' });
    const params = calls[0]!.params as { method: string; params: { newName: string } };
    expect(params.method).toBe('textDocument/rename');
    expect(params.params.newName).toBe('bar');
  });

  it('переименование без правок — null', async () => {
    const { rpc } = fakeRpc({ changes: {} });
    const features = new LspFeatures(rpc);
    await expect(features.rename('/p/a.py', { line: 1, column: 1 }, 'bar')).resolves.toBeNull();
  });

  it('ошибка сервера не бросает: подсказки просто нет', async () => {
    const { rpc } = fakeRpc(null, { fail: true });
    const features = new LspFeatures(rpc);
    await expect(features.hover('/p/a.py', { line: 1, column: 1 })).resolves.toBeNull();
    await expect(features.definition('/p/a.py', { line: 1, column: 1 })).resolves.toEqual([]);
    await expect(features.documentSymbols('/p/a.py')).resolves.toEqual([]);
    await expect(features.completion('/p/a.py', { line: 1, column: 1 })).resolves.toEqual([]);
    await expect(features.rename('/p/a.py', { line: 1, column: 1 }, 'bar')).resolves.toBeNull();
    await expect(features.semanticTokens('/p/a.py')).resolves.toEqual([]);
    await expect(
      features.inlineValues(
        '/p/a.py',
        { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
        { frameId: 1, line: 1, column: 1 },
      ),
    ).resolves.toEqual([]);
  });

  it('inline-значения спрашивает с контекстом останова', async () => {
    const { rpc, calls } = fakeRpc([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, caseSensitiveLookup: false },
    ]);
    const features = new LspFeatures(rpc);

    const values = await features.inlineValues(
      '/p/a.py',
      { start: { line: 1, column: 1 }, end: { line: 5, column: 1 } },
      { frameId: 7, line: 2, column: 3 },
    );
    expect(values).toHaveLength(1);
    const params = calls[0]!.params as {
      method: string;
      params: {
        context: { frameId: number; stoppedLocation: { range: { start: { line: number; character: number } } } };
      };
    };
    expect(params.method).toBe('textDocument/inlineValue');
    expect(params.params.context.frameId).toBe(7);
    expect(params.params.context.stoppedLocation.range.start).toEqual({ line: 1, character: 2 });
  });

  it('семантические токены спрашивает отдельным методом и отдаёт как есть', async () => {
    const token = { line: 1, startColumn: 1, endColumn: 4, type: 'keyword', modifiers: [] };
    const { rpc, calls } = fakeRpc([token]);
    const features = new LspFeatures(rpc);

    await expect(features.semanticTokens('/p/a.py')).resolves.toEqual([token]);
    expect(calls[0]!.method).toBe('lsp.semanticTokens');
    expect(calls[0]!.params).toEqual({ path: '/p/a.py' });
  });
});
