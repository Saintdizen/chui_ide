import type { SurroundOption } from '../editor/input/surround';
import { clear, h } from './dom';

export interface SurroundModalDeps {
  /** Из чего выбирать: зависит от языка файла — список считает вызывающий. */
  options: () => readonly SurroundOption[];
  /** Обернуть выделение выбранной парой. */
  apply: (option: SurroundOption) => void;
}

export interface SurroundModalView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/**
 * Выбор обёртки: короткий список пар, одна строка на вариант.
 *
 * Список, а не поле ввода: вариантов немного и они всегда одни и те же, а ввод знаков
 * руками — это и есть обычный набор текста. Стрелки двигают выделение, Enter оборачивает,
 * Esc закрывает — как в списке подсказок, к которому человек уже привык.
 *
 * Окно только показывает: что даст обёртка, знает вызывающий. Поэтому его видно в
 * пробе, и в него не тянется ни буфер, ни история.
 */
export function createSurroundModal(deps: SurroundModalDeps): SurroundModalView {
  const list = h('div', { class: 'surround-list' });
  const hint = h('div', { class: 'field-hint' });
  let items: readonly SurroundOption[] = [];
  let selected = 0;

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal surround-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Обернуть выделение' },
      h('header', { class: 'modal-header' }, h('span', { class: 'modal-title' }, 'Обернуть выделение')),
      h('div', { class: 'modal-body' }, list, hint),
    ),
  );

  function close(): void {
    element.hidden = true;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function choose(index: number): void {
    const option = items[index];
    if (!option) return;
    close();
    deps.apply(option);
  }

  function render(): void {
    clear(list);
    items.forEach((option, index) => {
      const row = h(
        'button',
        {
          class: index === selected ? 'surround-row is-active' : 'surround-row',
          type: 'button',
          onClick: () => choose(index),
          // Наведение двигает выделение: мышь и клавиши должны показывать одно место.
          onPointerenter: () => {
            selected = index;
            highlight();
          },
        },
        h('span', { class: 'surround-signs' }, `${option.open}${option.close}`),
        h('span', { class: 'surround-label' }, option.label),
      );
      row.dataset.index = String(index);
      list.append(row);
    });
  }

  /** Переставить выделение, не пересобирая список: строк на экране немного. */
  function highlight(): void {
    [...list.children].forEach((node, index) => {
      node.classList.toggle('is-active', index === selected);
    });
  }

  function move(delta: number): void {
    if (items.length === 0) return;
    selected = Math.max(0, Math.min(selected + delta, items.length - 1));
    highlight();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (element.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(selected);
    }
  }

  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  return {
    element,
    close,
    open() {
      items = deps.options();
      selected = 0;
      hint.textContent = 'Обёртка встаёт вокруг выделения; пустое выделение даёт пару с кареткой между знаками.';
      render();
      element.hidden = false;
      // Слушаем в capture и позже текущего клика: иначе Esc сработает на открытии.
      document.removeEventListener('keydown', onKeyDown, true);
      window.setTimeout(() => document.addEventListener('keydown', onKeyDown, true), 0);
      list.focus();
    },
  };
}
