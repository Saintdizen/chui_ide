/**
 * Разбор ответов LSP про иерархию вызовов: кто вызывает символ и кого вызывает он.
 *
 * Иерархию запрашивают в три шага: `textDocument/prepareCallHierarchy` даёт сам
 * символ, затем `callHierarchy/incomingCalls` и `callHierarchy/outgoingCalls` —
 * его вызовы. Форма ответа у серверов одна и та же, но поля приходят сырыми и
 * с `data` — прозрачным для нас довеском, без которого часть серверов второй шаг
 * не поймёт. Здесь — чистый разбор: проверка формы и вытаскивание нужного.
 *
 * Диапазоны остаются в нумерации LSP (строки и столбцы с нуля): перевод в форму
 * Monaco делает renderer, а этот модуль общий и о редакторе не знает.
 */

/** Диапазон в нумерации LSP: строки и столбцы с нуля. */
export interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * Узел иерархии — символ в файле. `data` храним как есть: его возвращают серверу
 * при запросе вызовов, а значение нам неизвестно и разбирать его незачем.
 */
export interface CallHierarchyNode {
  name: string;
  /** Вид символа по LSP (нумерация с единицы). */
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  data?: unknown;
}

/** Один вызов: узел на другом конце и места вызова в его файле. */
export interface CallHierarchyCall {
  node: CallHierarchyNode;
  /** Где именно в файле вызывающего идёт вызов. */
  fromRanges: LspRange[];
}

function isLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
  return (
    typeof range.start?.line === 'number' &&
    typeof range.start.character === 'number' &&
    typeof range.end?.line === 'number' &&
    typeof range.end.character === 'number'
  );
}

/** Один узел из сырого ответа; null — запись непригодна. */
function toNode(raw: unknown): CallHierarchyNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    name?: unknown;
    kind?: unknown;
    detail?: unknown;
    uri?: unknown;
    range?: unknown;
    selectionRange?: unknown;
    data?: unknown;
  };
  if (typeof value.name !== 'string' || typeof value.uri !== 'string') return null;
  if (!isLspRange(value.range)) return null;
  // Селект-диапазон сервер может не прислать — тогда он совпадает с полным.
  const selection = isLspRange(value.selectionRange) ? value.selectionRange : value.range;

  const node: CallHierarchyNode = {
    name: value.name,
    kind: typeof value.kind === 'number' ? value.kind : 0,
    uri: value.uri,
    range: value.range,
    selectionRange: selection,
  };
  if (typeof value.detail === 'string' && value.detail !== '') node.detail = value.detail;
  if (value.data !== undefined) node.data = value.data;
  return node;
}

/**
 * Символ под курсором из `prepareCallHierarchy`: сервер вправе вернуть один узел,
 * массив или ничего (в этом месте иерархии нет).
 */
export function toCallHierarchyNodes(result: unknown): CallHierarchyNode[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const nodes: CallHierarchyNode[] = [];
  for (const item of list) {
    const node = toNode(item);
    if (node) nodes.push(node);
  }
  return nodes;
}

/** Чужие вызовы (`incomingCalls`): у каждого — узел `from` и места вызова. */
export function toIncomingCalls(result: unknown): CallHierarchyCall[] {
  return toCalls(result, 'from');
}

/** Вызовы самого символа (`outgoingCalls`): у каждого — узел `to` и места вызова. */
export function toOutgoingCalls(result: unknown): CallHierarchyCall[] {
  return toCalls(result, 'to');
}

/** Общий разбор: LSP называет конец вызова `from` у входящих и `to` у исходящих. */
function toCalls(result: unknown, key: 'from' | 'to'): CallHierarchyCall[] {
  if (!Array.isArray(result)) return [];
  const calls: CallHierarchyCall[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const node = toNode(value[key]);
    if (!node) continue;
    const ranges = Array.isArray(value.fromRanges)
      ? value.fromRanges.filter((range): range is LspRange => isLspRange(range))
      : [];
    calls.push({ node, fromRanges: ranges });
  }
  return calls;
}
