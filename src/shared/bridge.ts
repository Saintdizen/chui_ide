import type { HostReply, HostRequest, PushMessage, RpcCall, RpcEventMessage, RpcResult } from './api';

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
  /** Обратный вызов main → renderer: подписаться на запросы хоста. */
  onHostRequest(listener: (request: HostRequest) => void): number;
  /** Ответить на хостовый запрос; без ответа вызов в main никогда не завершится. */
  replyHostRequest(reply: HostReply): Promise<boolean>;
  off(listenerId: number): void;
}

export const BRIDGE_KEY = 'chui';

declare global {
  interface Window {
    chui: ChuiBridge;
  }
}
