import type { CommandDescriptor, CommandRegistry } from '../core/commands';
import { orderByRecent } from '../core/recent-commands';
import { clear, h } from './dom';

export interface PaletteView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/**
 * Сколько пунктов показывать. Сорока стало мало: к нашим командам добавляются действия
 * редактора, и при пустом поле хвост списка просто отрезался (живой замер — 231 пункт).
 * Теперь это только страховка от отрисовки: предел выше
 * любого реального списка, а сужает выдачу сам поиск.
 */
const MAX_ITEMS = 500;

/**
 * Палитра команд (Ctrl+Shift+P). Работает поверх реестра команд,
 * поэтому любая новая команда появляется здесь автоматически.
 */
export function createPalette(deps: {
  commands: CommandRegistry;
  /** История запусков: недавние команды показываются сверху. Нет — порядок регистрации. */
  recent?: { ids(): readonly string[]; remember(id: string): void };
  /**
   * Зовётся перед показом, и только потом строится список: приложению есть когда
   * сохранить историю (одной записью, а не на каждый запуск) и обновить настройки.
   */
  onBeforeShow?: () => void;
}): PaletteView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Введите команду…',
    spellcheck: false,
  });
  const list = h('div', { class: 'palette-list' });
  const overlay = h('div', { class: 'overlay', hidden: true }, h('div', { class: 'palette' }, input, list));

  let matches: CommandDescriptor[] = [];
  let cursor = 0;

  const run = (descriptor: CommandDescriptor): void => {
    // Недоступную команду не запускаем ни кликом, ни Enter: она уже показана серой.
    if (!deps.commands.isEnabled(descriptor.id)) return;
    deps.recent?.remember(descriptor.id);
    close();
    void deps.commands.execute(descriptor.id);
  };

  const render = (): void => {
    clear(list);
    const query = input.value.trim().toLowerCase();
    // Недавние — сверху, но только когда не ищут: при наборе порядок задаёт совпадение,
    // иначе редкая команда с хорошим совпадением пряталась бы под двадцатью привычными.
    const source = query ? deps.commands.list() : orderByRecent(deps.commands.list(), deps.recent?.ids() ?? []);
    matches = source
      .filter((descriptor) => {
        if (!query) return true;
        const haystack =
          `${descriptor.title} ${descriptor.category} ${descriptor.id} ${(descriptor.keywords ?? []).join(' ')}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, MAX_ITEMS);

    cursor = Math.min(cursor, Math.max(matches.length - 1, 0));

    matches.forEach((descriptor, index) => {
      const disabled = !deps.commands.isEnabled(descriptor.id);
      const item = h(
        'button',
        {
          class: `palette-item${index === cursor ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`,
          type: 'button',
          disabled,
        },
        h('span', { class: 'palette-item-title' }, descriptor.title),
        h('span', { class: 'palette-item-category' }, descriptor.category),
        descriptor.keybinding ? h('span', { class: 'palette-item-key' }, descriptor.keybinding) : null,
      );
      item.addEventListener('click', () => run(descriptor));
      item.addEventListener('mousemove', () => {
        if (cursor === index) return;
        cursor = index;
        render();
      });
      list.appendChild(item);
    });

    if (matches.length === 0) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Ничего не найдено'));
    }
  };

  input.addEventListener('input', () => {
    cursor = 0;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, matches.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const descriptor = matches[cursor];
      if (descriptor) run(descriptor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  function open(): void {
    // Сначала повод приложению (сохранить историю, обновить настройки), потом список:
    // иначе палитра покажет устаревший порядок на один запуск.
    deps.onBeforeShow?.();
    overlay.hidden = false;
    input.value = '';
    cursor = 0;
    render();
    input.focus();
  }

  function close(): void {
    overlay.hidden = true;
  }

  render();

  return { element: overlay, open, close };
}
