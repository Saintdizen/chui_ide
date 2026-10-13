/**
 * Контроллер редактора: связывает текст, курсор и историю правок.
 *
 * Он держит состояние сессии — буфер, курсоры, `goalColumn` (желаемый столбец для
 * вертикальных движений) и историю — и выполняет команды: «вправо», «backspace»,
 * «отменить». Модуль не знает про DOM и не рисует: о том, что что-то изменилось,
 * он сообщает подписчику (`onChange`). Кто подписан — дело вызывающего: в приложении
 * это представление, в тестах — просто счётчик.
 *
 * Разделение событий простое и важное: движение курсора и правка текста приходят с
 * разными метками (`selection` / `text`). Представлению при движении достаточно
 * передвинуть каретку, а при правке — пересобрать строки. Смешивать их значило бы
 * перерисовывать весь экран на каждое нажатие стрелки.
 *
 * История правок не меняет документ сама (`core/history.ts` только описывает, что
 * было сделано) — контроллер берёт описание и применяет его к буферу.
 */

import {
  EditHistory,
  type ChangeKind as HistoryChangeKind,
  inverseChanges,
  forwardChanges,
  type HistoryEntry,
  type TextChange,
} from '../core/history';
import type { TextBuffer } from '../core/text-buffer';
import { findOccurrences } from '../view/context-highlight';
import { isEmpty, selectionEnd, selectionStart, type Selection } from '../view/selection';
import {
  closerFor,
  copyLinesDown,
  deleteBackward,
  deleteForward,
  deletePairBackward,
  deleteWordBackward,
  deleteWordForward,
  insertNewline,
  insertPair,
  insertText,
  moveLines,
  outdentLine,
  skipClosing,
  type EditResult,
} from './editing';
import { toggleBlockComment, toggleLineComment } from './comments';
import { wrapSelection, type SurroundOption } from './surround';
import type { CaseStyle } from './case-convert';
import {
  convertSelectionCase,
  deleteLines,
  duplicateSelection,
  insertLineAbove,
  insertLineBelow,
  joinLines,
  sortLines,
  transposeAtCaret,
  type SortOptions,
} from './line-ops';
import {
  columnAt,
  moveDocEnd,
  moveDocStart,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  movePage,
  moveRight,
  moveSmartLineStart,
  moveVertical,
  moveWordLeft,
  moveWordRight,
} from './motions';

/**
 * Что изменилось и где. `selection` — сдвинулся только курсор, `text` — ещё и текст.
 * Смещение `from` нужно подсветке: от него считается строка, с которой надо
 * переразобрать документ (см. `highlight/highlighter.ts`).
 */
export interface EditorChange {
  readonly kind: 'selection' | 'text';
  readonly from: number;
}

export interface EditorControllerOptions {
  /** Сколько пробелов в одном шаге отступа (Tab). */
  tabSize?: number;
  /** Предел истории в шагах. */
  historyLimit?: number;
}

/**
 * Курсор и его желаемый столбец. Желаемый столбец — состояние между нажатиями: он
 * держится у каждого курсора свой, иначе при вертикальном движении мультикурсор
 * разъехался бы по столбцам.
 */
interface Cursor {
  sel: Selection;
  goal: number;
}

export class EditorController {
  private buffer: TextBuffer;
  private readonly history: EditHistory;
  private readonly listeners = new Set<(change: EditorChange) => void>();
  private tabSize: number;
  /**
   * Файл открыт только для чтения (большой файл, см. `shared/large-file.ts`). Курсор
   * ходит, выделять и копировать можно, а всё, что меняет текст, отсекается здесь — в
   * одном месте, поэтому ни ввод, ни команды, ни программные правки его не тронут.
   */
  private readOnly = false;
  /**
   * Курсоры панели. Обычно он один, но их бывает и несколько (мультикурсор): последний
   * в списке — «главный», по нему идут IME, попапы и статус-бар.
   */
  private cursors: Cursor[] = [{ sel: { anchor: 0, active: 0 }, goal: 0 }];
  /**
   * Связанные участки (linkedEditing): имена парных тегов, которые правятся вместе.
   * Смещения в тексте документа, по возрастанию. Пока они заданы и каретка одна, любую
   * правку внутри участка повторяем и в остальных — так открывающий и закрывающий тег
   * держатся одинаковыми. `null` — связи нет.
   */
  private linked: { start: number; end: number }[] | null = null;

