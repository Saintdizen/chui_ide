import { h } from './dom';
import { createModal } from './modal';
import { callTreeExpand, callTreeRoot, type CallTreeDirection, type CallTreeNode } from '../core/call-tree';
import type { RpcClient } from '../core/rpc';

/**
 * Панель иерархии вызовов.
 *
 * Попап отвечает на «кто зовёт этот символ» — один шаг. Панель нужна для
 * другого вопроса: «откуда вообще идёт вызов», через цепочку. Поэтому дерево
 * раскрывается по клику: заголовок приходит сразу, дети — когда узел развернули,
 * иначе первый же запрос на большом проекте тянул бы весь граф.
 */
export interface CallHierarchyDeps {
  rpc: RpcClient;
  /** Открыть файл в строке — по клику на узел. */
  open(path: string, line: number, column: number): void;
}

/** Путь коротко: имя файла и одна папка перед ним — длинный путь не влезает. */
function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

export function showCallHierarchy(
  deps: CallHierarchyDeps,
  path: string,
  position: { line: number; column: number },
  initial: CallTreeDirection,
): void {
  let direction = initial;

  const list = h('div', { class: 'call-tree-list' });
  const title = h('span', { class: 'call-tree-title' });
  const inButton = h('button', { class: 'call-tree-dir is-active', type: 'button' }, 'Кто вызывает');
  const outButton = h('button', { class: 'call-tree-dir', type: 'button' }, 'Кого вызывает');
  const status = h('div', { class: 'call-tree-status' });

  const modal = createModal({
    className: 'call-tree-modal',
    title: 'Иерархия вызовов',
    footer: h('footer', { class: 'modal-footer is-end' }, status),
  });
  modal.body.append(h('div', { class: 'call-tree-toolbar' }, title, inButton, outButton), list);

  /** Один узел дерева. Дети — только после раскрытия. */
  const renderNode = (node: CallTreeNode, depth: number): HTMLElement => {
    const toggle = h('button', { class: 'call-tree-toggle', type: 'button', 'aria-label': 'Раскрыть' }, '▸');
    const nameButton = h('button', { class: 'call-tree-name', type: 'button' }, node.name);
    const row = h(
      'div',
      { class: 'call-tree-row', style: `padding-left:${8 + depth * 14}px` },
      toggle,
      nameButton,
      node.detail ? h('span', { class: 'call-tree-detail' }, node.detail) : null,
      h('span', { class: 'call-tree-path' }, `${shortPath(node.path)}:${node.line}`),
    );
    const kids = h('div', { class: 'call-tree-children', hidden: true });

    const expand = async (): Promise<void> => {
      if (kids.hidden) {
        // Первое раскрытие грузит детей; повторное — только показывает уже
        // загруженных: сервер не дёргаем второй раз на тот же узел.
        if (!node.expanded) {
          kids.textContent = '';
          kids.append(h('div', { class: 'call-tree-loading' }, 'Загружаю…'));
          const children = await callTreeExpand(deps.rpc, path, node, direction);
          kids.textContent = '';
          if (children.length === 0) {
            kids.append(h('div', { class: 'call-tree-empty' }, 'Вызовов нет'));
          } else {
            for (const child of children) kids.append(renderNode(child, depth + 1));
          }
        }
        kids.hidden = false;
        toggle.textContent = '▾';
      } else {
        kids.hidden = true;
        toggle.textContent = '▸';
      }
    };
    toggle.addEventListener('click', () => void expand());
    nameButton.addEventListener('click', () => {
      modal.close();
      deps.open(node.path, node.line, node.column);
    });

    return h('div', { class: 'call-tree-node' }, row, kids);
  };

  const reload = async (): Promise<void> => {
    list.textContent = '';
    status.textContent = '';
    title.textContent = direction === 'incoming' ? 'Кто вызывает символ' : 'Кого вызывает символ';
    const root = await callTreeRoot(deps.rpc, path, position, direction);
    if (root === null) {
      list.append(h('div', { class: 'call-tree-empty' }, 'Сервер не опознал символ под курсором'));
      return;
    }
    // Корень — сам символ; список — его вызовы. Так видно, о чём вообще панель.
    list.append(h('div', { class: 'call-tree-root' }, `${root.name}${root.detail ? ` · ${root.detail}` : ''}`));
    const children = root.children ?? [];
    if (children.length === 0) {
      list.append(
        h(
          'div',
          { class: 'call-tree-empty' },
          direction === 'incoming' ? 'Вызовов не найдено' : 'Символ ничего не вызывает',
        ),
      );
      return;
    }
    for (const child of children) list.append(renderNode(child, 0));
    status.textContent = `${children.length} ${direction === 'incoming' ? 'мест вызова' : 'вызовов'}`;
  };

  const setDirection = (next: CallTreeDirection): void => {
    if (direction === next) return;
    direction = next;
    inButton.classList.toggle('is-active', direction === 'incoming');
    outButton.classList.toggle('is-active', direction === 'outgoing');
    void reload();
  };
  inButton.addEventListener('click', () => setDirection('incoming'));
  outButton.addEventListener('click', () => setDirection('outgoing'));

  void reload();
}
