import { h, svgIcon, type IconName } from './dom';

export type ToastKind = 'info' | 'error' | 'success';

/** Кнопка в уведомлении: короткий глагол и его действие, например «Отменить». */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastOptions {
  /** Кнопка действия — например «Отменить»: возвращает только что сделанное. */
  action?: ToastAction;
}

let container: HTMLElement | null = null;

/** Значок по роли уведомления: успех — галочка, ошибка — предупреждение, прочее — «искра». */
const TOAST_ICON: Record<ToastKind, IconName> = {
  info: 'sparkle',
  error: 'warning',
  success: 'check',
};

/** Одноразовые уведомления в правом нижнем углу — самый дешёвый способ показать ошибку. */
export function showToast(message: string, kind: ToastKind = 'info', options: ToastOptions = {}): void {
  if (!container) {
    // Область живёт всё время: читалка замечает подмену содержимого только у того
    // узла, который уже был в документе, — на созданном «в момент события» она молчит.
    container = h('div', { class: 'toasts', role: 'region', 'aria-live': 'polite', 'aria-label': 'Уведомления' });
    document.body.appendChild(container);
  }

  const action = options.action;
  const toast = h(
    'div',
    {
      class: `toast toast-${kind}`,
      title: 'Нажмите, чтобы закрыть',
      // Ошибку объявляем сразу (это важное), остальное — когда читалка дойдёт.
      role: kind === 'error' ? 'alert' : 'status',
    },
    svgIcon(TOAST_ICON[kind], 14),
    h('span', { class: 'toast-text' }, message),
    // Кнопка — настоящий `<button>`: берётся фокусом с клавиатуры, а её клик
    // не закрывает уведомление (иначе «Отменить» не успело бы выполниться).
    action &&
      h(
        'button',
        {
          type: 'button',
          class: 'toast-action',
          onclick: (event: Event) => {
            event.stopPropagation();
            toast.remove();
            void action.run();
          },
        },
        action.label,
      ),
  );

  toast.addEventListener('click', () => toast.remove());
  container.appendChild(toast);

  // Тост с действием живёт дольше: за обычные 4 секунды человек не успеет
  // передумать и нажать «Отменить».
  setTimeout(
    () => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 220);
    },
    action ? 8000 : kind === 'error' ? 8000 : 4000,
  );
}
