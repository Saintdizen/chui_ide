import { describe, expect, it, vi } from 'vitest';
import { RpcClient } from '../src/renderer/core/rpc';
import { RPC_EVENT_END, type RpcCall, type RpcEventMessage, type RpcResult } from '../src/shared/api';
import type { ChuiBridge } from '../src/shared/bridge';

/**
 * Конец стрима объявляет main, а не ответ на вызов.
 *
 * Ответ на `invoke` и события вызова идут разными каналами, и порядок между
 * ними не обещан: на живом окне ответ регулярно обгонял последние `delta`.
 * Renderer, который снимает слушателя сразу по ответу, терял хвост событий —
 * в ленте беседы это выглядело как оборванный ответ и вечно крутящаяся карточка
 * вызова. Здесь стережётся именно это: события, пришедшие ПОСЛЕ ответа, доходят.
 */

interface FakeBridge {
  bridge: ChuiBridge;
  /** Отправить событие в renderer так, как это делает main. */
  send(message: RpcEventMessage): void;
  /** Вызовы, которые прошли через мост: по ним видно, помечен ли вызов стримом. */
  calls: RpcCall[];
}

function makeBridge(
  result: () => RpcResult,
  afterCall?: (send: (message: RpcEventMessage) => void) => void,
): FakeBridge {
  const listeners = new Map<number, (message: RpcEventMessage) => void>();
  let seq = 0;
  const calls: RpcCall[] = [];
  const send = (message: RpcEventMessage): void => {
    for (const listener of [...listeners.values()]) listener(message);
  };
  const bridge = {
    platform: 'linux',
    versions: { electron: '', chrome: '', node: '' },
    call(call: RpcCall): Promise<RpcResult> {
      calls.push(call);
      afterCall?.(send);
      return Promise.resolve(result());
    },
    cancel: async () => true,
    onRpcEvent(listener: (message: RpcEventMessage) => void): number {
      seq += 1;
      listeners.set(seq, listener);
      return seq;
    },
    onPush: () => 0,
    onHostRequest: () => 0,
    replyHostRequest: async () => true,
    off(listenerId: number): void {
      listeners.delete(listenerId);
    },
  } as unknown as ChuiBridge;
  return { bridge, send, calls };
}

const okResult = (value: unknown): RpcResult => ({ id: '', ok: true, value });

describe('RpcClient.stream: конец событий объявляет main', () => {
  it('события, пришедшие после ответа, доходят до ленты', async () => {
    const seen: string[] = [];
    // Худший случай, который видно в живом окне: ответ уходит первым, события —
    // следом, и метка конца приходит вместе с ними.
    const { bridge, calls } = makeBridge(
      () => okResult({ text: 'готово' }),
      (send) => {
        setTimeout(() => {
          const id = calls[0]!.id;
          send({ id, event: 'tool_result', payload: { id: 'call_1' } });
          send({ id, event: 'delta', payload: { text: 'готово' } });
          send({ id, event: RPC_EVENT_END, payload: null });
        }, 5);
      },
    );
    const rpc = new RpcClient(bridge);

    const result = await rpc.stream('ai.chat', { providerId: 'p', model: 'm', messages: [] }, (event) =>
      seen.push(event),
    );

    expect(result).toEqual({ text: 'готово' });
    expect(seen).toEqual(['tool_result', 'delta']);
  });

  it('метка конца не попадает в события для панели', async () => {
    const seen: string[] = [];
    const { bridge, calls } = makeBridge(
      () => okResult('ok'),
      (send) => {
        setTimeout(() => {
          const id = calls[0]!.id;
          send({ id, event: RPC_EVENT_END, payload: null });
        }, 0);
      },
    );
    const rpc = new RpcClient(bridge);

    await rpc.stream('ai.chat', { providerId: 'p', model: 'm', messages: [] }, (event) => seen.push(event));

    expect(seen).toEqual([]);
  });

  it('вызов помечен как стрим — иначе main не пришлёт метку', async () => {
    const { bridge, calls } = makeBridge(
      () => okResult('ok'),
      (send) => {
        setTimeout(() => send({ id: calls[0]!.id, event: RPC_EVENT_END, payload: null }), 0);
      },
    );
    const rpc = new RpcClient(bridge);

    await rpc.stream('ai.chat', { providerId: 'p', model: 'm', messages: [] }, () => undefined);
    await rpc.request('git.status');

    expect(calls[0]!.stream).toBe(true);
    // Обычный вызов метку не ждёт и не просит: она нужна только стриму.
    expect(calls[1]!.stream).toBeUndefined();
  });

  it('потерянная метка не держит панель занятой дольше срока', async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = makeBridge(() => okResult('ok'));
      const rpc = new RpcClient(bridge);

      const promise = rpc.stream('ai.chat', { providerId: 'p', model: 'm', messages: [] }, () => undefined);
      await vi.advanceTimersByTimeAsync(1100);

      await expect(promise).resolves.toBe('ok');
      expect(rpc.isStreaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
