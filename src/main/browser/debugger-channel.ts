import type { WebContents } from 'electron';
import type { CdpChannel } from './session';

/**
 * Канал CDP поверх вложения окна IDE.
 *
 * У вложения (`WebContentsView`) есть родной `webContents.debugger` — тот же протокол,
 * что у отдельного Chromium, но без процесса, порта и WebSocket: Electron сам держит
 * канал. Благодаря этому агент работает с ТОЙ ЖЕ страницей, которую видит человек, а
 * не с копией в стороннем браузере.
 *
 * Оговорка: DevTools на этом вложении забирают канал себе, и `attach` тогда падает.
 * Это не поломка кода, а честное «занято» — сообщение об ошибке уходит человеку.
 */
export class DebuggerChannel implements CdpChannel {
  constructor(private readonly contents: WebContents) {
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.contents.debugger.sendCommand(method, params) as Promise<Record<string, unknown>>;
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const handler = (_event: unknown, name: string, params: Record<string, unknown>): void => {
      if (name === method) listener(params ?? {});
    };
    this.contents.debugger.on('message', handler);
    return () => this.contents.debugger.off('message', handler);
  }

  close(): void {
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach();
  }

  get closed(): boolean {
    return this.contents.isDestroyed() || !this.contents.debugger.isAttached();
  }
}
