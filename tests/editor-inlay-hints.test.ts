import { describe, expect, it, vi } from 'vitest';
import { LspFeatures } from '../src/renderer/editor/host/lsp-features';
import type { RpcClient } from '../src/renderer/core/rpc';

/**
 * Подсказки-вставки через мост к языковому серверу. Проверяем запрос: он уходит как
 * `textDocument/inlayHint` с диапазоном на весь документ, а ответ разбирается в наши
 * подсказки (позиции 0-based → 1-based).
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

describe('LspFeatures.inlayHints', () => {
  it('просит подсказки на весь документ и переводит позиции', async () => {
    const { rpc, calls } = recordingRpc([
      { position: { line: 2, character: 5 }, label: ': str', kind: 1 },
      { position: { line: 4, character: 1 }, label: 'name:', kind: 2 },
    ]);
    const features = new LspFeatures(rpc);

    const hints = await features.inlayHints('/p/a.py', { line: 10, column: 1 });

    expect(hints).toEqual([
      { line: 3, column: 6, label: ': str', kind: 'type' },
      { line: 5, column: 2, label: 'name:', kind: 'parameter' },
    ]);
    const call = calls[0]!;
    expect(call.method).toBe('textDocument/inlayHint');
    expect((call.params as { range: unknown }).range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 9, character: 0 },
    });
  });

  it('пустой ответ — пустой список', async () => {
    const { rpc } = recordingRpc(null);
    const features = new LspFeatures(rpc);
    await expect(features.inlayHints('/p/a.py', { line: 1, column: 1 })).resolves.toEqual([]);
  });
});
