import { placePopup } from '../core/popup-placement';
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
    const { left, top } = placePopup({
      anchor: target.getBoundingClientRect(),
      // Размер берём из макета (`offset*`), а не из `getBoundingClientRect`:
      // появление идёт анимацией со `scale`, и сжатый размер смещал бы попап.
      size: { width: element.offsetWidth, height: element.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap,
    });
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  };

  const open = (target: HTMLElement): void => {
    anchor = target;
    element.hidden = false;
    place(target);

    // Содержимое приходит не сразу (список окружений спрашивается у main):
    // пересчитываем позицию, когда попап меняет размер, иначе он вырастет за
    // край — при открытии высота ещё пустая.
    const observer = new ResizeObserver(() => {
      if (anchor) place(anchor);
    });
    observer.observe(element);

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
      observer.disconnect();
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
