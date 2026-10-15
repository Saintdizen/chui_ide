/**
 * Vim-режим: исполнение разобранных команд.
 *
 * Разбор — в `vim.ts` (чистый, без DOM). Здесь команда ложится на контроллер: движения
 * двигают каретку, операторы правят текст, — а состояние режима ведётся между нажатиями.
 * Слой самодостаточен: он не знает ни о видах, ни о попапах, и встраивается в ввод
 * одной проверкой (см. `editor-input.ts`).
 *
 * Несколько решений, о которых стоит знать:
 *
 *   • Регистр — один (безымянный), как `"` в Vim: что удалили или скопировали последним,
 *     то и вставится по `p`. Именованных регистров нет.
 *   • `cw` меняет слово до его конца (как `ce`), а не с пробелом — так делает Vim, и это
 *     тот случай, который человек замечает чаще всего.
 *   • Правка ложится в историю ОДНИМ шагом (`applyEdit`): `dd` отменяется одним Ctrl+Z.
 *   • `.` повторяет последнюю правку. Для вставки помним и набранный текст: `cwfoo<Esc>`
 *     повторяется как «сменить слово на foo», а не только как удаление. Что описать
 *     текстом нельзя (стрелки, Delete, состав IME), повторять не берёмся — лучше
 *     промолчать, чем повторить неверно.
 *   • Поиск `/`, `?` и шаги `n`, `N` отдаём наружу: строка поиска — не наша забота,
 *     её ведёт панель поиска редактора. Сюда же уходит и направление последнего поиска,
 *     чтобы `n` шёл «туда же».
 */

import type { EditorController } from './editor-controller';
import { columnAt } from './motions';
import type { KeyChord } from './keymap';
import {
  isHorizontalMotion,
  toggleCaseText,
  vimInitialState,
  vimKey,
  vimMotionRange,
  vimMoveTarget,
  type InsertPlace,
  type VimCommand,
  type VimMode,
  type VimMotion,
  type VimOperator,
  type VimRange,
  type VimState,
} from './vim';

/** Безымянный регистр: последнее удалённое или скопированное. */
interface VimRegister {
  text: string;
  linewise: boolean;
}

/**
 * Запись последней правки — то, что повторяет `.`. Кроме самой команды помним текст,
 * набранный во вставке, которую она открыла: `cwfoo<Esc>` повторяется целиком.
 */
interface VimChange {
  command: VimCommand;
  /** Что набрали в открытой вставке; `undefined` — команда не открывала вставку. */
  insertText?: string;
}

/** Что Vim просит у поиска: открыть строку поиска или шагнуть к совпадению. */
export type VimSearchAction =
  | { readonly kind: 'open'; readonly forward: boolean }
  | { readonly kind: 'step'; readonly forward: boolean };

/**
 * Vim-режим над одним редактором. Включается настройкой `editor.vimMode`; пока выключен,
 * `handleKey` отвечает `false` и ввод работает как обычно.
 */
export class VimBinding {
  private state: VimState = vimInitialState('normal');
  /** Неподвижный конец визуального выделения. */
  private visualAnchor = 0;
  /** Желаемый столбец для вертикальных движений. */
  private goal = 0;
  private register: VimRegister = { text: '', linewise: false };
  private on = false;
  /** Последняя правка — что повторяет `.`. `null` — повторять нечего. */
  private lastChange: VimChange | null = null;
  /** Команда, открывшая вставку: её текст допишем при выходе — для повтора `.`. */
  private pendingInsert: { command: VimCommand; changed: boolean } | null = null;
  /** Что набрали в режиме вставки — из этого собирается текст для `.`. */
  private insertTyped = '';
  /** Нажатие в вставке нельзя описать текстом (стрелки, Delete, IME) — повтор пропустим. */
  private insertExact = true;
  /** Идёт повтор: во время него новую «последнюю правку» не записываем. */
  private replaying = false;
  /** Направление последнего `/` или `?` — по нему идут `n` и `N`. */
  private searchForward = true;

  constructor(
    private readonly controller: EditorController,
    /** Смена режима — для значка в строке состояния. */
    private readonly onModeChange?: (mode: VimMode) => void,
    /** Поиск `/`/`?` и шаги `n`/`N` — их ведёт панель поиска, не Vim. */
    private readonly onSearch?: (action: VimSearchAction) => void,
  ) {}

  /** Включён ли режим. */
  get enabled(): boolean {
    return this.on;
  }

  /** Текущий режим: выключенный режим ведёт себя как вставка. */
  get mode(): VimMode {
    return this.on ? this.state.mode : 'insert';
  }

