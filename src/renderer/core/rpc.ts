import {
  RpcErrorCode,
  type MethodName,
  type ParamsOf,
  type PushMessage,
  type ResultOf,
  type RpcCall,
  type RpcResult,
} from '../../shared/api';
import type { ChuiBridge } from '../../shared/bridge';
import { Emitter } from './events';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  get cancelled(): boolean {
    return this.code === RpcErrorCode.Cancelled;
  }
}

/**
 * Клиент контракта из shared/api.ts: типы метода, аргументов и результата
 * выводятся из имени, поэтому опечатка в имени метода — ошибка компиляции.
 *
 * Здесь же живёт стриминг: события приходят внутри конкретного вызова,
 * потому что идентификатор запроса генерирует эта сторона.
 */
export class RpcClient {
  private sequence = 0;
  private activeStreamId: string | null = null;
  private readonly streams = new Map<string, (event: string, payload: unknown) => void>();
  private readonly pushListeners = new Set<(message: PushMessage) => void>();

  private readonly streamingEmitter = new Emitter<boolean>();
  /** true, пока выполняется вызов со стримингом — статусбар показывает это состояние. */
  readonly onDidChangeStreaming = this.streamingEmitter.event;

  constructor(private readonly bridge: ChuiBridge = window.chui) {
    bridge.onRpcEvent((message) => this.streams.get(message.id)?.(message.event, message.payload));
    bridge.onPush((message) => {
      for (const listener of [...this.pushListeners]) listener(message);
    });
  }

  onPush(listener: (message: PushMessage) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  async request<M extends MethodName>(method: M, params?: ParamsOf<M>): Promise<ResultOf<M>> {
    const call: RpcCall = { id: this.nextId(), method, params };
    return unwrap<M>(await this.bridge.call(call));
  }

  /** Долгий вызов с промежуточными событиями. Отменяется через `cancelActive`. */
  async stream<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    onEvent: (event: string, payload: unknown) => void,
  ): Promise<ResultOf<M>> {
    const call: RpcCall = { id: this.nextId(), method, params };
    this.streams.set(call.id, onEvent);
    this.activeStreamId = call.id;
    this.streamingEmitter.fire(true);
    try {
      return unwrap<M>(await this.bridge.call(call));
    } finally {
      this.streams.delete(call.id);
      if (this.activeStreamId === call.id) this.activeStreamId = null;
      this.streamingEmitter.fire(false);
    }
  }

  cancelActive(): boolean {
    if (!this.activeStreamId) return false;
    void this.bridge.cancel(this.activeStreamId);
    return true;
  }

  get isStreaming(): boolean {
    return this.activeStreamId !== null;
  }

  private nextId(): string {
    this.sequence += 1;
    return `r${this.sequence.toString(36)}-${Date.now().toString(36)}`;
  }
}

function unwrap<M extends MethodName>(result: RpcResult): ResultOf<M> {
  if (!result.ok) throw new RpcError(result.error.code, result.error.message, result.error.details);
  return result.value as ResultOf<M>;
}
