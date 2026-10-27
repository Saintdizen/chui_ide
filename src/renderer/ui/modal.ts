/**
 * Каркас модального окна: задник, шапка с заголовком и кнопкой «закрыть», тело и
 * необязательный подвал — плюс поведение, общее для ВСЕХ окон.
 *
 * До этого каждый из двух десятков `*-modal.ts` собирал эту разметку сам и вешал
 * обработчик Escape на `document` НАВСЕГДА — даже у скрытого окна. То есть в
 * приложении жило два десятка слушателей, каждый из которых на каждое нажатие
 * проверял «а не Escape ли это и не открыт ли я». Здесь и разметка, и поведение
 * заданы один раз:
 *
 *   • Escape слушается ТОЛЬКО пока окно открыто, в фазе перехвата — и снимается
 *     при закрытии. Слушатель ставится на следующий тик, чтобы им же нажатием,
 *     которым окно открыли, его не закрыло;
 *   • фокус при открытии уходит в окно (по умолчанию — в само окно, чтобы Tab
 *     дальше шёл по его содержимому), а при закрытии возвращается туда, откуда
 *     его забрали: человек не теряет место в интерфейсе;
 *   • Tab не выходит за пределы окна — фокус ходит по кругу;
 *   • клик по затемнению закрывает окно (отключается опцией), клик по самому окну — нет;
 *   • пока окно открыто, фон помечается `aria-hidden`: под окном лежит затемнённое
 *     и недоступное содержимое, и читалка не должна по нему ходить.
 *
 * Модалки кладут в `document.body` рядом с `#app`, поэтому «фон» для последнего
 * пункта — именно корень приложения, а не родитель окна.
 *
 * Модуль знает про DOM (это его работа), но ничего не знает о конкретных окнах:
 * содержимое передаёт вызывающий. Поэтому проверяется он сторожами по тексту
 * (`tests/ui-modal.test.ts`), а вживую — разделами `npm run probe:editor`.
 */

import { h, svgIcon, type IconName } from './dom';

export interface ModalOptions {
  /** Класс окна: за ним модалка цепляет свои стили (`.stash-modal` и т. п.). */
  className?: string;
  /** Доступное имя окна — уходит в `aria-label`. */
  label?: string;
  /** Текст заголовка. Пусто — узел заголовка всё равно есть, его заполнят позже. */
  title?: string;
  /** Значок перед заголовком: у настроек — шестерня, у запуска — треугольник. */
  headerIcon?: IconName;
  /** Кнопки в шапке слева от «закрыть»: обновить, создать, ещё что-то. */
  headerActions?: readonly HTMLElement[];
  /** Подвал окна. Не задан — подвала нет (иначе он занял бы пустую полосу). */
  footer?: HTMLElement;
  /** Что сделать ПЕРЕД закрытием: свернуть форму, сбросить состояние. */
  onClose?: () => void;
  /**
   * Свой разбор Escape. Вернуть `true` — «обработал сам, закрывать не надо»
   * (например, Escape сперва сворачивает форму создания, и лишь потом окно).
   */
  onEscape?: () => boolean;
  /** Закрывать ли кликом по затемнению. По умолчанию — да. */
  closeOnBackdrop?: boolean;
}

export interface ModalView {
  /** Задник — его кладут в `document.body`. */
  readonly element: HTMLElement;
  /** Узел заголовка: текст можно менять при каждом открытии. */
  readonly title: HTMLElement;
  /** Тело окна: сюда кладут содержимое. */
  readonly body: HTMLElement;
  /** Открыто ли окно сейчас. */
  readonly isOpen: boolean;
  /** Показать окно. `focus` — куда поставить фокус (по умолчанию — в само окно). */
  open(focus?: HTMLElement | null): void;
  /** Спрятать окно. Повторный вызов ничего не делает. */
  close(): void;
}

/** Сколько окон открыто: фон прячем, пока открыто хотя бы одно, и возвращаем после последнего. */
let openModals = 0;