  constructor(buffer: TextBuffer, options: EditorControllerOptions = {}) {
    this.buffer = buffer;
    this.tabSize = options.tabSize ?? 4;
    this.history = new EditHistory(options.historyLimit);
  }

  get bufferRef(): TextBuffer {
    return this.buffer;
  }

  get selection(): Selection {
    return this.primary.sel;
  }

  /**
   * Все курсоры (последний — главный). Представление рисует каретку у каждого.
   * Массив пересобирается на чтение: его меняют только внутри контроллера.
   */
  get selections(): readonly Selection[] {
    return this.cursors.map((cursor) => cursor.sel);
  }

  get caret(): number {
    return this.primary.sel.active;
  }

  /** Главный курсор — последний в списке. */
  private get primary(): Cursor {
    return this.cursors[this.cursors.length - 1]!;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /**
   * Сменить ширину отступа (настройка изменилась на ходу). История при этом не
   * трогается: прошлые правки остаются как были, меняется только будущий Tab.
   */
  setTabSize(tabSize: number): void {
    this.tabSize = Math.max(1, Math.floor(tabSize));
  }

  /** Переключить режим «только чтение»: панель открывает файл, большой или обычный. */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  /** Подписаться на изменения. Возвращает функцию отписки. */
  onChange(listener: (change: EditorChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: 'selection' | 'text', from: number): void {
    const change: EditorChange = { kind, from };
    for (const listener of this.listeners) listener(change);
  }

  /**
   * Поставить выделение (клик, программный переход). Столбец запоминаем: следующее
   * вертикальное движение начнётся с этого места.
   */
  setSelection(selection: Selection, notify = true): void {
    this.setSelections([selection], notify);
  }

  /**
   * Поставить НЕСКОЛЬКО курсоров (мультикурсор). Курсоры нормализуются: перекрывающиеся
   * сливаются, а последний переданный становится главным.
   */
  setSelections(selections: readonly Selection[], notify = true): void {
    this.restoreCursors(selections);
    if (notify) this.emit('selection', this.caret);
  }

  /** Добавить курсор (Alt+клик, Ctrl+Alt+↑/↓, Ctrl+D). Новый становится главным. */
  addCursor(selection: Selection): void {
    this.setSelections([...this.selections, selection]);
  }

  /**
   * Ctrl+D: следующее вхождение текущего слова. Первое нажатие выделяет слово
   * под кареткой, дальше вхождения добавляются по кругу новыми каретками.
   * `false` — вхождений нет, добавлять нечего.
   */
  selectNextOccurrence(): boolean {
    const occurrences = findOccurrences(this.buffer, this.selection);
    if (occurrences.length === 0) return false;
    const selected = this.selections.filter((sel) => !isEmpty(sel));
    if (selected.length === 0) {
      const at = occurrences.find((range) => this.caret >= range.start && this.caret <= range.end) ?? occurrences[0]!;
      this.setSelection({ anchor: at.start, active: at.end });
      return true;
    }
    const taken = new Set(selected.map((sel) => `${selectionStart(sel)}:${selectionEnd(sel)}`));
    const from = Math.max(...selected.map((sel) => selectionEnd(sel)));
    const next =
      occurrences.find((range) => range.start >= from && !taken.has(`${range.start}:${range.end}`)) ??
      occurrences.find((range) => !taken.has(`${range.start}:${range.end}`));
    if (!next) return false;
    this.addCursor({ anchor: next.start, active: next.end });
    return true;
  }

  /**
   * Ctrl+Shift+L: выделить ВСЕ вхождения текущего слова сразу. Печатаешь один раз —
   * текст меняется во всех местах.
   */
  selectAllOccurrences(): boolean {
    const occurrences = findOccurrences(this.buffer, this.selection);
    if (occurrences.length === 0) return false;
    this.setSelections(occurrences.map((range) => ({ anchor: range.start, active: range.end })));
    return true;
  }

  /** Оставить только главный курсор: Escape после мультикурсора. */
  collapseToPrimary(): void {
    this.setSelections([this.selection]);
  }

  /** Ctrl+Alt+↑: добавить каретку на строку выше (по столбцу каждой имеющейся). */
  addCursorAbove(): void {
    this.addCursorVertical(-1);
  }

  /** Ctrl+Alt+↓: добавить каретку на строку ниже. */
  addCursorBelow(): void {
    this.addCursorVertical(1);
  }

  /**
   * Добавить по каретке на соседнюю строку у каждого курсора. Столбец берётся у самого
   * курсора, поэтому вертикальная «колонка» кареток выходит ровной — по ней и набирают
   * таблицы и правят однотипные строки.
   */
  private addCursorVertical(delta: number): void {
    const added: Selection[] = [];
    for (const cursor of this.cursors) {
      const line = this.buffer.lineAt(cursor.sel.active);
      const target = line + delta;
      if (target < 1 || target > this.buffer.lineCount) continue;
      const goal = columnAt(this.buffer, cursor.sel.active);
      const position = moveVertical(this.buffer, cursor.sel.active, delta, goal);
      added.push({ anchor: position, active: position });
    }
    if (added.length === 0) return;
    this.setSelections([...this.selections, ...added]);
  }

  /** Выделить весь документ. */
  selectAll(): void {
    this.setSelection({ anchor: 0, active: this.buffer.length });
  }

  /**
   * Сменить документ: открыли другой файл в этой же панели. Курсор встаёт в начало,
   * история правок очищается — отменять правки ПРОШЛОГО файла в новом было бы странно,
   * и ни один редактор так не делает.
   */
  setBuffer(buffer: TextBuffer, selection: Selection = { anchor: 0, active: 0 }): void {
    this.buffer = buffer;
    this.linked = null;
    this.restoreCursors([selection]);
    this.history.clear();
    this.emit('selection', this.caret);
  }

  // — движения —

  /**
   * Общее для движений вбок: курсор переезжает, желаемый столбец обновляется — от
   * него отсчитывается вертикаль. `extend` — движение с Shift (тянет выделение).
   */
  /**
   * Применить движение к КАЖДОМУ курсору. `horizontal` — движение вбок: оно
   * пересчитывает желаемый столбец, вертикальное его бережёт (ради этого он и хранится).
   */
  private moveAll(compute: (cursor: Cursor) => number, extend: boolean, horizontal: boolean): void {
    const next = this.cursors.map((cursor) => {
      const position = compute(cursor);
      const sel: Selection = extend
        ? { anchor: cursor.sel.anchor, active: position }
        : { anchor: position, active: position };
      const goal = horizontal ? columnAt(this.buffer, position) : cursor.goal;
      return { sel, goal };
    });
    this.commitCursors(next);
  }

  moveLeft(extend = false): void {
    this.moveAll((cursor) => moveLeft(this.buffer, cursor.sel.active), extend, true);
  }

  moveRight(extend = false): void {
    this.moveAll((cursor) => moveRight(this.buffer, cursor.sel.active), extend, true);
  }

  moveWordLeft(extend = false): void {
    this.moveAll((cursor) => moveWordLeft(this.buffer, cursor.sel.active), extend, true);
  }

  moveWordRight(extend = false): void {
    this.moveAll((cursor) => moveWordRight(this.buffer, cursor.sel.active), extend, true);
  }

  moveLineStart(extend = false): void {
    this.moveAll((cursor) => moveLineStart(this.buffer, cursor.sel.active), extend, true);
  }

  moveSmartLineStart(extend = false): void {
    this.moveAll((cursor) => moveSmartLineStart(this.buffer, cursor.sel.active), extend, true);
  }

  moveLineEnd(extend = false): void {
    this.moveAll((cursor) => moveLineEnd(this.buffer, cursor.sel.active), extend, true);
  }

  moveDocStart(extend = false): void {
    this.moveAll(() => moveDocStart(), extend, true);
  }

  moveDocEnd(extend = false): void {
    this.moveAll(() => moveDocEnd(this.buffer), extend, true);
  }

  /** Вверх или вниз на строку (со знаком). Желаемый столбец не трогаем — ради него всё и есть. */
  moveVertical(delta: number, extend = false): void {
    this.moveAll((cursor) => moveVertical(this.buffer, cursor.sel.active, delta, cursor.goal), extend, false);
  }

  /** Страница вверх или вниз: шаг — почти во весь экран (число строк задаёт представление). */
  movePage(direction: number, lines: number, extend = false): void {
    this.moveAll((cursor) => movePage(this.buffer, cursor.sel.active, direction * lines, cursor.goal), extend, false);
  }

  // — правки —

  /**
   * Записать правку в историю, поставить новый курсор и сообщить об изменении текста.
   * В историю идут и состояния курсора до и после: отмена возвращает не только текст,
   * но и куда человек смотрел.
   */
  private commit(result: EditResult, kind: HistoryChangeKind): void {
    if (this.readOnly) return;
    this.pushEntry([result.change], [this.selection], [result.selection], kind);
  }

  /**
   * Правка на КАЖДОЙ каретке — одним шагом истории. Правки применяем от конца текста:
   * правка в начале сдвинула бы смещения соседних. В том же порядке (по убыванию) они
   * ложатся в историю, поэтому и отмена, разворачивая список, идёт от начала — так ни
   * одна правка не съезжает.
   */
  private editAll(compute: (selection: Selection) => EditResult | null, kind: HistoryChangeKind): void {
    if (this.readOnly) return;
    const order = this.cursors
      .map((_, index) => index)
      .sort((a, b) => selectionStart(this.cursors[b]!.sel) - selectionStart(this.cursors[a]!.sel));
    const applied = new Map<number, EditResult>();
    for (const index of order) {
      const result = compute(this.cursors[index]!.sel);
      if (result) applied.set(index, result);
    }
    if (applied.size === 0) return;

    const changes: TextChange[] = order
      .filter((index) => applied.has(index))
      .map((index) => applied.get(index)!.change);
    const before = this.cursors.map((cursor) => cursor.sel);

    // Идём с конца, поэтому правки ЛЕВЕЕ каретки применяются ПОСЛЕ неё и сдвигают её
    // место. Новые каретки правим на эту разницу — иначе после набора на нескольких
    // каретках текст верен, а курсоры стоят не там.
    const deltas = order
      .filter((index) => applied.has(index))
      .map((index) => ({ start: selectionStart(before[index]!), delta: deltaOf(applied.get(index)!.change) }))
      .sort((a, b) => a.start - b.start);
    const shiftFor = (position: number): number => {
      let shift = 0;
      for (const item of deltas) {
        if (item.start >= position) break;
        shift += item.delta;
      }
      return shift;
    };

    const after = this.cursors.map((cursor, index) => {
      const target = applied.get(index)?.selection ?? cursor.sel;
      const shift = shiftFor(selectionStart(cursor.sel));
      return { anchor: target.anchor + shift, active: target.active + shift };
    });

    // Связанные участки: правку внутри одного повторяем и в остальных. Только для одной
    // каретки (при мультикурсоре связи нет) и для набора/удаления — на них связь и рассчитана.
    if ((kind === 'typing' || kind === 'delete') && this.linked && this.cursors.length === 1) {
      const primary = applied.get(order[0]!);
      const mirror = primary ? this.linkedMirrors(primary.change) : null;
      if (mirror) {
        // Откатываем правку (compute уже применил её к буферу) и применяем всё вместе
        // справа налево: тогда смещения у каждой правки — исходные, и история верна.
        const change = primary!.change;
        this.buffer.replace(change.start, change.inserted.length, change.removed);
        const all = [change, ...mirror].sort((left, right) => right.start - left.start);
        for (const item of all) this.buffer.replace(item.start, item.removed.length, item.inserted);
        this.linked = shiftLinked(this.linked, all);
        this.pushEntry(all, before, after, kind);
        return;
      }
    }

    this.pushEntry(changes, before, after, kind);
  }

  /**
   * Поставить связанные участки (смещения в тексте). Пусто или один участок — связи нет:
   * повторять правку не с чем. Пересекающиеся участки отбрасываем — их правят как один.
   */
  setLinkedRanges(ranges: readonly { start: number; end: number }[] | null): void {
    if (!ranges || ranges.length < 2) {
      this.linked = null;
      return;
    }
    const sorted = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) continue; // перекрытие — не отдельный участок
      merged.push({ start: range.start, end: range.end });
    }
    this.linked = merged.length >= 2 ? merged : null;
  }

