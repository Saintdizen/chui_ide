import { h } from './dom';
import { createModal } from './modal';

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
 *
 * Каркас (задник, шапка, Escape, фокус) — общий, см. `ui/modal.ts`.
 */
export function createTextModal(): TextModalView {
  const body = h('pre', { class: 'text-modal-body' });
  const modal = createModal({ className: 'text-modal' });
  modal.body.append(body);

  return {
    element: modal.element,
    open(heading, text) {
      modal.title.textContent = heading;
      body.textContent = text || '(пусто)';
      modal.open();
    },
    close: modal.close,
  };
}
