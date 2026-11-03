import { h, svgIcon, type IconName } from './dom';
import { NoticeRegistry } from '../core/notice-registry';

export type ToastKind = 'info' | 'error' | 'success';

/** Кнопка в уведомлении: короткий глагол и его действие, например «Отменить». */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastOptions {
  /** Кнопка действия — например «Отменить»: возвращает только что сделанное. */
  action?: ToastAction;
  /**
   * Ключ уведомления: одно событие — один тост.
   *
   * Без ключа каждый вызов рисует свой тост, и повтор в цикле (LSP отвечает на
   * каждое сохранение, git — на каждый файл) засыпает экран одинаковыми
   * строками. С ключом повтор поднимает уже висящий тост и увеличивает счётчик,
   * а группа до двоеточия глушится целиком (`registry.mute('lsp')`).
   */
  key?: string;
}

let container: HTMLElement | null = null;

/** Значок по роли уведомления: успех — галочка, ошибка — предупреждение, прочее — «искра». */
const TOAST_ICON: Record<ToastKind, IconName> = {
  info: 'sparkle',
  error: 'warning',
  success: 'check',
};

/** Одноразовые уведомления в правом нижнем углу — самый дешёвый способ показать ошибку. */
/**
 * Журнал уведомлений: пока тосты — это только то, что видно сейчас. Реестр
 * помнит историю, счётчики повторов и приглушённые группы.
 */
export const notices = new NoticeRegistry();

export function showToast(message: string, kind: ToastKind = 'info', options: ToastOptions = {}): void {
  // Ключ задан — спрашиваем реестр, показывать ли. Без ключа поведение прежнее:
  // у большинства сообщений ключ не нужен, они и так уникальны.
  let text = message;
  if (options.key) {
    const outcome = notices.push({ key: options.key, text: message, kind });
    // Группа приглушена — не показываем, но в историю уже записали.
    if (!outcome.toast) return;
    // Повтор: не второй тост, а тот же со счётчиком. Иначе пачка одинаковых
    // строк закрывает собой всё, что человек читает.
    if (outcome.repeat && outcome.notice.count > 1) text = `${message} (×${outcome.notice.count})`;
  }

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
    h('span', { class: 'toast-text' }, text),
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