  /**
   * Включить или выключить. При включении всегда начинаем с нормального режима.
   * `notify` — говорить ли о смене режима наружу: при сборке редактора слушателя ещё
   * нет, и дёргать его рано (см. `editor-input.ts`).
   */
  setEnabled(on: boolean, notify = true): void {
    this.on = on;
    this.state = vimInitialState('normal');
    // Незавершённую вставку забываем: её текст к новому включению не относится.
    this.pendingInsert = null;
    this.insertTyped = '';
    this.insertExact = true;
    if (notify) this.onModeChange?.(this.mode);
  }

  /** Дотянуться до клавиши. `true` — нажатие наше, редактору его отдавать не надо. */
  handleKey(chord: KeyChord): boolean {
    if (!this.on) return false;

    // В режиме вставки Vim забирает только выход из него; остальное — обычный ввод.
    // Но каждое нажатие запоминаем: из них собирается текст для повтора `.`.
    if (this.state.mode === 'insert') {
      if (chord.key === 'Escape' || (chord.ctrl === true && chord.key === '[')) {
        this.leaveInsert();
        return true;
      }
      this.noteInsertKey(chord);
      return false;
    }

    // Cmd-сочетания в нормальном режиме не трогаем: пусть работают обычные команды.
    if (chord.meta === true && chord.ctrl !== true) return false;

    const step = vimKey(chord, this.state);
    if (step.kind === 'pass') return false;
    this.state = step.state;
    if (step.kind === 'wait') return true;
    this.run(step.command);
    return true;
  }

  /** Выйти из вставки в нормальный режим: каретка отступает на знак назад, как в Vim. */
  private leaveInsert(): void {
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const target = vimMoveTarget(buffer, offset, 'charLeft', 1, 0).offset;
    if (target !== offset) this.controller.setSelection({ anchor: target, active: target });
    this.setMode('normal');
    this.finishInsert();
  }

  /**
   * Запомнить нажатие, набранное в режиме вставки: из этих знаков собирается текст для
   * повтора `.`. Что собрать нельзя (стрелки, Delete, состав IME) — помечаем, и тогда
   * текст вставки для повтора не берём: повторить неверно хуже, чем не повторить.
   */
  private noteInsertKey(chord: KeyChord): void {
    if (!this.insertExact) return;
    if (chord.ctrl === true || chord.meta === true) {
      this.insertExact = false;
      return;
    }
    const { key } = chord;
    if (key === 'Backspace') {
      this.insertTyped = this.insertTyped.slice(0, -1);
      return;
    }
    if (key === 'Enter') {
      this.insertTyped += '\n';
      return;
    }
    if (key === 'Tab') {
      this.insertTyped += '\t';
      return;
    }
    if (key.length === 1) {
      this.insertTyped += key;
      return;
    }
    // Delete, Home, End, стрелки, Process (состав IME) — текстом не опишем.
    this.insertExact = false;
  }

  /** Закрыть вставку: собрать её в «последнюю правку» для повтора `.`. */
  private finishInsert(): void {
    const pending = this.pendingInsert;
    this.pendingInsert = null;
    if (!pending || this.replaying) return;
    const typed = this.insertExact ? this.insertTyped : '';
    // Чистая вставка без текста (`i<Esc>`) ничего не меняла — прежний повтор не трогаем.
    if (typed === '' && !pending.changed) return;
    this.lastChange = typed === '' ? { command: pending.command } : { command: pending.command, insertText: typed };
  }

  private setMode(mode: VimMode): void {
    if (this.state.mode === mode) return;
    this.state = { ...this.state, mode };
    if (mode === 'visual' || mode === 'visual-line') this.visualAnchor = this.controller.caret;
    this.onModeChange?.(mode);
  }

  private run(command: VimCommand): void {
    this.record(command);
    switch (command.kind) {
      case 'mode':
        this.setMode(command.mode);
        break;
      case 'motion':
        this.applyMotion(command.motion, command.count);
        break;
      case 'operator':
        this.applyOperator(command.operator, command.motion, command.count);
        break;
      case 'operatorLines':
        this.applyOperatorLines(command.operator, command.count);
        break;
      case 'operatorSelection':
        this.applyOperatorSelection(command.operator);
        break;
      case 'deleteChar':
        this.deleteChars(command.count);
        break;
      case 'deleteCharBefore':
        this.deleteCharsBefore(command.count);
        break;
      case 'deleteToEnd':
        this.deleteToEnd(command.change);
        break;
      case 'put':
        this.put(command.after, command.count);
        break;
      case 'undo':
        this.controller.undo();
        break;
      case 'redo':
        this.controller.redo();
        break;
      case 'join':
        this.join(command.count);
        break;
      case 'enterInsert':
        this.enterInsert(command.at);
        break;
      case 'replaceChar':
        this.replaceChar(command.char, command.count);
        break;
      case 'toggleCase':
        this.toggleCase(command.count);
        break;
      case 'swapEnds':
        this.swapEnds();
        break;
      case 'repeat':
        this.repeat();
        break;
      case 'search':
        this.openSearch(command.forward);
        break;
      case 'searchRepeat':
        this.repeatSearch(command.same);
        break;
    }
  }

