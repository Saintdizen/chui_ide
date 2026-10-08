import { h, svgIcon } from './dom';

export type ToastKind = 'info' | 'error';

let container: HTMLElement | null = null;

/** Одноразовые уведомления в правом нижнем углу — самый дешёвый способ показать ошибку. */
export function showToast(message: string, kind: ToastKind = 'info'): void {
  if (!container) {
    container = h('div', { class: 'toasts' });
    document.body.appendChild(container);
  }

  const toast = h(
    'div',
    { class: `toast toast-${kind}`, title: 'Нажмите, чтобы закрыть' },
    svgIcon(kind === 'error' ? 'warning' : 'sparkle', 14),
    h('span', { class: 'toast-text' }, message),
  );

  toast.addEventListener('click', () => toast.remove());
  container.appendChild(toast);

  setTimeout(
    () => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 220);
    },
    kind === 'error' ? 8000 : 4000,
  );
}
