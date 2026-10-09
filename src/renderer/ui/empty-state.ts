import { h } from './dom';
import { logoMark } from './logo';

export interface EmptyStateView {
  element: HTMLElement;
  /** Заглушка нужна, пока не открыто ни одного файла. */
  update(hasTabs: boolean): void;
}

/**
 * Пустое состояние редактора: знак, имя и подсказки по горячим клавишам.
 * Кнопок и пояснений нет намеренно: всё, что они делали, есть в меню («☰»),
 * в палитре команд и в дереве проекта, а здесь нужен только знак и что делать.
 */
export function createEmptyState(): EmptyStateView {
  const element = h(
    'div',
    { class: 'welcome' },
    // Знак крупнее обычных значков интерфейса: он не часть панели, а лицо
    // приложения, поэтому рисуется отдельно (ui/logo.ts).
    logoMark(40),
    h('h1', { class: 'welcome-title' }, 'chui_iDE'),
    h(
      'ul',
      { class: 'welcome-hints' },
      h('li', {}, 'Ctrl+O — открыть папку, Ctrl+S — сохранить'),
      h('li', {}, 'Alt+F12 — терминал, Ctrl+Shift+F — поиск по проекту'),
      h('li', {}, 'Ctrl+Shift+P — палитра команд, Ctrl+B — боковая панель'),
    ),
  );

  return {
    element,
    update(hasTabs) {
      element.hidden = hasTabs;
    },
  };
}
