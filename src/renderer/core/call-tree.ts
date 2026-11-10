import { toCallHierarchyNodes, toIncomingCalls, toOutgoingCalls } from '../../shared/lsp-call-hierarchy';
import { uriToPath } from './document';
import type { RpcClient } from './rpc';

/**
 * Дерево вызовов вглубь — для панели, а не для попапа.
 *
 * Попап показывает один шаг: кто вызывает символ. На вопрос «откуда вообще
 * приходит вызов через пять уровней» он не отвечает, и человек ходит вручную.
 * Панель раскрывает узлы по требованию: заголовок приходит сразу, дети — когда
 * узел развернули, иначе первый запрос на большом проекте тянул бы весь граф.
 */
export interface CallTreeNode {
  name: string;
  /** Подпись из сервера: контейнер или сигнатура. Может не быть. */
  detail: string | null;
  /** Файл и место объявления — куда перейти по узлу. */
  path: string;
  line: number;
  column: number;
  /** Узел для следующего запроса: сервер узнаёт символ по нему. */
  node: unknown;
  children: CallTreeNode[] | null;
  /** Узел уже раскрыт: повторный запрос не нужен, дети есть (или их нет). */
  expanded: boolean;
}

export type CallTreeDirection = 'incoming' | 'outgoing';

const MAX_CHILDREN = 200;

/**
 * Первый уровень иерархии от курсора.
 *
 * `null` — сервера нет или символ под курсором не опознан. Пустой массив
 * `children` — сервер ответил и вызовов нет; это разные вещи, и панель говорит
 * о них по-разному.
 */
export async function callTreeRoot(
  rpc: RpcClient,
  path: string,
  position: { line: number; column: number },
  direction: CallTreeDirection,
): Promise<CallTreeNode | null> {
  const request = (method: string, params: unknown): Promise<unknown> =>
    rpc.request('lsp.request', { path, method, params }).catch(() => null);

  const prepared = toCallHierarchyNodes(
    await request('textDocument/prepareCallHierarchy', {
      textDocument: { uri: `file://${path}` },
      position: { line: position.line - 1, character: position.column - 1 },
    }),
  );
  const symbol = prepared[0];
  if (!symbol) return null;

  const root = toNode(symbol);
  if (!root) return null;
  root.children = await loadChildren(rpc, path, root, direction);
  return root;
}

/** Раскрыть узел: догрузить его детей (или вернуть пустой список). */
export async function callTreeExpand(
  rpc: RpcClient,
  path: string,
  node: CallTreeNode,
  direction: CallTreeDirection,
): Promise<CallTreeNode[]> {
  const children = await loadChildren(rpc, path, node, direction);
  node.children = children;
  node.expanded = true;
  return children;
}

async function loadChildren(
  rpc: RpcClient,
  path: string,
  node: CallTreeNode,
  direction: CallTreeDirection,
): Promise<CallTreeNode[]> {
  const raw = await rpc
    .request('lsp.request', {
      path,
      method: direction === 'incoming' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls',
      params: { item: node.node },
    })
    .catch(() => null);
  const calls = direction === 'incoming' ? toIncomingCalls(raw) : toOutgoingCalls(raw);
  // Предел на уровень: сервер может вернуть сотни мест вызова одной функции, и
  // рисовать их все в панели — значит надолго занять кадр. Человек увидит,
  // что список обрезан, и сузит запрос.
  return calls
    .slice(0, MAX_CHILDREN)
    .map((call) => toNode(call.node))
    .filter((item): item is CallTreeNode => item !== null);
}

function toNode(node: {
  name: string;
  detail?: string;
  uri: string;
  selectionRange: { start: { line: number; character: number } };
}): CallTreeNode | null {
  if (!node.uri.startsWith('file:')) return null;
  return {
    name: node.name,
    detail: node.detail ?? null,
    path: uriToPath(node.uri),
    line: node.selectionRange.start.line + 1,
    column: node.selectionRange.start.character + 1,
    node,
    children: null,
    expanded: false,
  };
}
