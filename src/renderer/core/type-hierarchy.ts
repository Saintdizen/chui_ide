/**
 * Иерархия типов символа в месте курсора: от кого он наследует и кто наследует от него.
 *
 * Как и иерархия вызовов, это три шага в main: `prepareTypeHierarchy` отдаёт символ,
 * по нему спрашиваем надтипы и подтипы. Своего показа у редактора нет — список
 * открывает приложение тем же попапом, что и прочие переходы (Monaco такой панели
 * не давал и подавно).
 *
 * Возврат: `null` — сервера нет или символ под курсором не опознан; пустой список
 * `types` — сервер ответил, но надтипов/подтипов нет (это не ошибка, а ответ).
 */

import {
  toTypeHierarchyItems,
  toTypeHierarchyNodes,
  typeHierarchyMethod,
  type TypeDirection,
  type TypeHierarchyNode,
} from '../../shared/lsp-type-hierarchy';
import { pathToUri, uriToPath } from './document';
import type { RpcClient } from './rpc';

/** Направление иерархии типов — ре-экспорт: вызывающему он нужен, а модуль LSP ему незачем. */
export type { TypeDirection };

/** Куда ведёт узел иерархии типов: файл и место объявления. */
export interface TypeTarget {
  name: string;
  /** Подпись из сервера (контейнер, сигнатура); может не быть. */
  detail: string | null;
  path: string;
  line: number;
  column: number;
}

export interface TypeHierarchyResult {
  /** Символ, для которого считали иерархию. */
  symbol: TypeTarget;
  /** Надтипы или подтипы — по тому, что просили. */
  types: TypeTarget[];
}

export async function fetchTypeHierarchy(
  rpc: RpcClient,
  path: string,
  position: { line: number; column: number },
  direction: TypeDirection,
): Promise<TypeHierarchyResult | null> {
  const request = (method: string, params: unknown): Promise<unknown> =>
    rpc.request('lsp.request', { path, method, params }).catch(() => null);

  const prepared = toTypeHierarchyNodes(
    await request('textDocument/prepareTypeHierarchy', {
      textDocument: { uri: pathToUri(path) },
      position: { line: position.line - 1, character: position.column - 1 },
    }),
  );
  const symbol = prepared[0];
  if (!symbol) return null;

  const raw = await request(typeHierarchyMethod(direction), { item: symbol });
  const self = toTarget(symbol);
  if (!self) return null;
  return {
    symbol: self,
    types: toTypeHierarchyItems(raw)
      .map((node) => toTarget(node))
      .filter((item): item is TypeTarget => item !== null),
  };
}

/** Узел LSP → цель перехода. Не `file://` — не наш файл, такой узел пропускаем. */
function toTarget(node: TypeHierarchyNode): TypeTarget | null {
  if (!node.uri.startsWith('file:')) return null;
  return {
    name: node.name,
    detail: node.detail ?? null,
    path: uriToPath(node.uri),
    line: node.selectionRange.start.line + 1,
    column: node.selectionRange.start.character + 1,
  };
}
