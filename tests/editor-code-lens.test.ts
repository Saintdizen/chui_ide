import { describe, expect, it, vi } from 'vitest';
import { LspFeatures } from '../src/renderer/editor/host/lsp-features';
import type { RpcClient } from '../src/renderer/core/rpc';

/**
 * Код-линзы через мост к языковому серверу. Проверяем не разбор (он закреплён в
 * `lsp-code-lens.test.ts`), а поведение запроса: готовая линза уходит как есть, а
 * линза без команды доводится через `codeLens/resolve` — и если сервер её так и не
 * доделал, показывать нечего.
 */

/** Подставной rpc: отвечает по имени метода LSP, а не одним значением — их тут два. */
function routingRpc(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    request: vi.fn(async (_channel: string, payload: { method: string; params: unknown }) => {
      calls.push({ method: payload.method, params: payload.params });
      return answers[payload.method] ?? null;
    }),
  } as unknown as RpcClient;
  return { rpc, calls };
}

const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } };

describe('LspFeatures.codeLenses', () => {
  it('линза с готовой командой отдаётся как есть, без второго запроса', async () => {
    const { rpc, calls } = routingRpc({
      'textDocument/codeLens': [{ range, command: { title: '3 ссылки', command: 'showRefs', arguments: [] } }],
    });
    const features = new LspFeatures(rpc);

    const lenses = await features.codeLenses('/p/a.py');

    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.command?.title).toBe('3 ссылки');
    expect(calls.map((call) => call.method)).toEqual(['textDocument/codeLens']);
  });

  it('линзу без команды доводит через codeLens/resolve, отправляя исходный объект целиком', async () => {
    const { rpc, calls } = routingRpc({
      'textDocument/codeLens': [{ range, data: { id: 7 } }],
      'codeLens/resolve': { range, command: { title: 'Запустить тест', command: 'run', arguments: [] } },
    });
    const features = new LspFeatures(rpc);

    const lenses = await features.codeLenses('/p/a.py');

    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.command?.title).toBe('Запустить тест');
    expect(calls.map((call) => call.method)).toEqual(['textDocument/codeLens', 'codeLens/resolve']);
    // В resolve уходит сырой объект линзы: сервер держит в нём своё `data`.
    expect(calls[1]!.params).toEqual({ range, data: { id: 7 } });
  });

  it('линза, которую resolve не доделал, не показывается', async () => {
    const { rpc } = routingRpc({
      'textDocument/codeLens': [{ range, data: {} }],
      // Ответ без команды — показывать нечего.
      'codeLens/resolve': { range },
    });
    const features = new LspFeatures(rpc);

    await expect(features.codeLenses('/p/a.py')).resolves.toEqual([]);
  });

  it('пустой ответ сервера — пустой список, а не ошибка', async () => {
    const { rpc } = routingRpc({ 'textDocument/codeLens': null });
    const features = new LspFeatures(rpc);

    await expect(features.codeLenses('/p/a.py')).resolves.toEqual([]);
  });
});
