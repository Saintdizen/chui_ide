import { h } from './dom';
import { createModal } from './modal';

/**
 * Небольшой диалог с одним полем ввода.
 *
 * Нужен там, где у значения нет формы с сохранением: например, условие точки
 * останова. Системный `dialog` из Electron текста не принимает, поэтому окно
 * собирается нашим каркасом (см. `ui/modal.ts`): Esc, клик мимо, фокус и
 * возврат фокуса — общие для всех окон.
 */
export interface PromptOptions {
  title: string;
  /** Подпись над полем: что именно вводят. */
  label: string;
  /** Начальное значение. */
  value?: string;
  placeholder?: string;
  /** Подпись кнопки подтверждения. */
  confirmLabel?: string;
  /** Вызывается с введённым текстом (уже без пробелов по краям). */
  onAccept(value: string): void;
  /** Вызывается, если окно закрыли, ничего не введя (Esc, крестик, клик мимо). */
  onCancel?(): void;
}

export interface PromptModalView {
  element: HTMLElement;
  open(options: PromptOptions): void;
  close(): void;
}

export function createPromptModal(): PromptModalView {
  const label = h('span', { class: 'venv-label' });
  const input = h('input', { class: 'field-input', type: 'text', spellcheck: 'false' });
  const hint = h('div', { class: 'field-hint' });
  const confirmButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'ОК');

  // Текущие обработчики: у каждого открытия свои (см. `open`).
  let accept: ((value: string) => void) | null = null;
  let cancel: (() => void) | null = null;
  /** Кто закрыл окно: крестик и Escape — отмена, подтверждение — нет. */
  let cancelled = true;

  const modal = createModal({
    className: 'prompt-modal',
    footer: h('footer', { class: 'modal-footer' }, confirmButton),
    onClose: () => {
      const onCancel = cancel;
      accept = null;
      cancel = null;
      // Отмену сообщаем только тем, кто её ждёт: обычному диалогу она не нужна.
      if (cancelled) onCancel?.();
      cancelled = true;
    },
  });
  modal.body.append(h('div', { class: 'venv-field' }, label, input), hint);

  function close(): void {
    modal.close();
  }

  function submit(): void {
    const value = input.value.trim();
    const handler = accept;
    // Закрытие «не отменой»: подрядчик уже получит значение, отмену не шлём.
    cancelled = false;
    modal.close();
    handler?.(value);
  }

  input.addEventListener('keydown', (event) => {
    // Enter подтверждает из поля: диалог короткий, тянуться к кнопке незачем.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  });
  confirmButton.addEventListener('click', () => submit());

  return {
    element: modal.element,
    open(options: PromptOptions) {
      modal.title.textContent = options.title;
      label.textContent = options.label;
      input.value = options.value ?? '';
      input.placeholder = options.placeholder ?? '';
      hint.textContent = '';
      confirmButton.textContent = options.confirmLabel ?? 'ОК';
      accept = options.onAccept;
      cancel = options.onCancel ?? null;
      cancelled = true;

      modal.open(input);
      input.select();
    },
    close,
  };
}
