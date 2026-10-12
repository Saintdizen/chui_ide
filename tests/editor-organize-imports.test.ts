import { describe, expect, it, vi } from 'vitest';
import { LspFeatures } from '../src/renderer/editor/host/lsp-features';
import type { RpcClient } from '../src/renderer/core/rpc';

/**
 * Упорядочивание импортов через мост к языковому серверу. Проверяем запрос: он уходит
 * как `textDocument/codeAction` с контекстом, сужённым до `source.organizeImports`,
 * а диапазон — это весь документ (конец передаёт вызывающий).
 */

function recordingRpc(answer: unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    request: vi.fn(async (_channel: string, payload: { method: string; params: unknown }) => {
      calls.push({ method: payload.method, params: payload.params });
      return answer;
    }),
  } as unknown as RpcClient;
  return { rpc, calls };
}

describe('LspFeatures.organizeImports', () => {
  it('просит действие source.organizeImports на весь документ', async () => {
    const { rpc, calls } = recordingRpc([
      {
        title: 'Organize Imports',
        kind: 'source.organizeImports',
        edit: {
          changes: {
            'file:///p/a.py': [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: '' },
            ],
          },
        },
      },
    ]);
    const features = new LspFeatures(rpc);

    const actions = await features.organizeImports('/p/a.py', { line: 30, column: 1 });

    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toBe('Organize Imports');
    expect(actions[0]!.edits?.[0]?.path).toBe('/p/a.py');

    const call = calls[0]!;
    expect(call.method).toBe('textDocument/codeAction');
    // Диапазон — с начала и до конца документа (конец 1-based переведён в 0-based).
    expect((call.params as { range: unknown }).range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 29, character: 0 },
    });
    expect((call.params as { context: { only: string[] } }).context.only).toEqual(['source.organizeImports']);
  });

  it('пустой ответ — пустой список, а не ошибка', async () => {
    const { rpc } = recordingRpc(null);
    const features = new LspFeatures(rpc);
    await expect(features.organizeImports('/p/a.py', { line: 1, column: 1 })).resolves.toEqual([]);
  });
});