  /**
   * Запомнить правку для повтора `.`. Правкой считаем то, что меняет текст; движения,
   * смена режима, отмена и поиск — не правки. Команда, открывающая вставку, ждёт выхода
   * из неё: тогда к записи добавится набранный текст (см. `finishInsert`).
   */
  private record(command: VimCommand): void {
    if (this.replaying) return;
    switch (command.kind) {
      case 'operator':
      case 'operatorLines':
      case 'operatorSelection':
        if (command.operator === 'yank') return; // копирование текста не меняет
        if (command.operator === 'change') {
          this.pendingInsert = { command, changed: true };
          return;
        }
        this.lastChange = { command };
        return;
      case 'deleteToEnd':
        if (command.change) {
          this.pendingInsert = { command, changed: true };
          return;
        }
        this.lastChange = { command };
        return;
      case 'deleteChar':
      case 'deleteCharBefore':
      case 'put':
      case 'join':
      case 'replaceChar':
      case 'toggleCase':
        this.lastChange = { command };
        return;
      case 'enterInsert':
        this.pendingInsert = { command, changed: false };
        return;
      default:
        // motion, mode, undo, redo, swapEnds, repeat, search, searchRepeat — не правки.
        return;
    }
  }

  /** `.` — повторить последнюю правку (для вставки — вместе с набранным текстом). */
  private repeat(): void {
    const change = this.lastChange;
    if (!change) return;
    this.replaying = true;
    try {
      this.run(change.command);
      if (change.insertText !== undefined && change.insertText !== '') {
        this.insertText(change.insertText);
        this.setMode('normal');
      }
    } finally {
      this.replaying = false;
    }
  }

  /** Вставить текст в каретку — повтор вставки по `.`. */
  private insertText(text: string): void {
    const offset = this.controller.caret;
    const at = offset + text.length;
    this.controller.applyEdit({ start: offset, removed: '', inserted: text }, { anchor: at, active: at });
  }

  /** `/` и `?` — открыть строку поиска. Направление помним: по нему пойдут `n` и `N`. */
  private openSearch(forward: boolean): void {
    this.searchForward = forward;
    this.onSearch?.({ kind: 'open', forward });
  }

  /** `n`/`N` — шаг к следующему (`same`) или обратному совпадению. */
  private repeatSearch(same: boolean): void {
    this.onSearch?.({ kind: 'step', forward: same ? this.searchForward : !this.searchForward });
  }

  // — движения —

  private applyMotion(motion: VimMotion, count: number): void {
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const result = vimMoveTarget(buffer, offset, motion, count, this.goal);
    this.goal = isHorizontalMotion(motion) ? columnAt(buffer, result.offset) : result.goal;
    if (this.state.mode === 'visual' || this.state.mode === 'visual-line') {
      this.controller.setSelection({ anchor: this.visualAnchor, active: result.offset });
    } else {
      this.controller.setSelection({ anchor: result.offset, active: result.offset });
    }
  }

  // — операторы —

  private applyOperator(operator: VimOperator, motion: VimMotion, count: number): void {
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    // `cw` меняет слово до его конца (как `ce`) — так делает Vim.
    let target = motion;
    if (operator === 'change' && (motion === 'wordForward' || motion === 'bigWordForward')) {
      target = motion === 'wordForward' ? 'wordEnd' : 'bigWordEnd';
    }
    this.applyRange(operator, vimMotionRange(buffer, offset, target, count));
  }