  /** Есть ли сейчас связанные участки — для тестов и представления. */
  get linkedRanges(): readonly { start: number; end: number }[] | null {
    return this.linked;
  }

  /**
   * Повторы правки на каждое связанное место. Правка должна целиком лежать в одном
   * участке (иначе это не про связь), а переносы строк не повторяем: имя тега — одна
   * строка. В каждом другом участке правим тот же относительный столбец.
   */
  private linkedMirrors(change: TextChange): TextChange[] | null {
    const linked = this.linked;
    if (!linked) return null;
    if (change.inserted.includes('\n') || change.removed.includes('\n')) return null;
    const source = linked.find(
      (range) => change.start >= range.start && change.start + change.removed.length <= range.end,
    );
    if (!source) return null;
    const at = change.start - source.start;
    const mirrors: TextChange[] = [];
    for (const range of linked) {
      if (range === source) continue;
      if (at + change.removed.length > range.end - range.start) continue;
      mirrors.push({ start: range.start + at, removed: change.removed, inserted: change.inserted });
    }
    return mirrors.length > 0 ? mirrors : null;
  }

  /** Записать шаг истории и поставить курсоры, которые из него вышли. */
  private pushEntry(
    changes: readonly TextChange[],
    before: readonly Selection[],
    after: readonly Selection[],
    kind: HistoryChangeKind,
  ): void {
    const entry: HistoryEntry = { changes, before: [...before], after: [...after], kind, time: Date.now() };
    // Набор и удаление подряд схлопываются в один шаг отмены (см. `core/history.ts`).
    this.history.push(entry, { merge: kind === 'typing' || kind === 'delete' });
    this.cursors = this.normalizeCursors(after.map((sel) => ({ sel, goal: columnAt(this.buffer, sel.active) })));
    this.emit('text', earliestStart(changes));
  }

