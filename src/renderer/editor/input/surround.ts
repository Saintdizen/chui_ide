/**
 * Обернуть выделение: «surround with».
 *
 * Скобка вокруг текста — то, что при выделении хочется сделать одной командой:
 * взять фрагмент и обрамить его парой знаков. Часть этого редактор уже умеет по
 * вводу знака (`insertPair` в `editing.ts`): набрал `(` с выделением — оно взяло
 * выделение в скобки. Но так доступны только три пары, и делается это вслепую:
 * человек должен помнить, что знак оборачивает. Отдельная команда даёт ВЫБОР —
 * какой парой, видно списком, — и включает то, что по вводу недоступно (кавычки,
 * блочный комментарий, а для разметки — теги).
 *
 * Здесь только выбор и обёртка — чистая часть:
 *
 *   • `surroundOptions(languageId)` — из чего выбирать. Набор общий (скобки и
 *     кавычки) плюс то, что зависит от языка: блочный комментарий у языков с ним,
 *     теги у разметки. Список — данные, поэтому его видно в тестах целиком;
 *   • `wrapSelection(buffer, selection, option)` — сама обёртка. Выделение при этом
 *     ОСТАЁТСЯ на прежнем тексте: чаще всего следом оборачивают ещё раз, и терять
 *     выделение — значит каждый раз выделять заново. Пустое выделение даёт пару с
 *     кареткой между знаками — как по вводу.
 *
 * Абзацы текста НЕ переформатируем: обёртка добавляет знаки вокруг, но не двигает
 * строки. Переносить скобку на свою строку и отбивать отступ — это уже форматирование,
 * у него свой инструмент (`format.document`), и решать за человека тут нечего.
 *
 * Модуль чистый: ни DOM, ни истории. Что записать в историю, решает контроллер.
 */

import type { TextChange } from '../core/history';
import type { TextBuffer } from '../core/text-buffer';
import { isEmpty, selectionEnd, selectionStart, type Selection } from '../view/selection';
import { blockCommentFor } from './comments';
import type { EditResult } from './editing';

/** Чем можно обернуть: пара знаков и как это называется в списке. */
export interface SurroundOption {
  /** Устойчивый ключ — по нему команду зовут извне (палитра, тесты). */
  readonly id: string;
  /** Подпись в списке выбора. */
  readonly label: string;
  /** Знак перед выделением. */
  readonly open: string;
  /** Знак после выделения. */
  readonly close: string;
}

/** Общие пары: они есть в любом языке — это не синтаксис, а форма записи текста. */
const COMMON: readonly SurroundOption[] = [
  { id: 'paren', label: 'Круглые скобки', open: '(', close: ')' },
  { id: 'bracket', label: 'Квадратные скобки', open: '[', close: ']' },
  { id: 'brace', label: 'Фигурные скобки', open: '{', close: '}' },
  { id: 'double-quote', label: 'Двойные кавычки', open: '"', close: '"' },
  { id: 'single-quote', label: 'Одинарные кавычки', open: "'", close: "'" },
  { id: 'backtick', label: 'Обратные кавычки', open: '`', close: '`' },
];

/**
 * Из чего выбирать для языка. Язык влияет двумя вещами: есть ли у него блочный
 * комментарий (тогда им тоже можно обернуть) и разметка ли это (тогда доступны теги).
 */
export function surroundOptions(languageId: string | null | undefined): SurroundOption[] {
  const options = [...COMMON];
  const comment = blockCommentFor(languageId);
  if (comment) {
    options.push({ id: 'block-comment', label: 'Блочный комментарий', open: comment[0], close: comment[1] });
  }
  if (isMarkup(languageId)) {
    options.push({ id: 'tag', label: 'Тег разметки', open: '<div>', close: '</div>' });
  }
  return options;
}

/** Разметка ли это: у неё обёртка тегом осмысленна, у кода — нет. */
function isMarkup(languageId: string | null | undefined): boolean {
  const id = (languageId ?? '').toLowerCase();
  return id === 'html' || id === 'xml';
}

/** Найти вариант по ключу (нужен вызову извне: палитра, проба, проверки). */
export function surroundOptionById(languageId: string | null | undefined, id: string): SurroundOption | null {
  return surroundOptions(languageId).find((option) => option.id === id) ?? null;
}

/**
 * Обернуть выделение парой знаков.
 *
 * Есть выделение — оборачиваем его и оставляем ВЫДЕЛЕННЫМ прежний текст (знаки
 * встают снаружи): так обёртку можно накладывать одну за другой. Пусто — вставляем
 * пустую пару и ставим каретку между знаками, как при вводе открывающего знака.
 *
 * `null` — оборачивать нечего: пустая обёртка.
 */
export function wrapSelection(buffer: TextBuffer, selection: Selection, option: SurroundOption): EditResult | null {
  if (option.open.length === 0 && option.close.length === 0) return null;
  const start = selectionStart(selection);
  const end = selectionEnd(selection);

  if (isEmpty(selection)) {
    const inserted = `${option.open}${option.close}`;
    const change = replaceRange(buffer, start, 0, inserted);
    const caret = start + option.open.length;
    return { selection: { anchor: caret, active: caret }, change };
  }

  const selected = buffer.getText(start, end);
  const inserted = `${option.open}${selected}${option.close}`;
  const change = replaceRange(buffer, start, end - start, inserted);
  // Выделение — по-прежнему сам текст, только сдвинутый на длину открывающего знака.
  const anchor = start + option.open.length;
  return { selection: { anchor, active: anchor + selected.length }, change };
}

/** Заменить участок буфера и описать это как правку. */
function replaceRange(buffer: TextBuffer, start: number, length: number, inserted: string): TextChange {
  const removed = buffer.replace(start, length, inserted);
  return { start, removed, inserted };
}