/** Счётчик для идентификаторов заголовков — они должны быть уникальны на документ. */
let modalSeq = 0;

/** Фокусные элементы окна в порядке обхода — по ним Tab ходит по кругу. */
function focusableIn(root: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((node) => node.offsetParent !== null);
}

export function createModal(options: ModalOptions = {}): ModalView {
  const title = h('span', { class: 'modal-title' }, options.title ?? '');
  const headerActions = options.headerActions ?? [];
  modalSeq += 1;
  const titleId = options.label ? null : `modal-title-${modalSeq}`;
  if (titleId) title.id = titleId;

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', 'aria-label': 'Закрыть' },
    svgIcon('close', 15),
  );

  const header = h(
    'header',
    { class: 'modal-header' },
    ...(options.headerIcon ? [svgIcon(options.headerIcon, 15)] : []),
    title,
    // Контейнер кнопок держим всегда: он держит `margin-left: auto` и прижимает
    // действия с крестиком к правому краю — заголовок при этом занимает место слева.
    h('div', { class: 'modal-head-actions' }, ...headerActions, closeButton),
  );

  const body = h('div', { class: 'modal-body' });
  const modal = h(
    'div',
    {
      class: options.className ? `modal ${options.className}` : 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      ...(options.label ? { 'aria-label': options.label } : {}),
      ...(titleId ? { 'aria-labelledby': titleId } : {}),
      // Окно само берёт фокус при открытии; кольцо фокуса при этом не рисуется
      // (`:focus-visible` срабатывает только на клавиатуре).
      tabindex: '-1',
    },
    header,
    body,
    ...(options.footer ? [options.footer] : []),
  );

  const element = h('div', { class: 'modal-backdrop', hidden: true }, modal);

  /** Куда вернуть фокус при закрытии: место, из которого окно открыли. */
  let restoreFocus: HTMLElement | null = null;
  let listening = false;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (element.hidden) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      // Свой разбор Escape идёт первым: он может решить, что закрывать рано.
      if (options.onEscape?.() === true) return;
      close();
      return;
    }

    if (event.key === 'Tab') {
      // Фокус не выходит за пределы окна: дошли до края — перескочили на другой.
      const items = focusableIn(modal);
      if (items.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && modal.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  function close(): void {
    if (element.hidden) return;
    options.onClose?.();
    element.hidden = true;
    document.removeEventListener('keydown', onKeyDown, true);
    listening = false;
    // Фон снова доступен — но только если не осталось других открытых окон.
    openModals = Math.max(0, openModals - 1);
    if (openModals === 0) setBackgroundHidden(false);
    // Фокус возвращаем тому, у кого его забрали: элемент мог исчезнуть из DOM.
    const target = restoreFocus;
    restoreFocus = null;
    if (target?.isConnected) target.focus();
  }

  closeButton.addEventListener('click', () => close());

  if (options.closeOnBackdrop !== false) {
    element.addEventListener('pointerdown', (event) => {
      if (event.target === element) close();
    });
  }

  return {
    element,
    title,
    body,
    get isOpen(): boolean {
      return !element.hidden;
    },
    open(focus?: HTMLElement | null) {
      if (!element.hidden) return;
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.hidden = false;
      openModals += 1;
      setBackgroundHidden(true);
      // Слушаем в фазе перехвата и на следующем тике: иначе то же нажатие, которым
      // окно открыли (Escape от прежнего окна, «горячая» клавиша), сработало бы и здесь.
      if (!listening) {
        listening = true;
        window.setTimeout(() => {
          if (!element.hidden) document.addEventListener('keydown', onKeyDown, true);
          else listening = false;
        }, 0);
      }
      (focus ?? modal).focus();
    },
    close,
  };
}

/** Спрятать или вернуть фон приложения: пока открыто окно, читалка не должна по нему ходить. */
function setBackgroundHidden(hidden: boolean): void {
  const app = document.getElementById('app');
  if (!app) return;
  if (hidden) app.setAttribute('aria-hidden', 'true');
  else app.removeAttribute('aria-hidden');
}
