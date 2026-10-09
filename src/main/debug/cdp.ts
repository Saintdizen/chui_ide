/**
 * Клиент Chrome DevTools Protocol поверх встроенного WebSocket.
 *
 * Node Inspector — то, что открывает `node --inspect-brk`, — говорит на CDP, а не
 * на DAP. Сообщения это JSON: запрос `{id, method, params}`, ответ `{id, result}`
 * или `{id, error}`, событие `{method, params}`.
 *
 * Встроенный `WebSocket` есть и в Node 22+, и в Electron (Node 24), поэтому своей
 * реализации RFC6455 не нужно и зависимость `ws` не нужна. Тип берём структурно
 * через `globalThis`: так код не зависит от lib.dom и от точных типов @types/node.
 */

/** Минимум, который нам нужен от WebSocket: отправка, закрытие и четыре события. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** Конструктор берём из глобального объекта: в рантайме он есть, в наших lib — нет. */
function openSocket(url: string): WebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!ctor) throw new Error('В этом рантайме нет встроенного WebSocket');
  return new ctor(url);
}

type CdpListener = (params: Record<string, unknown>) => void;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private readonly closeListeners = new Set<() => void>();
  private tornDown = false;

  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.teardown('Отладчик закрыл CDP-соединение'));
    socket.addEventListener('error', () => this.teardown('Ошибка CDP-соединения'));
  }

  /** Открыть соединение с эндпоинтом `ws://…`, который Node публикует при `--inspect`. */
  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = openSocket(url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const connection = new CdpConnection(socket);
      const timer = setTimeout(() => {
        connection.close();
        reject(new Error('Отладчик не открыл CDP-канал вовремя'));
      }, timeoutMs);
      connection.onClose(() => {
        clearTimeout(timer);
        reject(new Error('Не удалось подключиться к отладчику'));
      });
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(connection);
      });
    });
  }

  /** Запрос к CDP. Ошибка в ответе и разрыв соединения — отклонённый промис. */
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.tornDown) return Promise.reject(new Error('CDP-соединение закрыто'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Подписка на событие CDP. Возвращает функцию отписки. */
  on(method: string, listener: CdpListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  get closed(): boolean {
    return this.tornDown;
  }

  close(): void {
    if (this.tornDown) return;
    try {
      this.socket.close();
    } catch {
      // уже закрыт
    }
    this.teardown('CDP-соединение закрыто');
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return; // обрывок кадра — пропускаем
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP-запрос завершился ошибкой'));
      else pending.resolve(message.result ?? {});
      return;
    }

    if (typeof message.method === 'string') {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    }
  }

  private teardown(reason: string): void {
    if (this.tornDown) return;
    this.tornDown = true;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
  }
}
