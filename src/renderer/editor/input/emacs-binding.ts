/**
 * Emacs-режим: исполнение разобранных сочетаний.
 *
 * Разбор — в `emacs.ts` (чистый, без DOM). Здесь команда ложится на контроллер: движения
 * двигают каретку, «убивающие» правки удаляют текст и кладут его в кольцо убитого, а Ctrl+Y
 * возвращает последнее убитое на место. Слой встраивается в ввод одной проверкой
 * (см. `editor-input.ts`).
 *
 * Кольцо убитого упрощено до одного места: запоминается только последнее убитое. В настоящем
 * Emacs их список, и несколько Ctrl+K подряд сливаются в один кусок; здесь этого нет —
 * для правки кода хватает и одного.
 *
 * Метка (Ctrl+Space) — это якорь выделения: пока она стоит, движения тянут выделение от
 * неё (как с зажатым Shift), а Ctrl+G или любая правка её снимают.
 */

import type { EditorController } from './editor-controller';
import { moveWordLeft, moveWordRight } from './motions';
import type { KeyChord } from './keymap';
import { resolveEmacs, type EmacsCommand, type EmacsMotion } from './emacs';

/**
 * Emacs-режим над одним редактором. Включается настройкой `editor.emacsMode`; пока выключен,
 * `handleKey` отвечает `false` и ввод работает как обычно.
 */
export class EmacsBinding {
  private on = false;
  /** Последнее убитое — что вернёт Ctrl+Y. */
  private kill = '';
  /** Якорь метки (`null` — метка не стоит). */
  private markAnchor: number | null = null;

  constructor(private readonly controller: EditorController) {}

  /** Включён ли режим. */
  get enabled(): boolean {
    return this.on;
  }

  /** Стоит ли метка (для проверок и отладки). */
  get mark(): number | null {
    return this.markAnchor;
  }

  /** Включить или выключить. При выключении метка снимается. */
  setEnabled(on: boolean): void {
    this.on = on;
    if (!on) this.clearMark();
  }

  /** Снять метку: её снимают правки и сброс (Ctrl+G). */
  clearMark(): void {
    this.markAnchor = null;
  }

  /** Дотянуться до сочетания. `true` — нажатие наше, обычной раскладке его не отдавать. */
  handleKey(chord: KeyChord): boolean {
    if (!this.on) return false;
    const command = resolveEmacs(chord);
    if (!command) return false;
    this.run(command);
    return true;
  }

  private run(command: EmacsCommand): void {
    switch (command.kind) {
      case 'move':
        this.move(command.motion);
        break;
      case 'deleteForward':
        this.clearMark();
        this.controller.deleteForward();
        break;
      case 'deleteBackward':
        this.clearMark();
        this.controller.backspace();
        break;
      case 'killLine':
        this.killLine();
        break;
      case 'killToStart':
        this.killToStart();
        break;
      case 'killWordForward':
        this.killWordForward();
        break;
      case 'killWordBackward':
        this.killWordBackward();
        break;
      case 'yank':
        this.yank();
        break;
      case 'setMark':
        this.setMark();
        break;
      case 'cancel':
        this.clearMark();
        // Ctrl+G — «keyboard-quit»: метка снимается, а каретка остаётся на месте (выделение схлопывается).
        this.controller.setSelection({
          anchor: this.controller.selection.active,
          active: this.controller.selection.active,
        });
        break;
      case 'undo':
        this.clearMark();
        this.controller.undo();
        break;
      case 'transpose':
        this.clearMark();
        this.controller.transpose();
        break;
      case 'openLine':
        this.openLine();
        break;
    }
  }

  /** Движение: при стоящей метке оно тянет выделение от якоря. */
  private move(motion: EmacsMotion): void {
    const extend = this.markAnchor !== null;
    switch (motion) {
      case 'left':
        this.controller.moveLeft(extend);
        break;
      case 'right':
        this.controller.moveRight(extend);
        break;
      case 'up':
        this.controller.moveVertical(-1, extend);
        break;
      case 'down':
        this.controller.moveVertical(1, extend);
        break;
      case 'wordLeft':
        this.controller.moveWordLeft(extend);
        break;
      case 'wordRight':
        this.controller.moveWordRight(extend);
        break;
      case 'lineStart':
        this.controller.moveLineStart(extend);
        break;
      case 'lineEnd':
        this.controller.moveLineEnd(extend);
        break;
      case 'docStart':
        this.controller.moveDocStart(extend);
        break;
      case 'docEnd':
        this.controller.moveDocEnd(extend);
        break;
    }
  }

  /** Ctrl+Space: поставить метку, а если она уже стоит — снять и оставить каретку. */
  private setMark(): void {
    const caret = this.controller.caret;
    this.markAnchor = this.markAnchor === null ? caret : null;
    this.controller.setSelection({ anchor: caret, active: caret });
  }

  /** Ctrl+K: убить до конца строки; если строка кончилась — убить перевод строки. */
  private killLine(): void {
    this.clearMark();
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    const end = start + buffer.lineText(line).length;
    if (offset < end) {
      const removed = buffer.getText(offset, end);
      this.kill = removed;
      this.controller.applyEdit({ start: offset, removed, inserted: '' });
      return;
    }
    if (line < buffer.lineCount) {
      const next = buffer.lineStart(line + 1);
      const removed = buffer.getText(offset, next);
      this.kill = removed;
      this.controller.applyEdit({ start: offset, removed, inserted: '' });
    }
  }

  /** Ctrl+U: убить от начала строки до каретки. */
  private killToStart(): void {
    this.clearMark();
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const start = buffer.lineStart(buffer.lineAt(offset));
    if (offset <= start) return;
    const removed = buffer.getText(start, offset);
    this.kill = removed;
    this.controller.applyEdit({ start, removed, inserted: '' });
  }

  /** Alt+D: убить слово вперёд. */
  private killWordForward(): void {
    this.clearMark();
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const to = moveWordRight(buffer, offset);
    if (to <= offset) return;
    const removed = buffer.getText(offset, to);
    this.kill = removed;
    this.controller.applyEdit({ start: offset, removed, inserted: '' });
  }

  /** Alt+Backspace: убить слово назад. */
  private killWordBackward(): void {
    this.clearMark();
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const from = moveWordLeft(buffer, offset);
    if (from >= offset) return;
    const removed = buffer.getText(from, offset);
    this.kill = removed;
    this.controller.applyEdit({ start: from, removed, inserted: '' });
  }

  /** Ctrl+Y: вставить последнее убитое в каретку. */
  private yank(): void {
    this.clearMark();
    if (this.kill.length > 0) this.controller.paste(this.kill);
  }

  /** Ctrl+O: перевод строки в каретке, сама каретка остаётся перед ним. */
  private openLine(): void {
    this.clearMark();
    const offset = this.controller.caret;
    this.controller.applyEdit({ start: offset, removed: '', inserted: '\n' }, { anchor: offset, active: offset });
  }
}
