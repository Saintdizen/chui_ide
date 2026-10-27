/* ── Транспорт ──────────────────────────────────────────────────────────── */

export interface RpcCall {
  id: string;
  method: string;
  params: unknown;
  /** Долгий вызов с событиями: main отметит конец событий меткой `RPC_EVENT_END`. */
  stream?: boolean;
}

export interface RpcError {
  code: number;
  message: string;
  details?: string;
}

export type RpcResult = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: RpcError };

/** Событие внутри одного RPC-вызова: стриминг токенов, прогресс, лог. */
export interface RpcEventMessage {
  id: string;
  event: string;
  payload: unknown;
}

export interface PushMessage {
  topic: string;
  payload: unknown;
}

/**
 * Запрос main → renderer. Нужен там, где действие живёт только в renderer:
 * правка документа обязана идти через документную модель, undo и ревью.
 */
export interface HostRequest {
  id: string;
  method: string;
  params: unknown;
}

export type HostReply = { id: string; ok: true; value: unknown } | { id: string; ok: false; error: RpcError };

export const RpcErrorCode = {
  Cancelled: -32800,
  InvalidParams: -32602,
  MethodNotFound: -32601,
  Internal: -32603,
  NotFound: -32001,
  /** Возможность выключена в настройках (например, ассистент целиком). */
  Disabled: -32002,
} as const;
