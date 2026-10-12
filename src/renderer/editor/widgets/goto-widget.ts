/**
 * Переход к строке по номеру (Ctrl+G).
 *
 * Маленькая панель с одним полем: человек помнит «ошибка на 412-й строке» и хочет
 * там оказаться, а не листать. Поэтому в поле сразу подставлен текущий номер — если
 * нужна соседняя строка, дописать цифру быстрее, чем набирать её целиком.
 *
 * Ввод номера разбирается прощающе: пробелы по краям не мешают, а номер за концом
 * файла прижимается к последней строке. Ошибкой это не считается — человек хотел
 * ближе к концу, а не «получил отказ».
 */

import type { TextBuffer } from '../core/text-buffer';
import type { EditorController } from '../input/editor-controller';
import type { EditorView } from '../view/editor-view';

export class GotoLineWidget {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private buffer: TextBuffer;
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly hint: HTMLElement;
  private visible = false;

  /** Куда вернуть фокус после закрытия — задаёт тот, кто виджет создал. */
  onClose: (() => void) | null = null;

  constructor(view: EditorView, controller: EditorController, buffer: TextBuffer) {
    this.view = view;
    this.controller = controller;
    this.buffer = buffer;

    this.root = document.createElement('div');
    this.root.className = 'own-editor-goto';
    this.root.hidden = true;

    const label = document.createElement('span');
    label.className = 'own-editor-goto-label';
    label.textContent = 'Строка:';

    this.input = document.createElement('input');
    this.input.className = 'own-editor-goto-input';
    this.input.type = 'text';
    this.input.inputMode = 'numeric';
    this.input.setAttribute('aria-label', 'Номер строки');

    this.hint = document.createElement('span');
    this.hint.className = 'own-editor-goto-hint';

    this.root.append(label, this.input, this.hint);
    view.element.append(this.root);

    this.input.addEventListener('keydown', this.onKeyDown);
    // Обёртка, а не голый метод: в `addEventListener` метод вызывается на элементе,
    // и `this` внутри перестаёт быть виджетом (проба это и поймала).
    this.input.addEventListener('input', () => this.updateHint());
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Новый документ: прежний номер строки к нему не относится, панель прячем. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    if (this.visible) this.hide();
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    this.input.value = String(this.buffer.lineAt(this.controller.caret));
    this.updateHint();
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.onClose?.();
  }

  /** Подсказка внизу поля: какой номер будет, если нажать Enter прямо сейчас. */
  private updateHint(): void {
    const total = this.buffer.lineCount;
    const raw = this.input.value.trim();
    if (!/^\d+$/.test(raw)) {
      this.hint.textContent = `всего строк: ${total}`;
      return;
    }
    // Подсказываем о прижатии: номер за концом файла — не ошибка, но знать о ней стоит.
    const value = Number.parseInt(raw, 10);
    this.hint.textContent = value > total ? `из ${total} (последняя)` : `из ${total}`;
  }

  /** Номер из поля или `null`, если там не число. */
  private parse(): number | null {
    return parseLineNumber(this.input.value, this.buffer.lineCount);
  }

  /** Встать на строку: курсор в её начало, прокрутка к ней. */
  private go(): void {
    const line = this.parse();
    if (line === null) return;
    const target = Math.max(1, Math.min(line, this.buffer.lineCount));
    const offset = this.buffer.lineStart(target);
    this.controller.selectRange(offset, offset);
    this.view.revealOffset(offset);
    this.hide();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.go();
    }
  };

  dispose(): void {
    this.root.remove();
  }
}

/**
 * Номер строки из того, что ввели в поле. `null` — там не число (тогда переход не
 * выполняется). Номер прижимается к границам файла: за концом — последняя строка.
 *
 * Чистая функция: разбор ввода проверяется без окна.
 */
export function parseLineNumber(input: string, lineCount: number): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (value < 1) return 1;
  return Math.min(value, Math.max(1, lineCount));
}