  /** Поставить курсоры из готового списка (отмена, смена документа, программный выбор). */
  private restoreCursors(selections: readonly Selection[]): void {
    const list = selections.length > 0 ? selections : [{ anchor: 0, active: 0 }];
    this.cursors = this.normalizeCursors(list.map((sel) => ({ sel, goal: columnAt(this.buffer, sel.active) })));
  }

  /** Применить движение: курсоры переставляются и не дают слипнуться в один. */
  private commitCursors(next: readonly Cursor[]): void {
    this.cursors = this.normalizeCursors(next);
    this.emit('selection', this.caret);
  }

  /**
   * Привести курсоры в порядок: по возрастанию места, перекрывающиеся — в один. Главный
   * остаётся главным (переносится в конец списка). Так после сближения курсоров в панели
   * не остаётся двух кареток в одном месте.
   */
  private normalizeCursors(cursors: readonly Cursor[]): Cursor[] {
    const items = cursors.map((cursor, index) => ({ ...cursor, primary: index === cursors.length - 1 }));
    items.sort((a, b) => selectionStart(a.sel) - selectionStart(b.sel) || selectionEnd(a.sel) - selectionEnd(b.sel));
    const merged: typeof items = [];
    for (const item of items) {
      const last = merged[merged.length - 1];
      if (last && selectionStart(item.sel) <= selectionEnd(last.sel)) {
        last.sel = {
          anchor: Math.min(selectionStart(last.sel), selectionStart(item.sel)),
          active: Math.max(selectionEnd(last.sel), selectionEnd(item.sel)),
        };
        last.primary = last.primary || item.primary;
      } else {
        merged.push({ ...item });
      }
    }
    const primaryAt = merged.findIndex((item) => item.primary);
    if (primaryAt >= 0 && primaryAt !== merged.length - 1) {
      const [primary] = merged.splice(primaryAt, 1);
      merged.push(primary!);
    }
    return merged.map(({ sel, goal }) => ({ sel, goal }));
  }

