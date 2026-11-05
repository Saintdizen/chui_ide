import {
  RPC_EVENT_END,
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
  /** Сколько потоков открыто прямо сейчас: стрим идёт, пока их больше нуля. */
  private openCount = 0;
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
    return this.openStream(method, params, onEvent).result;
  }

  /**
   * То же, но с ручкой на руках: `cancel()` бьёт по ЭТОМУ вызову.
   *
   * `cancelActive` умеет отменять только последний открытый поток. Пока прогон
   * был один, этого хватало; с двумя беседами «стоп» в одной гасил бы другую —
   * или не гасил вовсе, если последним открылся не тот. Поэтому кнопка «стоп»
   * держит ручку своего потока и бьёт ею.
   */
  openStream<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    onEvent: (event: string, payload: unknown) => void,
  ): { result: Promise<ResultOf<M>>; cancel(): boolean; readonly id: string } {
    const call: RpcCall = { id: this.nextId(), method, params, stream: true };
    /** Конец событий объявляет main: ответ на вызов приходит раньше них. */
    let endEvents: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      endEvents = resolve;
    });
    this.streams.set(call.id, (event, payload) => {
      if (event === RPC_EVENT_END) {
        endEvents();
        return;
      }
      onEvent(event, payload);
    });
    this.activeStreamId = call.id;
    this.openCount += 1;
    if (this.openCount === 1) this.streamingEmitter.fire(true);
    const result = (async () => {
      try {
        const answer = await this.bridge.call(call);
        // Ответ и события идут разными каналами, и ответ их обгоняет: без этого
        // ожидания последний `delta` приходил уже после того, как слушатель снят, —
        // и ответ модели обрывался на середине (видно в ленте беседы).
        await waitForEnd(ended);
        return unwrap<M>(answer);
      } finally {
        this.streams.delete(call.id);
        if (this.activeStreamId === call.id) this.activeStreamId = null;
        this.openCount -= 1;
        // Гаснет только когда кончился ПОСЛЕДНИЙ: пока идёт второй прогон,
        // «стрим идёт» — правда, и статусбар обязан это показывать.
        if (this.openCount === 0) this.streamingEmitter.fire(false);
      }
    })();
    return {
      id: call.id,
      result,
      cancel: () => this.cancelStream(call.id),
    };
  }

  cancelActive(): boolean {
    if (!this.activeStreamId) return false;
    return this.cancelStream(this.activeStreamId);
  }

  /** Отменить поток по его id — не спрашивая, последний ли он. */
  cancelStream(id: string): boolean {
    if (!this.streams.has(id)) return false;
    void this.bridge.cancel(id);
    return true;
  }

  get isStreaming(): boolean {
    return this.openCount > 0;
  }

  private nextId(): string {
    this.sequence += 1;
    return `r${this.sequence.toString(36)}-${Date.now().toString(36)}`;
  }
}

/**
 * Сколько ждать метку конца событий после ответа.
 *
 * Метку main отправляет в том же обработчике, что и ответ, поэтому ждать
 * приходится ровно на пересылку. Срок — страховка от зависания панели: без него
 * потерянная метка оставила бы чат «занятым» навсегда, а так он оживает без
 * хвоста событий.
 */
const STREAM_END_TIMEOUT = 1000;

function waitForEnd(ended: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STREAM_END_TIMEOUT);
    void ended.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function unwrap<M extends MethodName>(result: RpcResult): ResultOf<M> {
  if (!result.ok) throw new RpcError(result.error.code, result.error.message, result.error.details);
  return result.value as ResultOf<M>;
}
