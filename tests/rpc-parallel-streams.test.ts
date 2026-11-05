import { describe, expect, it } from 'vitest';
import { RpcClient } from '../src/renderer/core/rpc';
import { RPC_EVENT_END, type RpcCall, type RpcEventMessage, type RpcResult } from '../src/shared/api';
import type { ChuiBridge } from '../src/shared/bridge';

/**
 * Два прогона одновременно.
 *
 * Пока прогон один, `cancelActive` и флаг «стрим идёт» — правда. Со второй
 * беседой оба врут: кнопка «стоп» в одной задаче гасит другую (потому что
 * последним открылся не тот поток), а статус гаснет, как только кончился
 * первый, — и человек видит «свободно» при живой работе.
 */

interface FakeBridge {
  bridge: ChuiBridge;
  /** Закрыть один вызов так, как это делает main, — с меткой конца. */
  finish(id: string, value: unknown): void;
  cancelled: string[];
  calls: RpcCall[];
}

function makeBridge(): FakeBridge {
  const listeners = new Map<number, (message: RpcEventMessage) => void>();
  const pending = new Map<string, (value: RpcResult) => void>();
  const cancelled: string[] = [];
  const calls: RpcCall[] = [];
  let seq = 0;
  const send = (message: RpcEventMessage): void => {
    for (const listener of [...listeners.values()]) listener(message);
  };
  const bridge = {
    platform: 'linux',
    versions: { electron: '', chrome: '', node: '' },
    call(call: RpcCall): Promise<RpcResult> {
      calls.push(call);
      return new Promise((resolve) => pending.set(call.id, resolve));
    },
    cancel: async (id: string) => {
      cancelled.push(id);
      return true;
    },
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

  const finish = (id: string, value: unknown): void => {
    send({ id, event: RPC_EVENT_END, payload: null });
    pending.get(id)?.({ id, ok: true, value });
  };
  return { bridge, finish, cancelled, calls };
}

const params = { providerId: 'p', model: 'm', messages: [] };

describe('openStream: у каждого прогона своя ручка', () => {
  it('стоп одной беседы не гасит вторую', async () => {
    const { bridge, finish, cancelled, calls } = makeBridge();
    const rpc = new RpcClient(bridge);

    const first = rpc.openStream('ai.chat', params, () => undefined);
    const second = rpc.openStream('ai.chat', params, () => undefined);
    await Promise.resolve();

    expect(first.cancel()).toBe(true);
    expect(cancelled).toEqual([first.id]);
    expect(cancelled).not.toContain(second.id);

    finish(first.id, 'готово');
    finish(second.id, 'готово');
    expect(await first.result).toBe('готово');
    expect(await second.result).toBe('готово');
    expect(calls).toHaveLength(2);
  });

  it('отмена уже закрытого потока — false, а не исключение', async () => {
    const { bridge, finish } = makeBridge();
    const rpc = new RpcClient(bridge);
    const handle = rpc.openStream('ai.chat', params, () => undefined);
    await Promise.resolve();
    finish(handle.id, 'ok');
    await handle.result;
    expect(handle.cancel()).toBe(false);
  });
});

describe('стрим идёт, пока открыт хоть один', () => {
  it('гаснет только после последнего прогона', async () => {
    const { bridge, finish } = makeBridge();
    const rpc = new RpcClient(bridge);
    const seen: boolean[] = [];
    rpc.onDidChangeStreaming((value) => seen.push(value));

    const first = rpc.openStream('ai.chat', params, () => undefined);
    const second = rpc.openStream('ai.chat', params, () => undefined);
    await Promise.resolve();
    expect(rpc.isStreaming).toBe(true);

    finish(first.id, 'ok');
    await first.result;
    // Первый кончился — второй работает, значит стрим всё ещё идёт.
    expect(rpc.isStreaming).toBe(true);

    finish(second.id, 'ok');
    await second.result;
    expect(rpc.isStreaming).toBe(false);

    // По одному сообщению на границу: «началось» и «кончилось», без лишних.
    expect(seen).toEqual([true, false]);
  });
});