  /** Ввести текст на каждой каретке (набор, вставка из буфера, ответ IME). */
  type(text: string): void {
    this.editAll((selection) => insertText(this.buffer, selection, text), 'typing');
  }

  /**
   * Ввод с ОДНОЙ клавиши: дописываем пару за скобкой или кавычкой и перешагиваем через
   * уже стоящий закрывающий знак. Вставка из буфера идёт через `type`: там такое поведение
   * было бы навязчивым (вставили кусок кода — получили лишние скобки).
   */
  typeWithPairs(text: string): void {
    if (this.cursors.length === 1 && text.length === 1) {
      const closer = closerFor(text);
      if (closer !== null) {
        this.run(insertPair(this.buffer, this.selection, text, closer), 'typing');
        return;
      }
      const skipped = skipClosing(this.buffer, this.selection, text);
      if (skipped) {
        this.setSelection(skipped);
        return;
      }
    }
    this.type(text);
  }

  /** Ctrl+/ — переключить строчный комментарий у строк выделения. */
  toggleComment(token: string): void {
    const result = toggleLineComment(this.buffer, this.selection, token);
    if (result) this.applyEdits(result.changes, result.selection);
  }

  /** Alt+↑/↓ — перенести строку (или строки выделения) выше или ниже. */
  moveLines(direction: -1 | 1): void {
    this.run(moveLines(this.buffer, this.selection, direction), 'other');
  }

