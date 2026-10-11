import { h, svgIcon } from './dom';

export interface TextModalView {
  element: HTMLElement;
  /** Показать текст: заголовок и содержимое. Содержимое выводится как есть (моно). */
  open(title: string, text: string): void;
  close(): void;
}

/**
 * Окно с текстом только для чтения — моноширинным, с прокруткой.
 *
 * Нужно там, где показывать нужно готовый текст от git, а не файл из рабочей папки:
 * например, историю в виде графа веток (`git log --graph`). Своё представление
 * графа не делаем — ASCII-схему git проще показать как есть.
 */
export function createTextModal(): TextModalView {
  const title = h('span', { class: 'modal-title' });
  const body = h('pre', { class: 'text-modal-body' });

  const close = (): void => {
    element.hidden = true;
  };

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 15),
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal text-modal', role: 'dialog', 'aria-modal': 'true' },
      h('header', { class: 'modal-header' }, title, closeButton),
      body,
    ),
  );

  document.addEventListener('keydown', (event) => {
    if (!element.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  return {
    element,
    open(heading, text) {
      title.textContent = heading;
      body.textContent = text || '(пусто)';
      element.hidden = false;
    },
    close,
  };
}
