/**
 * История правок: отмена и повтор.
 *
 * История хранит не снимки документа (на большом файле это память в размер файла
 * на каждый шаг), а сами правки: где, что было и что стало. Отмена — это применить
 * обратные правки в обратном порядке; повтор — прямые. Поэтому шаг истории весит
 * столько же, сколько правка, и файл в 100 000 строк не дороже файла в 10 строк.
 *
 * Шаг — это группа правок, а не одна. Человек не ждёт, что отмена вернёт текст
 * по одной букве: он набрал слово — отмена возвращает слово целиком. Поэтому набор
 * и удаление подряд схлопываются в один шаг, пока это выглядит как одна правка
 * (см. `push` с `merge`): то же действие, идёт вплотную и укладывается в окно
 * времени. Всё, что «разрывает» набор, честно начинает новый шаг.
 *
 * Модуль чистый: он не трогает ни текст, ни курсор — только описывает, ЧТО было
 * сделано. Применение возвращённых правок — дело вызывающего.
 */

/** Одна правка: участок заменён текстом. Пустая строка в `inserted` — удаление. */
export interface TextChange {
  readonly start: number;
  readonly removed: string;
  readonly inserted: string;
}

/** Курсор или выделение в момент шага. Смещения-якоря: у выделения два конца. */
export interface CursorState {
  readonly anchor: number;
  readonly active: number;
}

/** Что за правка: от этого зависит, схлопывать ли её с предыдущей. */
export type ChangeKind = 'typing' | 'delete' | 'other';

export interface HistoryEntry {
  readonly changes: readonly TextChange[];
  /** Где был курсор ДО правки — туда вернёмся при отмене. */
  readonly before: readonly CursorState[];
  /** Где курсор ПОСЛЕ правки — к этому вернёмся при повторе. */
  readonly after: readonly CursorState[];
  readonly kind: ChangeKind;
  /** Когда шаг сделан: по времени решается, схлопывать ли его со следующим. */
  readonly time: number;
}

/** Окно схлопывания: набор в пределах этого времени считается одной правкой. */
export const MERGE_WINDOW_MS = 600;

/** Сколько шагов держим. Дальше отмена просто не идёт — память важнее глубины. */
export const DEFAULT_LIMIT = 500;

export interface PushOptions {
  /** Пробовать схлопнуть с предыдущим шагом (набор, удаление подряд). */
  merge?: boolean;
  /** Момент времени; по умолчанию — часы. Передаётся тестами. */
  now?: number;
}

/**
 * Обратные правки для отмены шага: порядок переворачивается, а «было» и «стало»
 * меняются местами. Правки идут с конца — иначе смещения второй правки уже съедут
 * после первой.
 */
export function inverseChanges(entry: HistoryEntry): TextChange[] {
  const out: TextChange[] = [];
  for (let index = entry.changes.length - 1; index >= 0; index -= 1) {
    const change = entry.changes[index]!;
    out.push({ start: change.start, removed: change.inserted, inserted: change.removed });
  }
  return out;
}

/** Прямые правки для повтора — в исходном порядке. */
export function forwardChanges(entry: HistoryEntry): readonly TextChange[] {
  return entry.changes;
}

export class EditHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Сколько шагов можно отменить — для меню и тестов. */
  get depth(): number {
    return this.past.length;
  }

  /**
   * Записать шаг. Если попрошено схлопывание и оно уместно, правки дописываются к
   * предыдущему шагу, а повтор сбрасывается: после новой правки «вперёд» уже некуда.
   */
  push(entry: HistoryEntry, options: PushOptions = {}): void {
    const now = options.now ?? Date.now();
    const last = this.past[this.past.length - 1];
    if (options.merge && last && this.shouldMerge(last, entry, now)) {
      this.past[this.past.length - 1] = {
        changes: [...last.changes, ...entry.changes],
        before: last.before,
        after: entry.after,
        kind: last.kind,
        time: entry.time,
      };
    } else {
      this.past.push(entry);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.future = [];
  }

  /** Шаг для отмены (или `null`, если отменять нечего). Возвращённое надо применить обратными правками. */
  undo(): HistoryEntry | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(entry);
    return entry;
  }

  /** Шаг для повтора (или `null`). Возвращённое надо применить прямыми правками. */
  redo(): HistoryEntry | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push(entry);
    return entry;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }

  /**
   * Схлопывать ли новый шаг с предыдущим. Три условия разом: то же действие,
   * впритык по месту и в пределах окна времени. Разное действие, разрыв или пауза —
   * отдельный шаг отмены.
   */
  private shouldMerge(last: HistoryEntry, entry: HistoryEntry, now: number): boolean {
    if (entry.kind === 'other' || last.kind !== entry.kind) return false;
    if (now - last.time > MERGE_WINDOW_MS) return false;
    // Сколько правок в новой группе (одна при обычной каретке, по правке на каретку
    // при мультикурсоре) — столько же берём из конца прежней и сверяем по очереди.
    // Каждая новая должна примыкать к своей прежней: тогда это продолжение одного
    // действия (набор, удаление подряд), где бы оно ни шло.
    const count = entry.changes.length;
    if (count === 0 || last.changes.length < count) return false;
    const tail = last.changes.slice(last.changes.length - count);
    // Правки в группе идут по убыванию места, поэтому у каждой каретки есть сдвиг от
    // правок левее её — при мультикурсоре он как раз и объясняет, почему второй набор
    // начинается там, где начинается.
    return entry.changes.every((change, index) => touches(tail[index]!, change, shiftBefore(tail, index)));
  }
}

/**
 * Сдвиг правки `index` от правок, стоящих ЛЕВЕЕ её в той же группе. При мультикурсоре
 * они применяются позже и двигают её место — без этой поправки набор на нескольких
 * каретках не считался бы одним действием.
 */
function shiftBefore(group: readonly TextChange[], index: number): number {
  const start = group[index]!.start;
  let shift = 0;
  for (let i = index + 1; i < group.length; i += 1) {
    const change = group[i]!;
    if (change.start >= start) continue;
    shift += change.inserted.length - change.removed.length;
  }
  return shift;
}

/**
 * Правки примыкают: вторая начинается там, где кончилась первая (набор или удаление
 * назад). `shift` — поправка на правки левее (см. `shiftBefore`).
 */
function touches(previous: TextChange, next: TextChange, shift = 0): boolean {
  const previousStart = previous.start + shift;
  const previousEnd = previousStart + previous.inserted.length;
  if (next.start === previousEnd && next.removed.length === 0) return true;
  // Удаление назад: Backspace сдвигает начало влево, а конец совпадает с прежним началом.
  const nextEnd = next.start + next.removed.length;
  return next.inserted.length === 0 && nextEnd === previousStart;
}