  /** Shift+Alt+↓ — скопировать строку (или строки выделения) ниже. */
  copyLinesDown(): void {
    this.run(copyLinesDown(this.buffer, this.selection), 'other');
  }

  /** Shift+Alt+A — переключить блочный комментарий вокруг выделения (пусто — строки). */
  toggleBlockComment(open: string, close: string): void {
    const result = toggleBlockComment(this.buffer, this.selection, open, close);
    if (result) this.applyEdits(result.changes, result.selection);
  }

  /** Обернуть выделение парой знаков («surround with»). */
  surroundSelection(option: SurroundOption): void {
    this.run(wrapSelection(this.buffer, this.selection, option), 'other');
  }

  /** Сортировать строки выделения (по возрастанию; параметры — регистр, порядок, повторы). */
  sortLines(options: SortOptions = {}): void {
    this.run(sortLines(this.buffer, this.selection, options), 'other');
  }

  /** Соединить строки выделения в одну. */
  joinLines(): void {
    this.run(joinLines(this.buffer, this.selection), 'other');
  }

  /** Ctrl+Shift+K — удалить строки выделения целиком (вместе с переводом). */
  deleteLines(): void {
    this.run(deleteLines(this.buffer, this.selection), 'delete');
  }

  /** Дублировать выделение, а если пусто — строку под кареткой. */
  duplicateSelection(): void {
    this.run(duplicateSelection(this.buffer, this.selection), 'other');
  }

  /** Ctrl+Enter — пустая строка ниже текущей, с тем же отступом. */
  insertLineBelow(): void {
    this.commit(insertLineBelow(this.buffer, this.selection), 'other');
  }

  /** Ctrl+Shift+Enter — пустая строка выше текущей. */
  insertLineAbove(): void {
    this.commit(insertLineAbove(this.buffer, this.selection), 'other');
  }

  /** Переставить два знака вокруг каретки (по графемам — эмодзи не разорвётся). */
  transpose(): void {
    this.run(transposeAtCaret(this.buffer, this.selection), 'other');
  }

  /** Сменить стиль имени у выделения (пусто — слово под кареткой). */
  convertCase(style: CaseStyle): void {
    this.run(convertSelectionCase(this.buffer, this.selection, style), 'other');
  }

