/**
 * Emacs-режим: исполнение разобранных сочетаний.
 *
 * Разбор — в `emacs.ts` (чистый, без DOM). Здесь команда ложится на контроллер: движения
 * двигают каретку, «убивающие» правки удаляют текст и кладут его в кольцо убитого, а Ctrl+Y
 * возвращает последнее убитое на место. Слой встраивается в ввод одной проверкой
 * (см. `editor-input.ts`).
 *
 * Кольцо убитого — настоящий список: несколько «убивающих» команд подряд (Ctrl+K, Alt+D,
 * Alt+Backspace…) сливаются в один кусок, а Ctrl+Y вставляет самый свежий. Alt+Y («yank-pop»)
 * прокручивает кольцо, заменяя только что вставленное на предыдущее убитое.
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
  /** Кольцо убитого: список убитых кусков, последний — самый свежий (его вернёт Ctrl+Y). */
  private killRing: string[] = [];
  /** Предыдущая команда была «убивающей»: следующий kill сливается с прежним куском. */
  private killAppend = false;
  /** Где начнётся и как длинно последнее вставленное — чтобы Alt+Y заменил именно его. */
  private yankStart: number | null = null;
  private yankLength = 0;
  /** Место в кольце, с которого начался yank-pop. */
  private killIndex = 0;
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
    // Подряд идущие убийства сливаются; всё остальное прерывает этот ряд.
    if (!isKill(command)) this.killAppend = false;
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
      case 'yankPop':
        this.yankPop();
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
      this.pushKill(removed, false);
      this.controller.applyEdit({ start: offset, removed, inserted: '' });
      return;
    }
    if (line < buffer.lineCount) {
      const next = buffer.lineStart(line + 1);
      const removed = buffer.getText(offset, next);
      this.pushKill(removed, false);
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
    this.pushKill(removed, true);
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
    this.pushKill(removed, false);
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
    this.pushKill(removed, true);
    this.controller.applyEdit({ start: from, removed, inserted: '' });
  }

  /**
   * Положить убитое в кольцо. Подряд идущие убийства сливаются в один кусок: вперёд
   * (`Ctrl+K`, `Alt+D`) — с дописыванием в конец, назад (`Ctrl+U`, `Alt+Backspace`) — в начало.
   */
  private pushKill(text: string, prepend: boolean): void {
    if (text.length === 0) return;
    const ring = this.killRing;
    if (this.killAppend && ring.length > 0) {
      const last = ring[ring.length - 1]!;
      ring[ring.length - 1] = prepend ? `${text}${last}` : `${last}${text}`;
    } else {
      ring.push(text);
    }
    this.killAppend = true;
    // Новое убийство прерывает прокрутку: заменять уже вставленное больше нечем.
    this.yankStart = null;
  }

  /** Ctrl+Y: вставить самое свежее убитое в каретку. */
  private yank(): void {
    this.clearMark();
    const ring = this.killRing;
    if (ring.length === 0) return;
    this.killIndex = ring.length - 1;
    const at = this.controller.caret;
    this.controller.paste(ring[this.killIndex]!);
    // Запомним, что именно легло и куда: Alt+Y заменит ровно этот кусок.
    this.yankStart = at;
    this.yankLength = this.controller.caret - at;
    this.killAppend = false;
  }

  /** Alt+Y: заменить только что вставленное на предыдущее убитое, прокручивая кольцо. */
  private yankPop(): void {
    const start = this.yankStart;
    const ring = this.killRing;
    if (start === null || ring.length === 0) return;
    this.clearMark();
    this.killIndex = (this.killIndex - 1 + ring.length) % ring.length;
    const text = ring[this.killIndex]!;
    const buffer = this.controller.bufferRef;
    const removed = buffer.getText(start, start + this.yankLength);
    const end = start + text.length;
    this.controller.applyEdit({ start, removed, inserted: text }, { anchor: end, active: end });
    this.yankLength = text.length;
    this.killAppend = false;
  }

  /** Ctrl+O: перевод строки в каретке, сама каретка остаётся перед ним. */
  private openLine(): void {
    this.clearMark();
    const offset = this.controller.caret;
    this.controller.applyEdit({ start: offset, removed: '', inserted: '\n' }, { anchor: offset, active: offset });
  }
}

/** «Убивающая» команда — та, что кладёт текст в кольцо (и участвует в слиянии подряд). */
function isKill(command: EmacsCommand): boolean {
  return (
    command.kind === 'killLine' ||
    command.kind === 'killToStart' ||
    command.kind === 'killWordForward' ||
    command.kind === 'killWordBackward'
  );
}