  private applyOperatorLines(operator: VimOperator, count: number): void {
    const buffer = this.controller.bufferRef;
    const line = buffer.lineAt(this.controller.caret);
    const bottom = Math.min(buffer.lineCount, line + Math.max(1, count) - 1);
    const start = buffer.lineStart(line);
    const fullEnd = bottom < buffer.lineCount ? buffer.lineStart(bottom + 1) : buffer.length;

    if (operator === 'yank') {
      this.register = { text: buffer.getText(start, fullEnd), linewise: true };
      this.controller.setSelection({ anchor: start, active: start });
      return;
    }
    if (operator === 'change') {
      // Строки схлопываются в одну пустую: текст убираем, перевод строки оставляем.
      const contentEnd = buffer.lineStart(bottom) + buffer.lineText(bottom).length;
      const removed = buffer.getText(start, contentEnd);
      this.register = { text: `${removed}\n`, linewise: true };
      this.controller.applyEdit({ start, removed, inserted: '' }, { anchor: start, active: start });
      this.enterInsert('lineStart');
      return;
    }
    const removed = buffer.getText(start, fullEnd);
    this.register = { text: removed, linewise: true };
    this.controller.applyEdit({ start, removed, inserted: '' }, { anchor: start, active: start });
    // Каретка — на первый непробельный знак строки, что встала на место удалённых.
    const target = Math.min(start, buffer.length);
    const landed = buffer.lineAt(target);
    const column = firstNonBlankColumn(buffer.lineText(landed));
    this.controller.setSelection({
      anchor: buffer.lineStart(landed) + column,
      active: buffer.lineStart(landed) + column,
    });
  }

  private applyOperatorSelection(operator: VimOperator): void {
    const selection = this.controller.selection;
    const buffer = this.controller.bufferRef;
    let start = Math.min(selection.anchor, selection.active);
    let end = Math.max(selection.anchor, selection.active);
    if (this.state.mode === 'visual-line') {
      const top = buffer.lineAt(start);
      const bottom = buffer.lineAt(end);
      start = buffer.lineStart(top);
      end = bottom < buffer.lineCount ? buffer.lineStart(bottom + 1) : buffer.length;
    }
    this.applyRange(operator, { start, end, linewise: this.state.mode === 'visual-line' });
    this.setMode('normal');
  }

  private applyRange(operator: VimOperator, range: VimRange): void {
    const buffer = this.controller.bufferRef;
    const text = buffer.getText(range.start, range.end);
    this.register = { text, linewise: range.linewise };
    if (operator === 'yank') {
      this.controller.setSelection({ anchor: range.start, active: range.start });
      return;
    }
    if (range.end <= range.start) return;
    this.controller.applyEdit(
      { start: range.start, removed: text, inserted: '' },
      { anchor: range.start, active: range.start },
    );
    if (operator === 'change') this.enterInsert('before');
  }

  // — простые правки —

  private deleteChars(count: number): void {
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    const text = buffer.lineText(line);
    const available = Math.max(0, Math.min(count, text.length - (offset - start)));
    if (available === 0) return;
    const removed = text.slice(offset - start, offset - start + available);
    this.register = { text: removed, linewise: false };
    this.controller.applyEdit({ start: offset, removed, inserted: '' }, { anchor: offset, active: offset });
  }

  private deleteCharsBefore(count: number): void {
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    const available = Math.max(0, Math.min(count, offset - start));
    if (available === 0) return;
    const removed = buffer.getText(offset - available, offset);
    this.register = { text: removed, linewise: false };
    const target = offset - available;
    this.controller.applyEdit({ start: target, removed, inserted: '' }, { anchor: target, active: target });
  }

  private deleteToEnd(change: boolean): void {
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const end = buffer.lineStart(line) + buffer.lineText(line).length;
    const removed = buffer.getText(offset, end);
    if (removed.length > 0) {
      this.register = { text: removed, linewise: false };
      this.controller.applyEdit({ start: offset, removed, inserted: '' }, { anchor: offset, active: offset });
    }
    if (change) this.enterInsert('before');
  }

  private replaceChar(char: string, count: number): void {
    if (char.length !== 1 || char === '\n' || char === '\r') return;
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    const text = buffer.lineText(line);
    const column = offset - start;
    const available = Math.max(0, Math.min(count, text.length - column));
    if (available === 0) return;
    const removed = text.slice(column, column + available);
    this.controller.applyEdit(
      { start: offset, removed, inserted: char.repeat(available) },
      { anchor: offset + available - 1, active: offset + available - 1 },
    );
  }

  private toggleCase(count: number): void {
    const buffer = this.controller.bufferRef;
    if (this.state.mode === 'visual' || this.state.mode === 'visual-line') {
      const selection = this.controller.selection;
      const start = Math.min(selection.anchor, selection.active);
      const end = Math.max(selection.anchor, selection.active);
      const removed = buffer.getText(start, end);
      if (removed.length === 0) return;
      this.controller.applyEdit({ start, removed, inserted: toggleCaseText(removed) }, { anchor: start, active: end });
      return;
    }
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    const text = buffer.lineText(line);
    const column = offset - start;
    const available = Math.max(0, Math.min(count, text.length - column));
    if (available === 0) return;
    const removed = text.slice(column, column + available);
    this.controller.applyEdit(
      { start: offset, removed, inserted: toggleCaseText(removed) },
      { anchor: offset + available, active: offset + available },
    );
  }

