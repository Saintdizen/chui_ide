import { h, svgIcon } from './dom';

/**
 * Небольшой диалог с одним полем ввода.
 *
 * Нужен там, где у значения нет формы с сохранением: например, условие точки
 * останова. Системный `dialog` из Electron текста не принимает, а тащить ради
 * одной строки полноценный модальный фреймворк незачем — стили модалок уже есть.
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
  const title = h('span', { class: 'modal-title' });
  const label = h('span', { class: 'venv-label' });
  const input = h('input', { class: 'field-input', type: 'text', spellcheck: 'false' });
  const hint = h('div', { class: 'field-hint' });
  const confirmButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'ОК');
  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: () => close() },
    svgIcon('close', 15),
  );

  // Текущие обработчики: у каждого открытия свои (см. `open`).
  let accept: ((value: string) => void) | null = null;
  let cancel: (() => void) | null = null;

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal prompt-modal', role: 'dialog', 'aria-modal': 'true' },
      h('header', { class: 'modal-header' }, title, closeButton),
      h('div', { class: 'modal-body' }, h('div', { class: 'venv-field' }, label, input), hint),
      h('footer', { class: 'modal-footer' }, confirmButton),
    ),
  );

  function close(cancelled = true): void {
    if (element.hidden) return;
    element.hidden = true;
    const onCancel = cancel;
    accept = null;
    cancel = null;
    document.removeEventListener('keydown', onKeyDown, true);
    // Отмену сообщаем только тем, кто её ждёт: обычному диалогу она не нужна.
    if (cancelled) onCancel?.();
  }

  function submit(): void {
    const value = input.value.trim();
    const handler = accept;
    // Закрытие «не отменой»: подрядчик уже получит значение, отмену не шлём.
    close(false);
    handler?.(value);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  input.addEventListener('keydown', (event) => {
    // Enter подтверждает из поля: диалог короткий, тянуться к кнопке незачем.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  });
  confirmButton.addEventListener('click', () => submit());

  // Клик по затемнению закрывает окно, клик по самому окну — нет.
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  return {
    element,
    open(options: PromptOptions) {
      title.textContent = options.title;
      label.textContent = options.label;
      input.value = options.value ?? '';
      input.placeholder = options.placeholder ?? '';
      hint.textContent = '';
      confirmButton.textContent = options.confirmLabel ?? 'ОК';
      accept = options.onAccept;
      cancel = options.onCancel ?? null;

      element.hidden = false;
      // Слушаем в capture и позже текущего клика, иначе Esc сработает на открытии.
      document.removeEventListener('keydown', onKeyDown, true);
      window.setTimeout(() => document.addEventListener('keydown', onKeyDown, true), 0);
      input.focus();
      input.select();
    },
    close,
  };
}
