import type { LspServerConfig } from './api';

export type LspMessageSeverity = 'error' | 'warning' | 'info' | 'log';

/** Сообщение от сервера, которое стоит показать человеку. */
export interface LspServerMessage {
  severity: LspMessageSeverity;
  /** Текст сервера — как есть, без приписок: он и есть содержание. */
  message: string;
  /** Кто сказал: подпись сервера, иначе в уведомлении не понять источник. */
  server: string;
}

/**
 * `window/showMessage` от сервера.
 *
 * Сервер так жалуется: нет прав на индекс, версия не та, нужен JVM. Раньше эти
 * сообщения никто не слушал — сервер писал в пустоту, а человек видел только
 * «подсказок нет». `MessageType` — числа из LSP: 1 error, 2 warning, 3 info, 4 log.
 */
export function parseShowMessage(
  params: unknown,
  config: Pick<LspServerConfig, 'language' | 'label' | 'command'>,
): LspServerMessage | null {
  const payload = params as { type?: unknown; message?: unknown } | null;
  if (!payload || typeof payload.message !== 'string') return null;
  const message = payload.message.trim();
  if (!message) return null;
  return {
    severity: severityOf(payload.type),
    message,
    server: config.label?.trim() || config.command.trim() || config.language,
  };
}

function severityOf(type: unknown): LspMessageSeverity {
  if (type === 1) return 'error';
  if (type === 2) return 'warning';
  if (type === 4) return 'log';
  return 'info';
}
