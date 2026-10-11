import {
  toCallHierarchyNodes,
  toIncomingCalls,
  toOutgoingCalls,
  type CallHierarchyNode,
} from '../../shared/lsp-call-hierarchy';
import { pathToUri, uriToPath } from './document';
import type { RpcClient } from './rpc';

/** Куда ведёт узел иерархии: файл и место объявления символа. */
export interface CallTarget {
  name: string;
  /** Подпись из сервера (контейнер, сигнатура); может не быть. */
  detail: string | null;
  path: string;
  line: number;
  column: number;
}

export interface CallHierarchyResult {
  /** Символ, для которого считали вызовы. */
  symbol: CallTarget;
  /** Кто его вызывает (incoming) или кого вызывает он (outgoing). */
  calls: CallTarget[];
}

export type CallDirection = 'incoming' | 'outgoing';

/**
 * Иерархия вызовов символа в месте курсора.
 *
 * Monaco такой панели не даёт (в его публичном API иерархии вызовов нет), поэтому
 * запрашиваем её сами у языкового сервера и показываем своим списком — тем же
 * попапом, что и прочие переходы. Первый шаг — `prepareCallHierarchy`: он отдаёт
 * сам символ, и уже по нему (вместе с его `data`) спрашиваем вызовы.
 *
 * Возврат: `null` — сервера нет или символ под курсором не опознан; пустой список
 * `calls` — сервер ответил, но вызовов не нашёл (это не ошибка).
 */
export async function fetchCallHierarchy(
  rpc: RpcClient,
  path: string,
  position: { line: number; column: number },
  direction: CallDirection,
): Promise<CallHierarchyResult | null> {
  const request = (method: string, params: unknown): Promise<unknown> =>
    rpc.request('lsp.request', { path, method, params }).catch(() => null);

  const prepared = toCallHierarchyNodes(
    await request('textDocument/prepareCallHierarchy', {
      textDocument: { uri: pathToUri(path) },
      position: { line: position.line - 1, character: position.column - 1 },
    }),
  );
  const symbol = prepared[0];
  if (!symbol) return null;

  const raw = await request(direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', {
    item: symbol,
  });
  const calls = direction === 'incoming' ? toIncomingCalls(raw) : toOutgoingCalls(raw);

  const self = toTarget(symbol);
  if (!self) return null;
  return {
    symbol: self,
    calls: calls.map((call) => toTarget(call.node)).filter((item): item is CallTarget => item !== null),
  };
}

/** Узел LSP → цель перехода. Не `file://` — не наш файл, такой узел пропускаем. */
function toTarget(node: CallHierarchyNode): CallTarget | null {
  if (!node.uri.startsWith('file:')) return null;
  return {
    name: node.name,
    detail: node.detail ?? null,
    path: uriToPath(node.uri),
    line: node.selectionRange.start.line + 1,
    column: node.selectionRange.start.character + 1,
  };
}
