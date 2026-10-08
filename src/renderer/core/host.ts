import {
  RpcErrorCode,
  type HostMethodName,
  type HostParamsOf,
  type HostReply,
  type HostRequest,
  type HostResultOf,
  type RpcError,
} from '../../shared/api';
import type { ChuiBridge } from '../../shared/bridge';

type Handler<M extends HostMethodName> = (
  params: HostParamsOf<M>,
) => HostResultOf<M> | Promise<HostResultOf<M>>;

/**
 * Приёмник хостовых вызовов: main просит renderer выполнить действие, которое
 * возможно только здесь. Обратный RPC нужен потому, что правка документа
 * обязана идти через документную модель — там версии, undo и ревью.
 *
 * Неизвестный метод не «зависает», а честно отвечает ошибкой: иначе вызов
 * в main ждал бы ответа вечно.
 */
export class HostService {
  private readonly handlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private readonly bridge: ChuiBridge = window.chui) {
    this.bridge.onHostRequest((request) => void this.dispatch(request));
  }

  handle<M extends HostMethodName>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler as (params: unknown) => Promise<unknown>);
  }

  private async dispatch(request: HostRequest): Promise<void> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      await this.reply({
        id: request.id,
        ok: false,
        error: { code: RpcErrorCode.MethodNotFound, message: `renderer не умеет «${request.method}»` },
      });
      return;
    }

    try {
      const value = await handler(request.params);
      await this.reply({ id: request.id, ok: true, value });
    } catch (error) {
      await this.reply({ id: request.id, ok: false, error: toRpcError(error) });
    }
  }

  private reply(reply: HostReply): Promise<boolean> {
    return this.bridge.replyHostRequest(reply);
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === 'number' ? code : RpcErrorCode.Internal,
      message: error.message,
    };
  }
  return { code: RpcErrorCode.Internal, message: String(error) };
}
