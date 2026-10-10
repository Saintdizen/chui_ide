import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  RPC_CALL_CHANNEL,
  RPC_CANCEL_CHANNEL,
  RPC_EVENT_CHANNEL,
  RpcErrorCode,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcCall,
  type RpcError,
  type RpcEventMessage,
  type RpcResult,
} from '../../shared/api';

export interface RpcContext {
  /** Идентификатор вызова: тот же, что на стороне renderer. */
  readonly id: string;
  /** Прерывается при вызове `cancel` с этим id. Прокидывается в fetch и в файловые операции. */
  readonly signal: AbortSignal;
  readonly sender: WebContents;
  /** Отправить событие внутри этого вызова (например, `delta` со куском ответа модели). */
  emit(event: string, payload: unknown): void;
}

type ContractHandler<M extends MethodName> = (
  params: ParamsOf<M>,
  ctx: RpcContext,
) => ResultOf<M> | Promise<ResultOf<M>>;

type Runner = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

/** Ошибка с кодом JSON-RPC: попадает в renderer как RpcError, а не как «что-то упало». */
export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

/**
 * Роутер без магии: главный процесс регистрирует методы из таблицы ChuiMethods,
 * а один обработчик `chui:rpc:call` разводит их по имени. Стриминг — это
 * обычные `emit` внутри выполняющегося вызова, отмена — AbortController.
 */
export class RpcRouter {
  private readonly runners = new Map<string, Runner>();
  private readonly running = new Map<string, AbortController>();

  register<M extends MethodName>(method: M, handler: ContractHandler<M>): this {
    this.runners.set(method, handler as unknown as Runner);
    return this;
  }

  attach(): void {
    ipcMain.handle(RPC_CALL_CHANNEL, (event, call: unknown) => this.dispatch(event, call));
    ipcMain.handle(RPC_CANCEL_CHANNEL, (_event, id: unknown) => {
      if (typeof id === 'string') this.running.get(id)?.abort();
      return true;
    });
  }

  private async dispatch(event: IpcMainInvokeEvent, raw: unknown): Promise<RpcResult> {
    // Вызов приходит из renderer'а, то есть снаружи контракта: `RpcCall` — это
    // ожидание, а не гарантия. Мусор в полях разбираем сами, иначе TypeError
    // ушёл бы наружу вместо RpcError — уже мимо try.
    const call = asRpcCall(raw);
    if (!call) {
      return {
        id: '',
        ok: false,
        error: { code: RpcErrorCode.InvalidParams, message: 'Некорректный вызов: нужны строковые id и method' },
      };
    }

    const runner = this.runners.get(call.method);
    if (!runner) {
      return {
        id: call.id,
        ok: false,
        error: { code: RpcErrorCode.MethodNotFound, message: `Неизвестный метод: ${call.method}` },
      };
    }

    const sender = event.sender;
    const controller = new AbortController();
    this.running.set(call.id, controller);

    const ctx: RpcContext = {
      id: call.id,
      signal: controller.signal,
      sender,
      emit: (name, payload) => {
        if (sender.isDestroyed()) return;
        const message: RpcEventMessage = { id: call.id, event: name, payload };
        sender.send(RPC_EVENT_CHANNEL, message);
      },
    };

    try {
      const value = await runner(call.params, ctx);
      return { id: call.id, ok: true, value };
    } catch (error) {
      return { id: call.id, ok: false, error: toRpcError(error) };
    } finally {
      // Снимаем только свою запись: с тем же id может идти другой вызов, и снести
      // его controller — значит оставить этот вызов без отмены.
      if (this.running.get(call.id) === controller) this.running.delete(call.id);
    }
  }
}

/** Проверка того, что пришло по каналу: без неё мусор в полях — это TypeError. */
function asRpcCall(value: unknown): RpcCall | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, method } = value as Partial<RpcCall>;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof method !== 'string' || method === '') return null;
  return value as RpcCall;
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcFailure) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: RpcErrorCode.Cancelled, message: 'Операция отменена' };
  }
  if (error instanceof Error) {
    return { code: RpcErrorCode.Internal, message: error.message, details: error.stack };
  }
  return { code: RpcErrorCode.Internal, message: String(error) };
}
