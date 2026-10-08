import { ipcMain, type WebContents } from 'electron';
import {
  HOST_REPLY_CHANNEL,
  HOST_REQUEST_CHANNEL,
  RpcErrorCode,
  type HostMethodName,
  type HostParamsOf,
  type HostReply,
  type HostRequest,
  type HostResultOf,
} from '../../shared/api';
import { RpcFailure } from './router';

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

/**
 * Мост main → renderer.
 *
 * Обычный RPC идёт в одну сторону: renderer просит — main исполняет. Но есть
 * действия, которые физически живут в renderer: правка документа обязана
 * проходить через документную модель (там версии, undo и ревью). Этот класс
 * отправляет такой запрос в окно и ждёт ответ, а отмена вызова агента
 * переводится в отмену ожидания.
 */
export class HostClient {
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;

  attach(): void {
    ipcMain.handle(HOST_REPLY_CHANNEL, (_event, reply: HostReply): boolean => {
      const entry = this.pending.get(reply.id);
      if (!entry) return false;

      this.pending.delete(reply.id);
      entry.cleanup();
      if (reply.ok) entry.resolve(reply.value);
      else entry.reject(new RpcFailure(reply.error.code, reply.error.message, reply.error.details));
      return true;
    });
  }

  request<M extends HostMethodName>(
    target: WebContents,
    method: M,
    params: HostParamsOf<M>,
    signal?: AbortSignal,
  ): Promise<HostResultOf<M>> {
    if (target.isDestroyed()) {
      return Promise.reject(new RpcFailure(RpcErrorCode.Internal, 'Окно уже закрыто'));
    }

    this.sequence += 1;
    const id = `h${this.sequence.toString(36)}`;

    return new Promise<HostResultOf<M>>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(new RpcFailure(RpcErrorCode.Cancelled, 'Операция отменена'));
      };
      // Окно могли закрыть, пока renderer думал: без этого ожидание не кончится никогда.
      const onGone = (): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(new RpcFailure(RpcErrorCode.Internal, 'Окно закрыто'));
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        target.removeListener('destroyed', onGone);
      };

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      target.once('destroyed', onGone);

      const request: HostRequest = { id, method, params };
      target.send(HOST_REQUEST_CHANNEL, request);
    });
  }
}
