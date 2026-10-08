import { h } from './dom';

export interface PopoverView {
  /** Контейнер слоя: живёт в body, чтобы не обрезаться панелями с overflow. */
  element: HTMLElement;
  readonly isOpen: boolean;
  /** Открыть у указанного якоря или закрыть, если попап уже открыт им же. */
  toggle(anchor: HTMLElement): void;
  close(): void;
}

/**
 * Всплывающая панель с произвольным содержимым, привязанная к кнопке.
 *
 * Тот же материал и те же правила закрытия, что у контекстного меню и
 * выпадающего списка: Esc, клик вне, повторный клик по якорю. Позиция —
 * `fixed`, поэтому попап не обрезается панелями с `overflow: hidden`.
 */
export function createPopover(content: HTMLElement, options: { width?: number; gap?: number } = {}): PopoverView {
  const gap = options.gap ?? 6;
  const element = h('div', { class: 'popover', role: 'dialog', hidden: true }, content);
  if (options.width !== undefined) element.style.width = `${options.width}px`;
  document.body.appendChild(element);

  let detach: (() => void) | null = null;
  let anchor: HTMLElement | null = null;

  const place = (target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const width = box.width;
    const height = box.height;

    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const above = rect.top - height - gap;
    const below = rect.bottom + gap;
    // Над якорем — обычный случай для нижних панелей; если не влезает, кладём под ним.
    const top = above >= 8 ? above : Math.min(below, Math.max(window.innerHeight - height - 8, 8));

    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  };

  const open = (target: HTMLElement): void => {
    anchor = target;
    element.hidden = false;
    place(target);

    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node;
      if (element.contains(node) || anchor?.contains(node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    const onResize = (): void => {
      if (anchor) place(anchor);
    };

    // Слушаем в capture и с задержкой: иначе тот же клик, которым открыли попап,
    // сразу же его и закроет.
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', onResize);
    }, 0);

    detach = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
    };
  };

  const close = (): void => {
    if (element.hidden) return;
    detach?.();
    detach = null;
    anchor = null;
    element.hidden = true;
  };

  return {
    element,
    get isOpen() {
      return !element.hidden;
    },
    toggle(target: HTMLElement) {
      if (!element.hidden && anchor === target) close();
      else open(target);
    },
    close,
  };
}
