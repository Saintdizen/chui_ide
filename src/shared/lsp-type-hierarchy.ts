/**
 * Разбор ответов LSP про иерархию ТИПОВ: надтипы и подтипы символа.
 *
 * Иерархия типов устроена как иерархия вызовов и запрашивается так же в три шага:
 * `textDocument/prepareTypeHierarchy` даёт сам символ, затем `typeHierarchy/supertypes`
 * (от чего он наследует) и `typeHierarchy/subtypes` (кто наследует от него). Узел —
 * `TypeHierarchyItem`: та же форма, что `CallHierarchyItem`, поэтому разбор узла общий
 * (см. `toCallHierarchyNodes`) и второй правды о ней здесь не заводится.
 *
 * Разница в ответе второго шага: там массив УЗЛОВ, а не пар «узел + места вызова», —
 * вызывающих строк у типа нет, есть только сам тип. Поэтому и модуль нужен: он даёт
 * этому разбору понятные имена и не путает читателя чужим `Call*`.
 *
 * Модуль чистый: диапазоны остаются в нумерации LSP (с нуля), перевод делает renderer.
 */

import { toCallHierarchyNodes, type CallHierarchyNode, type LspRange } from './lsp-call-hierarchy';

/** Узел иерархии типов: форма та же, что у узла вызовов. */
export type TypeHierarchyNode = CallHierarchyNode;

/** Пределы LSP: они общие у обеих иерархий. */
export type TypeHierarchyRange = LspRange;

/** Что за иерархию просим: от кого наследует символ или кто наследует от него. */
export type TypeDirection = 'supertypes' | 'subtypes';

/** Символ под курсором из `prepareTypeHierarchy` (один узел, массив или ничего). */
export function toTypeHierarchyNodes(result: unknown): TypeHierarchyNode[] {
  return toCallHierarchyNodes(result);
}

/** Надтипы или подтипы: ответ — просто список узлов. */
export function toTypeHierarchyItems(result: unknown): TypeHierarchyNode[] {
  return toCallHierarchyNodes(result);
}

/** Имя метода LSP по направлению: угадывать его у вызывающего незачем. */
export function typeHierarchyMethod(direction: TypeDirection): string {
  return direction === 'supertypes' ? 'typeHierarchy/supertypes' : 'typeHierarchy/subtypes';
}