  /**
   * Применить готовую правку участка — так работает замена по файлу. Одной правкой
   * на весь диапазон: набор независимых правок не годится для истории (смещения
   * второй после применения первой уже съехали бы), а одна правка отменяется целиком,
   * одним Ctrl+Z.
   *
   * Курсор после правки ставится в конец вставленного — так видно, где оказался
   * результат, — либо туда, куда попросил вызывающий.
   */
  applyEdit(edit: { start: number; removed: string; inserted: string }, selection?: Selection): void {
    if (this.readOnly) return;
    if (edit.removed.length === 0 && edit.inserted.length === 0) return;
    const before = this.selection;
    this.buffer.replace(edit.start, edit.removed.length, edit.inserted);
    const end = edit.start + edit.inserted.length;
    const after: Selection = selection ?? { anchor: end, active: end };
    const entry: HistoryEntry = {
      changes: [{ start: edit.start, removed: edit.removed, inserted: edit.inserted }],
      before: [before],
      after: [after],
      kind: 'other',
      time: Date.now(),
    };
    this.history.push(entry);
    this.restoreCursors([after]);
    this.emit('text', edit.start);
  }

  /**
   * Применить НЕСКОЛЬКО правок одним шагом истории — так приходят правки ассистента и
   * языкового сервера. Одним шагом, а не по одной: отмена должна вернуть всё разом, а
   * не заставлять жать Ctrl+Z столько раз, сколько правок пришло.
   *
   * Правки должны идти в порядке применения (как их вернул `translateEdits` — по убыванию
   * смещения). Записываем их в историю в том же порядке: отмена перевернёт список и
   * применит обратные с конца — тогда ни одна правка не съедет. Так же устроен шаг
   * набора: правки в нём лежат в порядке применения.
   */
  applyEdits(changes: readonly TextChange[], selection?: Selection): void {
    if (this.readOnly) return;
    // Правка, которая ничего не меняет, шагом не считается: иначе в истории появился бы
    // пустой шаг, и первое Ctrl+Z выглядело бы как «ничего не произошло».
    const usable = changes.filter((change) => change.removed !== change.inserted);
    if (usable.length === 0) return;

    const before = this.selection;
    for (const change of usable) this.buffer.replace(change.start, change.removed.length, change.inserted);

    // Курсор — в конец верхней правки: после неё текст виден целиком, и это то место,
    // куда смотрит человек, когда правка пришла «сверху вниз».
    const top = usable[usable.length - 1]!;
    const after: Selection = selection ?? {
      anchor: top.start + top.inserted.length,
      active: top.start + top.inserted.length,
    };
    const entry: HistoryEntry = {
      changes: [...usable],
      before: [before],
      after: [after],
      kind: 'other',
      time: Date.now(),
    };
    this.history.push(entry);
    this.restoreCursors([after]);
    this.emit(
      'text',
      usable.reduce((min, change) => Math.min(min, change.start), Number.POSITIVE_INFINITY),
    );
  }

  /** Выделить участок — по нему панель поиска показывает находку и ставит курсор. */
  selectRange(start: number, end: number): void {
    this.setSelection({ anchor: start, active: end });
  }

  newline(): void {
    this.editAll((selection) => insertNewline(this.buffer, selection), 'other');
  }

  backspace(): void {
    // Сперва снимаем пару скобок целиком: Backspace внутри `()` должен убрать оба
    // знака, а не оставить висящую открывающую.
    this.editAll(
      (selection) => deletePairBackward(this.buffer, selection) ?? deleteBackward(this.buffer, selection),
      'delete',
    );
  }

  deleteForward(): void {
    this.editAll((selection) => deleteForward(this.buffer, selection), 'delete');
  }

  deleteWordBackward(): void {
    this.editAll((selection) => deleteWordBackward(this.buffer, selection), 'delete');
  }

  deleteWordForward(): void {
    this.editAll((selection) => deleteWordForward(this.buffer, selection), 'delete');
  }

