import type { CommandDescriptor, CommandRegistry } from '../core/commands';
import { rankCommandMatches, type RankedCommand } from '../core/palette-rank';
import { orderByRecent } from '../core/recent-commands';
import { clear, h } from './dom';
import { focusOwner, returnFocus } from './focus-return';

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

  // Совпадения вместе с тем, что подсветить: две формы одного списка
  // разошлись бы на первой же правке.
  let matches: RankedCommand[] = [];
  let cursor = 0;
  /** Последний нарисованный заголовок группы: повтор подряд — это шум. */
  let lastHeader = '';

  const run = (descriptor: CommandDescriptor): void => {
    // Недоступную команду не запускаем ни кликом, ни Enter: она уже показана серой.
    if (!deps.commands.isEnabled(descriptor.id)) return;
    deps.recent?.remember(descriptor.id);
    close();
    void deps.commands.execute(descriptor.id);
  };

  /**
   * Название с подсвеченными буквами. Позиции — индексы символов названия,
   * уже переведённые из свёрнутой формы в исходную (`palette-rank`).
   */
  const highlighted = (title: string, positions: readonly number[]): (Node | string)[] => {
    if (positions.length === 0) return [title];
    const hits = new Set(positions);
    const parts: (Node | string)[] = [];
    let plain = '';
    [...title].forEach((char, index) => {
      if (hits.has(index)) {
        if (plain) parts.push(plain);
        plain = '';
        parts.push(h('mark', {}, char));
        return;
      }
      plain += char;
    });
    if (plain) parts.push(plain);
    return parts;
  };

  const render = (): void => {
    clear(list);
    lastHeader = '';
    const query = input.value.trim();
    const recent = deps.recent?.ids() ?? [];
    // Без запроса ищем по истории: человек, живущий в двух командах, не должен
    // каждый раз искать их заново. С запросом порядок задаёт совпадение —
    // иначе редкая команда с точным совпадением пряталась бы под привычными.
    const ranked = rankCommandMatches(deps.commands.list(), query, recent, MAX_ITEMS);
    matches = ranked
      ? [...ranked]
      : orderByRecent(deps.commands.list(), recent)
          .slice(0, MAX_ITEMS)
          .map((descriptor) => ({ descriptor, positions: [] }));

    cursor = Math.min(cursor, Math.max(matches.length - 1, 0));

    // Заголовки групп — только без запроса: с запросом порядок задаёт
    // релевантность, и заголовок разорвал бы её. А пустой экран — это больше
    // двухсот команд подряд, и категории в нём единственный ориентир.
    const grouped = query === '';
    const pinned = new Set(recent);

    matches.forEach(({ descriptor, positions }, index) => {
      if (grouped) {
        const header = pinned.has(descriptor.id) ? 'Недавние' : descriptor.category;
        if (header !== lastHeader) {
          lastHeader = header;
          list.appendChild(h('div', { class: 'palette-group' }, header));
        }
      }
      const disabled = !deps.commands.isEnabled(descriptor.id);
      const item = h(
        'button',
        {
          class: `palette-item${index === cursor ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`,
          type: 'button',
          disabled,
        },
        // Подсветка — ответ на «почему эта команда тут»: без неё нечёткое
        // совпадение (`свн`) выглядит как случайная строка в списке.
        h('span', { class: 'palette-item-title' }, ...highlighted(descriptor.title, positions)),
        // Категория у пункта не нужна, когда она уже стоит заголовком группы.
        grouped ? null : h('span', { class: 'palette-item-category' }, descriptor.category),
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
      const picked = matches[cursor];
      if (picked) run(picked.descriptor);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  // Чей был фокус до открытия: берём ДО того, как он уйдёт в поле запроса.
  let owner: HTMLElement | null = null;

  function open(): void {
    // Сначала повод приложению (сохранить историю, обновить настройки), потом список:
    // иначе палитра покажет устаревший порядок на один запуск.
    deps.onBeforeShow?.();
    owner = focusOwner();
    overlay.hidden = false;
    input.value = '';
    cursor = 0;
    render();
    input.focus();
  }

  function close(): void {
    // Пока попап открыт, фокус в его поле. Вернуть его тому, кто открыл палитру, —
    // иначе после Escape клавиатура начинает обход с верха страницы.
    overlay.hidden = true;
    returnFocus(owner);
    owner = null;
  }

  render();

  return { element: overlay, open, close };
}
