import { createPopover, type PopoverView } from './popover';

/**
 * Попап, который строится при первом открытии, и только тогда.
 *
 * Так устроены все чипы статусбара: содержимое (окружение Python, Node, языковые
 * серверы, менеджер git) читает данные и рисует разметку, а нужно это лишь когда
 * человек кликнул. До первого клика в `app.ts` лежала пара `let`-переменных
 * (`popover` и `view`), обе `null`, и в каждом обработчике — `?.` на случай «ещё
 * не создан». Здесь это состояние заперто в замыкании фабрики: снаружи видно
 * только `toggle`, `refresh` и `close`, и все они безопасны до создания.
 */
export interface LazyPopover<T extends { element: HTMLElement }> {
  /** Открыть у якоря или закрыть, если открыт им же. Создаёт попап при первом вызове. */
  toggle(anchor: HTMLElement): void;
  /** Обновить снимок, если попап уже существует; до первого открытия — ничего. */
  refresh(): void;
  /** Создать (если ещё нет) и обновить снимок, не показывая: прогрев в фоне. */
  warm(): void;
  /** Закрыть, если существует. */
  close(): void;
  /** Открыт ли прямо сейчас (созданный и видимый). */
  readonly isOpen: boolean;
  /** Содержимое, если оно уже создано; иначе `null`. */
  readonly view: T | null;
}

export interface LazyPopoverOptions<T extends { element: HTMLElement }> {
  /**
   * Построить содержимое. `close` закрывает сам попап — передаём его внутрь,
   * чтобы кнопки содержимого не тянулись к внешней переменной.
   */
  create(close: () => void): T;
  /** Класс на контейнере попапа — по нему живут стили конкретного чипа. */
  className: string;
  /** Ширина в пикселях; без неё попап жмётся по содержимому. */
  width?: number;
  align?: 'start' | 'end';
  /** Что сделать при каждом открытии до показа (свежие данные у сервера и т.п.). */
  beforeOpen?(): void;
  /** Обновление снимка перед показом; по умолчанию — `view.refresh()`. */
  refresh?(view: T): void;
}

export function createLazyPopover<T extends { element: HTMLElement }>(options: LazyPopoverOptions<T>): LazyPopover<T> {
  let content: T | null = null;
  let popover: PopoverView | null = null;

  const ensure = (): { content: T; popover: PopoverView } => {
    if (!content || !popover) {
      const built = options.create(() => popover?.close());
      const created = createPopover(built.element, { width: options.width, align: options.align });
      created.element.classList.add(options.className);
      content = built;
      popover = created;
    }
    return { content, popover };
  };

  return {
    toggle(anchor) {
      const ready = ensure();
      options.beforeOpen?.();
      if (options.refresh) options.refresh(ready.content);
      else (ready.content as { refresh?: () => unknown }).refresh?.();
      ready.popover.toggle(anchor);
    },
    refresh() {
      if (!content) return;
      if (options.refresh) options.refresh(content);
      else (content as { refresh?: () => unknown }).refresh?.();
    },
    warm() {
      const ready = ensure();
      if (options.refresh) options.refresh(ready.content);
      else (ready.content as { refresh?: () => unknown }).refresh?.();
    },
    close() {
      popover?.close();
    },
    get isOpen() {
      return popover?.isOpen === true;
    },
    get view() {
      return content;
    },
  };
}
