import { BrowserWindow } from 'electron';
import { PUSH_CHANNEL, type PushMessage } from '../../shared/api';

/** Широковещательное уведомление всем окнам. Для стримов внутри вызова есть ctx.emit. */
export function pushToRenderers(topic: string, payload: unknown): void {
  const message: PushMessage = { topic, payload };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(PUSH_CHANNEL, message);
  }
}
