import type { CommandRegistry } from '../core/commands';
import { h, svgIcon } from './dom';

export interface EmptyStateView {
  element: HTMLElement;
  update(hasTabs: boolean, hasWorkspace: boolean): void;
}

export function createEmptyState(deps: { commands: CommandRegistry }): EmptyStateView {
  const subtitle = h('p', { class: 'welcome-subtitle' });

  const element = h(
    'div',
    { class: 'welcome' },
    svgIcon('sparkle', 40),
    h('h1', { class: 'welcome-title' }, 'Chui IDE'),
    subtitle,
    h(
      'div',
      { class: 'welcome-actions' },
      h(
        'button',
        { class: 'btn btn-primary', type: 'button', onClick: () => void deps.commands.execute('workspace.openFolder') },
        'Открыть папку',
      ),
      h(
        'button',
        { class: 'btn', type: 'button', onClick: () => void deps.commands.execute('view.showTerminal') },
        'Терминал',
      ),
      h(
        'button',
        { class: 'btn', type: 'button', onClick: () => void deps.commands.execute('palette.open') },
        'Палитра команд',
      ),
    ),
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
    update(hasTabs, hasWorkspace) {
      element.hidden = hasTabs;
      subtitle.textContent = hasWorkspace
        ? 'Файлы не открыты. Выберите файл в проводнике слева.'
        : 'Начните с выбора папки проекта — дальше всё как в привычной IDE.';
    },
  };
}
