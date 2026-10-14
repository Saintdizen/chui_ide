/**
 * Учёт правок по курсорам: у КАЖДОЙ каретки — свой небольшой список того, что она
 * сделала. Нужен независимой отмене: при нескольких каретках `Ctrl+Alt+Z` убирает
 * последнюю правку ТОЛЬКО у главной каретки, не трогая чужой текст.
 *
 * Зачем отдельный модуль, а не вторая история: общая история (`core/history.ts`) хранит
 * правки ОДНИМ шагом и восстанавливает ВСЁ разом — так работает обычная отмена. Здесь
 * задача другая: помнить, какая правка чья, и держать её место ЖИВЫМ. Правки применяются
 * к общему буферу, и место каждой сдвигается от чужих правок; поэтому при каждой
 * применённой правке мы пересчитываем позиции всех запомненных записей.
 *
 * Каретка опознаётся числовым `id` (его ведёт контроллер). Список у каретки конечный:
 * память важнее глубины, а независимая отмена — про последние шаги, а не про весь файл.
 *
 * Модуль чистый: он не трогает ни буфер, ни DOM — только числа и строки.
 */

import type { ChangeKind, TextChange } from './history';

/** Запомненная правка каретки: участок и его место в ТЕКУЩЕМ тексте. */
export interface LedgerEdit {
  /** Позиция начала правки в текущем тексте — её и поддерживаем живой. */
  start: number;
  removed: string;
  inserted: string;
  kind: ChangeKind;
  /** Когда сделана: по времени решается, схлопывать ли с соседней. */
  time: number;
}

/** Окно схлопывания: набор подряд — одна правка, как и в общей истории. */
export const MERGE_WINDOW_MS = 600;
/** Сколько правок помним у одной каретки. Дальше — просто нет. */
export const DEFAULT_PER_CURSOR_LIMIT = 100;

interface Stack {
  /** Что можно отменить (последняя — конец списка). */
  undone: LedgerEdit[];
  /** Что можно повторить после независимой отмены. */
  done: LedgerEdit[];
}

export class CursorLedger {
  private readonly stacks = new Map<number, Stack>();

  constructor(private readonly limit: number = DEFAULT_PER_CURSOR_LIMIT) {}

  private stack(id: number): Stack {
    let stack = this.stacks.get(id);
    if (!stack) {
      stack = { undone: [], done: [] };
      this.stacks.set(id, stack);
    }
    return stack;
  }

  /**
   * Сдвинуть места всех запомненных правок от ОДНОЙ применённой. Так записи остаются
   * верными, когда правка сделана где-то ещё (другой кареткой, программно).
   */
  shift(change: TextChange, except?: LedgerEdit | null): void {
    for (const stack of this.stacks.values()) {
      for (const edit of stack.undone) {
        if (edit !== except) edit.start = shiftPosition(edit.start, change);
      }
      for (const edit of stack.done) {
        if (edit !== except) edit.start = shiftPosition(edit.start, change);
      }
    }
  }

  /**
   * Записать правку как сделанную кареткой `id`. Правка уже применена к буферу.
   * Новый шаг сбрасывает «вперёд» этой каретки; подряд идущий набор (или удаление)
   * схлопывается — отмена снимает слово, а не букву.
   */
  record(id: number, change: TextChange, kind: ChangeKind, now: number): LedgerEdit {
    const stack = this.stack(id);
    stack.done = [];
    const top = stack.undone[stack.undone.length - 1];
    if (top && shouldMerge(top, change, kind, now)) {
      merge(top, change);
      top.time = now;
      return top;
    }
    const edit: LedgerEdit = { ...change, kind, time: now };
    stack.undone.push(edit);
    if (stack.undone.length > this.limit) stack.undone.shift();
    return edit;
  }

  /** Есть ли что независимо отменить у каретки. */
  canUndo(id: number): boolean {
    return (this.stacks.get(id)?.undone.length ?? 0) > 0;
  }

  /** Есть ли что независимо повторить у каретки. */
  canRedo(id: number): boolean {
    return (this.stacks.get(id)?.done.length ?? 0) > 0;
  }

  /**
   * Снять последнюю правку каретки для отмены. Возвращает ОБРАТНУЮ правку (её и надо
   * применить) и убирает запись в «вперёд». Место записи при этом не меняется: мы убираем
   * ровно её текст, и место остаётся тем же.
   */
  takeUndo(id: number): TextChange | null {
    const stack = this.stacks.get(id);
    const edit = stack?.undone.pop();
    if (!stack || !edit) return null;
    const inverse: TextChange = { start: edit.start, removed: edit.inserted, inserted: edit.removed };
    this.shift(inverse);
    stack.done.push(edit);
    return inverse;
  }

  /** Взять правку для независимого повтора — прямую (её и надо применить). */
  takeRedo(id: number): TextChange | null {
    const stack = this.stacks.get(id);
    const edit = stack?.done.pop();
    if (!stack || !edit) return null;
    const forward: TextChange = { start: edit.start, removed: edit.removed, inserted: edit.inserted };
    this.shift(forward);
    stack.undone.push(edit);
    return forward;
  }

  /** Забыть всё (смена документа, общая отмена и повтор, крупные внешние правки). */
  clear(): void {
    this.stacks.clear();
  }

  /** Забыть правки одной каретки. */
  forget(id: number): void {
    this.stacks.delete(id);
  }

  /** Глубина списков — для проверок. */
  depth(id: number): { undone: number; done: number } {
    const stack = this.stacks.get(id);
    return { undone: stack?.undone.length ?? 0, done: stack?.done.length ?? 0 };
  }
}

/**
 * Схлопывать ли новую правку с последней: то же действие, впритык и в пределах окна.
 * Набор продолжается вправо, удаление назад — влево, удаление вперёд — на месте.
 *
 * Геометрию берём ДО сдвига от этой правки: записи ещё стоят в координатах текста
 * до неё, иначе «назад» не отличалось бы от «вперёд».
 */
function shouldMerge(top: LedgerEdit, change: TextChange, kind: ChangeKind, now: number): boolean {
  if (kind === 'other' || top.kind !== kind) return false;
  if (now - top.time > MERGE_WINDOW_MS) return false;
  if (kind === 'typing') {
    return change.removed.length === 0 && change.start === top.start + top.inserted.length;
  }
  // Удаление: либо назад (Backspace), либо вперёд (Delete).
  if (change.inserted.length !== 0) return false;
  if (change.start + change.removed.length === top.start) return true;
  return change.start === top.start;
}

/** Новая позиция записи после применённой правки. */
function shiftPosition(position: number, change: TextChange): number {
  const start = change.start;
  const removed = change.removed.length;
  if (position < start) return position;
  // Запись попала внутрь удалённого куска — прижимаем к его началу.
  if (position < start + removed) return start;
  return position + change.inserted.length - removed;
}

/** Дописать правку к последней записи: набор — вправо, удаление — влево или на месте. */
function merge(top: LedgerEdit, change: TextChange): void {
  if (change.removed.length === 0) {
    // Набор подряд: текст растёт вправо от того же начала.
    top.inserted += change.inserted;
    return;
  }
  if (change.start + change.removed.length === top.start) {
    // Backspace: удаление идёт влево, начало записи сдвигается.
    top.removed = change.removed + top.removed;
    top.start = change.start;
    return;
  }
  // Delete: удаление идёт вправо от того же начала.
  top.removed += change.removed;
}
