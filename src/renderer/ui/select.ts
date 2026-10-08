import { h, svgIcon } from './dom';

export interface SelectOption {
  value: string;
  label: string;
  /** Пометка справа в списке: «удалённая», описание и прочее. */
  hint?: string;
}

export interface SelectView {
  element: HTMLElement;
  setOptions(options: readonly SelectOption[]): void;
  get value(): string;
  setValue(value: string): void;
  onChange(listener: (value: string) => void): void;
  setDisabled(disabled: boolean): void;
  setHidden(hidden: boolean): void;
}

/** Открытый список один: открытие нового закрывает предыдущий. */
let closeOpen: (() => void) | null = null;

/**
 * Выпадающий список вместо системного `<select>`.
 *
 * Системный список рисует операционная система: он не подчиняется ни палитре,
 * ни плотности, ни радиусу, и в тёмной схеме выглядит чужим. Здесь он собран
 * из тех же слоёв, что контекстное меню и палитра команд, — материал с блюром.
 *
 * Разметка и клавиши — как у combobox: `role="combobox"` на кнопке,
 * `role="listbox"`/`option` в списке, стрелки, Home/End, Enter, Escape
 * и поиск по первой букве.
 */
export function createSelect(options: { title?: string; placeholder?: string; class?: string } = {}): SelectView {
  const valueLabel = h('span', { class: 'select-value is-empty' }, options.placeholder ?? '');
  const element = h(
    'button',
    {
      class: `select${options.class ? ` ${options.class}` : ''}`,
      type: 'button',
      title: options.title ?? '',
      role: 'combobox',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      onClick: () => (popup ? close() : open()),
    },
    valueLabel,
    svgIcon('chevronDown', 12),
  );

  let items: readonly SelectOption[] = [];
  let current = '';
  let disabled = false;
  let popup: HTMLElement | null = null;
  let detach: (() => void) | null = null;
  let cursor = 0;
  let typed = '';
  let typedTimer: number | undefined;
  const listeners = new Set<(value: string) => void>();

  const emit = (value: string): void => {
    for (const listener of [...listeners]) listener(value);
  };

  const labelFor = (value: string): SelectOption | undefined => items.find((item) => item.value === value);

  const render = (): void => {
    const found = labelFor(current);
    valueLabel.textContent = found?.label ?? options.placeholder ?? '';
    valueLabel.classList.toggle('is-empty', !found);
    element.disabled = disabled;
    element.classList.toggle('is-disabled', disabled);
  };

  /** Пересчитываем позицию: список привязан к кнопке и живёт в body. */
  const place = (): void => {
    if (!popup) return;
    const anchor = element.getBoundingClientRect();
    // Измеряем offset-размерами, а не rect: у появления есть transform,
    // и по нему позиция уезжала бы на кадр анимации.
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));
    const left = clamp(anchor.left, 8, Math.max(8, window.innerWidth - width - 8));
    const below = anchor.bottom + 4;
    const above = anchor.top - height - 4;
    const flip = below + height > window.innerHeight - 8 && above > 8;
    // Верхний предел обязателен: кнопка может быть прокручена из виду внутри
    // модального окна, и без зажима список улетал бы под шапку приложения.
    const top = clamp(flip ? above : below, 8, Math.max(8, window.innerHeight - height - 8));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  };

  const setCursor = (next: number): void => {
    if (!popup || items.length === 0) return;
    cursor = (next + items.length) % items.length;
    const nodes = [...popup.querySelectorAll<HTMLElement>('.select-item')];
    nodes.forEach((node, index) => node.classList.toggle('is-cursor', index === cursor));
    nodes[cursor]?.scrollIntoView({ block: 'nearest' });
  };

  const close = (): void => {
    detach?.();
    detach = null;
    popup?.remove();
    popup = null;
    element.setAttribute('aria-expanded', 'false');
    if (closeOpen === close) closeOpen = null;
  };

  const pick = (option: SelectOption | undefined): void => {
    if (!option || option.value === current) {
      close();
      element.focus();
      return;
    }
    current = option.value;
    render();
    close();
    element.focus();
    emit(current);
  };

  const search = (key: string): void => {
    typed = `${typed}${key}`.toLowerCase();
    window.clearTimeout(typedTimer);
    typedTimer = window.setTimeout(() => {
      typed = '';
    }, 600);
    const index = items.findIndex((item) => item.label.toLowerCase().startsWith(typed));
    if (index >= 0) setCursor(index);
  };

  const open = (): void => {
    if (disabled || popup || items.length === 0) return;
    closeOpen?.();
    closeOpen = close;

    popup = h('div', {
      class: 'select-popup',
      role: 'listbox',
      tabindex: '-1',
      style: { minWidth: `${Math.max(element.offsetWidth, 160)}px` },
    });

    items.forEach((item, index) => {
      if (item.value === current) cursor = index;
      popup!.appendChild(
        h(
          'button',
          {
            class: `select-item${item.value === current ? ' is-selected' : ''}`,
            type: 'button',
            role: 'option',
            'aria-selected': item.value === current ? 'true' : 'false',
            title: item.label,
            onClick: () => pick(item),
            onPointerEnter: () => setCursor(index),
          },
          h('span', { class: 'select-item-label' }, item.label),
          item.hint ? h('span', { class: 'select-item-hint' }, item.hint) : null,
        ),
      );
    });

    document.body.appendChild(popup);
    element.setAttribute('aria-expanded', 'true');
    place();
    setCursor(cursor);
    popup.focus();

    popup.addEventListener('keydown', (event) => {
      const key = event.key;
      if (key === 'ArrowDown') setCursor(cursor + 1);
      else if (key === 'ArrowUp') setCursor(cursor - 1);
      else if (key === 'Home') setCursor(0);
      else if (key === 'End') setCursor(items.length - 1);
      else if (key === 'Enter' || key === ' ') pick(items[cursor]);
      else if (key === 'Escape' || key === 'Tab') {
        close();
        element.focus();
      } else if (key.length === 1) search(key);
      else return;
      event.preventDefault();
    });

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popup?.contains(target) || element.contains(target)) return;
      close();
    };
    const onScrollOrResize = (): void => place();

    // Слушаем в capture и отложенно: иначе тот же клик, которым открыли список, его и закроет.
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('resize', onScrollOrResize);
      window.addEventListener('scroll', onScrollOrResize, true);
    }, 0);

    detach = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  };

  render();

  return {
    element,
    get value() {
      return current;
    },
    setOptions(next) {
      items = next;
      // Текущее значение могло исчезнуть из списка (например, ветку удалили).
      if (current && !labelFor(current)) current = '';
      if (!current) current = next[0]?.value ?? '';
      if (popup) {
        close();
        open();
      }
      render();
    },
    setValue(value) {
      current = value;
      if (popup) {
        close();
        open();
      }
      render();
    },
    onChange(listener) {
      listeners.add(listener);
    },
    setDisabled(next) {
      disabled = next;
      if (next) close();
      render();
    },
    setHidden(hidden) {
      element.hidden = hidden;
      if (hidden) close();
    },
  };
}