  private join(count: number): void {
    const buffer = this.controller.bufferRef;
    const top = buffer.lineAt(this.controller.caret);
    const bottom = Math.min(buffer.lineCount, top + Math.max(1, count));
    if (bottom <= top) return;
    const start = buffer.lineStart(top) + buffer.lineText(top).length;
    const end = buffer.lineStart(bottom) + buffer.lineText(bottom).length;
    const removed = buffer.getText(start, end);
    let inserted = '';
    for (let line = top + 1; line <= bottom; line += 1) {
      const text = buffer.lineText(line).replace(/^[ \t]+/, '');
      if (text.length === 0) continue;
      inserted += ` ${text}`;
    }
    if (removed === inserted) return;
    this.controller.applyEdit({ start, removed, inserted }, { anchor: start, active: start });
  }

  private put(after: boolean, count: number): void {
    const text = this.register.text;
    if (text.length === 0) return;
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const times = Math.max(1, count);
    if (this.register.linewise) {
      const block = (text.endsWith('\n') ? text : `${text}\n`).repeat(times);
      if (after) {
        // Строка встаёт ПОД текущей: если следующая есть, вставляем в её начало
        // (перед её текстом), иначе дописываем перевод строки в конец файла.
        const line = buffer.lineAt(offset);
        if (line < buffer.lineCount) {
          const at = buffer.lineStart(line + 1);
          this.controller.applyEdit({ start: at, removed: '', inserted: block }, { anchor: at, active: at });
        } else {
          const at = buffer.lineStart(line) + buffer.lineText(line).length;
          this.controller.applyEdit(
            { start: at, removed: '', inserted: `\n${block}` },
            { anchor: at + 1, active: at + 1 },
          );
        }
      } else {
        const at = buffer.lineStart(buffer.lineAt(offset));
        this.controller.applyEdit({ start: at, removed: '', inserted: block }, { anchor: at, active: at });
      }
      return;
    }
    const insertAt = after ? vimMoveTarget(buffer, offset, 'charRight', 1, 0).offset : offset;
    const inserted = text.repeat(times);
    const caret = insertAt + Math.max(0, inserted.length - 1);
    this.controller.applyEdit({ start: insertAt, removed: '', inserted }, { anchor: caret, active: caret });
  }

  private swapEnds(): void {
    const selection = this.controller.selection;
    this.controller.setSelection({ anchor: selection.active, active: selection.anchor });
    this.visualAnchor = selection.anchor;
  }

  private enterInsert(at: InsertPlace): void {
    // Начинаем чистую запись вставки: из неё соберётся текст для повтора `.`.
    this.insertTyped = '';
    this.insertExact = true;
    const buffer = this.controller.bufferRef;
    const offset = this.controller.caret;
    const line = buffer.lineAt(offset);
    const lineStart = buffer.lineStart(line);
    const text = buffer.lineText(line);
    const indent = /^[ \t]*/.exec(text)?.[0] ?? '';

    switch (at) {
      case 'before':
        this.controller.setSelection({ anchor: offset, active: offset });
        break;
      case 'after': {
        const target = vimMoveTarget(buffer, offset, 'charRight', 1, 0).offset;
        this.controller.setSelection({ anchor: target, active: target });
        break;
      }
      case 'lineStart': {
        const target = lineStart + firstNonBlankColumn(text);
        this.controller.setSelection({ anchor: target, active: target });
        break;
      }
      case 'lineEnd': {
        const target = lineStart + text.length;
        this.controller.setSelection({ anchor: target, active: target });
        break;
      }
      case 'newLineBelow': {
        const at = lineStart + text.length;
        this.controller.applyEdit(
          { start: at, removed: '', inserted: `\n${indent}` },
          { anchor: at + 1 + indent.length, active: at + 1 + indent.length },
        );
        break;
      }
      case 'newLineAbove': {
        this.controller.applyEdit(
          { start: lineStart, removed: '', inserted: `${indent}\n` },
          { anchor: lineStart + indent.length, active: lineStart + indent.length },
        );
        break;
      }
    }
    this.setMode('insert');
  }

  /** Сбросить незавершённые нажатия (например, панель потеряла фокус). */
  reset(): void {
    this.state = vimInitialState(this.state.mode === 'insert' ? 'insert' : 'normal');
  }
}

/** Столбец первого непробельного знака — повторяет правило `^` из `vim.ts`. */
function firstNonBlankColumn(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ' ' && text[index] !== '\t') return index;
  }
  return 0;
}
