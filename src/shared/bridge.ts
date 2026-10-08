import type { PushMessage, RpcCall, RpcEventMessage, RpcResult } from './api';

/**
 * Форма моста, который preload кладёт в `window.chui`.
 * Renderer знает только этот интерфейс — ни Node, ни electron в него не протекают.
 */
export interface ChuiBridge {
  readonly platform: string;
  readonly versions: { electron: string; chrome: string; node: string };
  /** Отправить запрос и дождаться результата. Идентификатор задаёт вызывающий: он нужен для отмены и стрима. */
  call(call: RpcCall): Promise<RpcResult>;
  /** Прервать выполняющийся вызов по его идентификатору. */
  cancel(id: string): Promise<boolean>;
  onRpcEvent(listener: (message: RpcEventMessage) => void): number;
  onPush(listener: (message: PushMessage) => void): number;
  off(listenerId: number): void;
}

export const BRIDGE_KEY = 'chui';

declare global {
  interface Window {
    chui: ChuiBridge;
  }
}
