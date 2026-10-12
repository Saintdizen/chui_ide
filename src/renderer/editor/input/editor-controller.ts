/**
 * Контроллер редактора: связывает текст, курсор и историю правок.
 *
 * Он держит состояние сессии — буфер, выделение, `goalColumn` (желаемый столбец для
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
import { isEmpty, type Selection } from '../view/selection';
import {
  deleteBackward,
  deleteForward,
  deleteWordBackward,
  deleteWordForward,
  insertNewline,
  insertText,
  outdentLine,
  type EditResult,
} from './editing';
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

export class EditorController {
  private buffer: TextBuffer;
  private readonly history: EditHistory;
  private readonly listeners = new Set<(change: EditorChange) => void>();
  private tabSize: number;
  private selectionState: Selection = { anchor: 0, active: 0 };
  /** Желаемый столбец: держится между вертикальными движениями, сбрасывается вбок. */
  private goalColumn = 0;

  constructor(buffer: TextBuffer, options: EditorControllerOptions = {}) {
    this.buffer = buffer;
    this.tabSize = options.tabSize ?? 4;
    this.history = new EditHistory(options.historyLimit);
  }

  get bufferRef(): TextBuffer {
    return this.buffer;
  }

  get selection(): Selection {
    return this.selectionState;
  }

  get caret(): number {
    return this.selectionState.active;
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
    this.selectionState = selection;
    this.goalColumn = columnAt(this.buffer, selection.active);
    if (notify) this.emit('selection', selection.active);
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
    this.selectionState = selection;
    this.goalColumn = columnAt(this.buffer, selection.active);
    this.history.clear();
    this.emit('selection', selection.active);
  }

  // — движения —

  /**
   * Общее для движений вбок: курсор переезжает, желаемый столбец обновляется — от
   * него отсчитывается вертикаль. `extend` — движение с Shift (тянет выделение).
   */
  private moveHorizontal(target: number, extend: boolean): void {
    this.applySelection(target, extend);
    this.goalColumn = columnAt(this.buffer, target);
    this.emit('selection', target);
  }

  private moveVerticalTo(target: number, extend: boolean): void {
    this.applySelection(target, extend);
    this.emit('selection', target);
  }

  /** Новое выделение: при протяжке якорь остаётся, иначе курсор — точка. */
  private applySelection(target: number, extend: boolean): void {
    this.selectionState = extend
      ? { anchor: this.selectionState.anchor, active: target }
      : { anchor: target, active: target };
  }

  moveLeft(extend = false): void {
    this.moveHorizontal(moveLeft(this.buffer, this.selectionState.active), extend);
  }

  moveRight(extend = false): void {
    this.moveHorizontal(moveRight(this.buffer, this.selectionState.active), extend);
  }

  moveWordLeft(extend = false): void {
    this.moveHorizontal(moveWordLeft(this.buffer, this.selectionState.active), extend);
  }

  moveWordRight(extend = false): void {
    this.moveHorizontal(moveWordRight(this.buffer, this.selectionState.active), extend);
  }

  moveLineStart(extend = false): void {
    this.moveHorizontal(moveLineStart(this.buffer, this.selectionState.active), extend);
  }

  moveSmartLineStart(extend = false): void {
    this.moveHorizontal(moveSmartLineStart(this.buffer, this.selectionState.active), extend);
  }

  moveLineEnd(extend = false): void {
    this.moveHorizontal(moveLineEnd(this.buffer, this.selectionState.active), extend);
  }

  moveDocStart(extend = false): void {
    this.moveHorizontal(moveDocStart(), extend);
  }

  moveDocEnd(extend = false): void {
    this.moveHorizontal(moveDocEnd(this.buffer), extend);
  }

  /** Вверх или вниз на строку (со знаком). Желаемый столбец не трогаем — ради него всё и есть. */
  moveVertical(delta: number, extend = false): void {
    const target = moveVertical(this.buffer, this.selectionState.active, delta, this.goalColumn);
    this.moveVerticalTo(target, extend);
  }

  /** Страница вверх или вниз: шаг — почти во весь экран (число строк задаёт представление). */
  movePage(direction: number, lines: number, extend = false): void {
    const target = movePage(this.buffer, this.selectionState.active, direction * lines, this.goalColumn);
    this.moveVerticalTo(target, extend);
  }

  // — правки —

  /**
   * Записать правку в историю, поставить новый курсор и сообщить об изменении текста.
   * В историю идут и состояния курсора до и после: отмена возвращает не только текст,
   * но и куда человек смотрел.
   */
  private commit(result: EditResult, kind: HistoryChangeKind): void {
    const entry: HistoryEntry = {
      changes: [result.change],
      before: [this.selectionState],
      after: [result.selection],
      kind,
      time: Date.now(),
    };
    // Набор и удаление подряд схлопываются в один шаг отмены (см. `core/history.ts`).
    this.history.push(entry, { merge: kind === 'typing' || kind === 'delete' });
    this.selectionState = result.selection;
    this.goalColumn = columnAt(this.buffer, result.selection.active);
    this.emit('text', result.change.start);
  }

  /** Ввести текст: символ за символом, вставка из буфера обмена, ответ IME. */
  type(text: string): void {
    this.run(insertText(this.buffer, this.selectionState, text), 'typing');
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
    if (edit.removed.length === 0 && edit.inserted.length === 0) return;
    const before = this.selectionState;
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
    this.selectionState = after;
    this.goalColumn = columnAt(this.buffer, after.active);
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
    // Правка, которая ничего не меняет, шагом не считается: иначе в истории появился бы
    // пустой шаг, и первое Ctrl+Z выглядело бы как «ничего не произошло».
    const usable = changes.filter((change) => change.removed !== change.inserted);
    if (usable.length === 0) return;

    const before = this.selectionState;
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
    this.selectionState = after;
    this.goalColumn = columnAt(this.buffer, after.active);
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
    this.run(insertNewline(this.buffer, this.selectionState), 'other');
  }

  backspace(): void {
    this.run(deleteBackward(this.buffer, this.selectionState), 'delete');
  }

  deleteForward(): void {
    this.run(deleteForward(this.buffer, this.selectionState), 'delete');
  }

  deleteWordBackward(): void {
    this.run(deleteWordBackward(this.buffer, this.selectionState), 'delete');
  }

  deleteWordForward(): void {
    this.run(deleteWordForward(this.buffer, this.selectionState), 'delete');
  }

  /** Tab: вставить отступ. По выделению (когда оно есть) сдвигаем строку целиком. */
  indent(): void {
    const text = ' '.repeat(this.tabSize);
    this.run(insertText(this.buffer, this.selectionState, text), 'other');
  }

  /** Shift+Tab: снять отступ у текущей строки — один таб или до `tabSize` пробелов. */
  outdent(): void {
    this.run(outdentLine(this.buffer, this.selectionState.active, this.tabSize), 'other');
  }

  /** Сдвинуть текст из буфера обмена: замена выделенного. Отдельно от `type` — иной шаг истории. */
  paste(text: string): void {
    this.type(text);
  }

  /**
   * Удалить выделенное и вернуть его текст — для вырезания. Если выделения нет,
   * возвращает пустую строку и ничего не меняет.
   */
  cutSelection(): string {
    if (isEmpty(this.selectionState)) return '';
    const { anchor, active } = this.selectionState;
    const start = Math.min(anchor, active);
    const end = Math.max(anchor, active);
    const text = this.buffer.getText(start, end);
    this.run(deleteBackward(this.buffer, this.selectionState), 'delete');
    return text;
  }

  /** Текст выделенного участка — для копирования. Пустая строка, если выделения нет. */
  selectedText(): string {
    if (isEmpty(this.selectionState)) return '';
    const { anchor, active } = this.selectionState;
    return this.buffer.getText(Math.min(anchor, active), Math.max(anchor, active));
  }

  private run(result: EditResult | null, kind: HistoryChangeKind): void {
    if (!result) return;
    this.commit(result, kind);
  }

  // — отмена и повтор —

  undo(): void {
    const entry = this.history.undo();
    if (!entry) return;
    const changes = inverseChanges(entry);
    this.replay(changes);
    this.selectionState = entry.before[0] ?? this.selectionState;
    this.goalColumn = columnAt(this.buffer, this.selectionState.active);
    this.emit('text', earliestStart(changes));
  }

  redo(): void {
    const entry = this.history.redo();
    if (!entry) return;
    const changes = forwardChanges(entry);
    this.replay(changes);
    this.selectionState = entry.after[0] ?? this.selectionState;
    this.goalColumn = columnAt(this.buffer, this.selectionState.active);
    this.emit('text', earliestStart(changes));
  }

  /** Применить правки к буферу. Отмена идёт обратными правками в обратном порядке — так смещения не съезжают. */
  private replay(changes: readonly { start: number; removed: string; inserted: string }[]): void {
    for (const change of changes) {
      this.buffer.replace(change.start, change.removed.length, change.inserted);
    }
  }
}

/** Самое раннее начало среди правок: с этой строки и надо переразобрать подсветку. */
function earliestStart(changes: readonly { start: number }[]): number {
  let from = Number.POSITIVE_INFINITY;
  for (const change of changes) from = Math.min(from, change.start);
  return Number.isFinite(from) ? from : 0;
}