  /** Tab: вставить отступ на каждой каретке. */
  indent(): void {
    const text = ' '.repeat(this.tabSize);
    this.editAll((selection) => insertText(this.buffer, selection, text), 'other');
  }

  /**
   * Shift+Tab: снять отступ у каждой строки — один таб или до `tabSize` пробелов.
   * Строка обрабатывается один раз, даже если на ней несколько кареток: иначе отступ
   * снялся бы дважды.
   */
  outdent(): void {
    const seen = new Set<number>();
    this.editAll((selection) => {
      const line = this.buffer.lineAt(selection.active);
      if (seen.has(line)) return null;
      seen.add(line);
      return outdentLine(this.buffer, selection.active, this.tabSize);
    }, 'other');
  }

  /** Сдвинуть текст из буфера обмена: замена выделенного. Отдельно от `type` — иной шаг истории. */
  paste(text: string): void {
    this.type(text);
  }

  /**
   * Удалить выделенное и вернуть его текст — для вырезания. Если выделения нет,
   * возвращает пустую строку и ничего не меняет.
   */
  /**
   * Удалить выделенное на каждой каретке и вернуть текст. Куски соединяем переводом
   * строки — так же копируются несколько выделений. Пусто — ничего не выделено.
   */
  cutSelection(): string {
    if (this.readOnly) return '';
    const text = this.selectedText();
    if (text === '') return '';
    this.editAll((selection) => (isEmpty(selection) ? null : deleteBackward(this.buffer, selection)), 'delete');
    return text;
  }

  /** Текст выделенных участков — для копирования. Пустая строка, если выделения нет. */
  selectedText(): string {
    return this.cursors
      .filter((cursor) => !isEmpty(cursor.sel))
      .map((cursor) => this.buffer.getText(selectionStart(cursor.sel), selectionEnd(cursor.sel)))
      .join('\n');
  }

  private run(result: EditResult | null, kind: HistoryChangeKind): void {
    if (this.readOnly) return;
    if (!result) return;
    this.commit(result, kind);
  }

  // — отмена и повтор —

  undo(): void {
    if (this.readOnly) return;
    const entry = this.history.undo();
    if (!entry) return;
    const changes = inverseChanges(entry);
    this.replay(changes);
    this.restoreCursors(entry.before);
    this.emit('text', earliestStart(changes));
  }

  redo(): void {
    if (this.readOnly) return;
    const entry = this.history.redo();
    if (!entry) return;
    const changes = forwardChanges(entry);
    this.replay(changes);
    this.restoreCursors(entry.after);
    this.emit('text', earliestStart(changes));
  }

  /** Применить правки к буферу. Отмена идёт обратными правками в обратном порядке — так смещения не съезжают. */
  private replay(changes: readonly { start: number; removed: string; inserted: string }[]): void {
    for (const change of changes) {
      this.buffer.replace(change.start, change.removed.length, change.inserted);
    }
  }
}

/**
 * Сдвинуть связанные участки на правки: каждый участок смещается тем, что стоит левее
 * его границ. Правка внутри участка (набор в имени тега) двигает только его конец.
 */
function shiftLinked(
  linked: readonly { start: number; end: number }[],
  changes: readonly TextChange[],
): { start: number; end: number }[] {
  const shiftAt = (offset: number): number => {
    let shift = 0;
    for (const change of changes) {
      if (change.start + change.removed.length <= offset) shift += change.inserted.length - change.removed.length;
    }
    return shift;
  };
  return linked.map((range) => ({ start: range.start + shiftAt(range.start), end: range.end + shiftAt(range.end) }));
}

/** На сколько правка меняет длину текста: плюс — вставка, минус — удаление. */
function deltaOf(change: TextChange): number {
  return change.inserted.length - change.removed.length;
}

/** Самое раннее начало среди правок: с этой строки и надо переразобрать подсветку. */
function earliestStart(changes: readonly { start: number }[]): number {
  let from = Number.POSITIVE_INFINITY;
  for (const change of changes) from = Math.min(from, change.start);
  return Number.isFinite(from) ? from : 0;
}
