/**
 * Пометки в коде (TODO, FIXME, HACK, XXX): разбор находок поиска и сборка списка.
 *
 * Панель «Задачи» не ходит по проекту сама: она просит обычный поиск по проекту
 * (`workspace.search`) с готовым запросом, а найденные строки разбирает здесь. Так
 * у неё нет ни своего обхода файлов, ни своего кэша — тот же путь, что у панели
 * поиска и у инструмента агента.
 *
 * Всё в этом модуле — чистое преобразование списка находок, поэтому живёт в `shared`
 * и закреплено тестом (`tests/todo-list.test.ts`): панель остаётся тонкой (рисует и
 * слушает клики), а правила видно без окна.
 */

import type { SearchHit } from './api';

/** Виды пометок, которые ищем. Набор — тот же, что у команды «Найти TODO и FIXME». */
export const TODO_MARKERS = ['TODO', 'FIXME', 'HACK', 'XXX'] as const;

export type TodoMarker = (typeof TODO_MARKERS)[number];

/** Регулярка запроса к поиску по проекту: слово целиком, регистр не важен. */
export const TODO_QUERY = `\\b(${TODO_MARKERS.join('|')})\\b`;

export interface TodoItem {
  path: string;
  line: number;
  column: number;
  marker: TodoMarker;
  /** Что человек написал после пометки — без самого слова и ведущих знаков. */
  text: string;
}

/** Регулярка пометки внутри строки: так же, как в запросе к поиску. */
const MARKER_RE = new RegExp(`\\b(${TODO_MARKERS.join('|')})\\b`, 'i');

/**
 * Разобрать строку находки. Берём ПЕРВУЮ пометку строки: их на одной строке бывает
 * несколько, но строка — это одна запись списка, и ведёт она к её началу.
 */
export function parseTodo(hit: SearchHit): TodoItem | null {
  const match = MARKER_RE.exec(hit.text);
  if (!match || match.index === undefined) return null;
  return {
    path: hit.path,
    line: hit.line,
    column: hit.column,
    marker: match[1]!.toUpperCase() as TodoMarker,
    text: stripLead(hit.text.slice(match.index + match[0].length)),
  };
}

/** Убрать ведущие разделители и пробелы: «TODO: сделать» → «сделать». */
function stripLead(text: string): string {
  return text.replace(/^[\s:：\-–—]+/, '').trim();
}

/** Разобрать все находки: строки без пометки (пришёл обычный поиск) отбрасываем. */
export function toTodoItems(hits: readonly SearchHit[]): TodoItem[] {
  const items: TodoItem[] = [];
  for (const hit of hits) {
    const item = parseTodo(hit);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Отбор по подстроке: ищем в тексте пометки, её виде и пути файла. Пустой запрос
 * ничего не отсеивает. Регистр не важен — так и набирают в поле фильтра.
 */
export function filterTodos(items: readonly TodoItem[], query: string): TodoItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter(
    (item) =>
      item.text.toLowerCase().includes(needle) ||
      item.marker.toLowerCase().includes(needle) ||
      item.path.toLowerCase().includes(needle),
  );
}

/** Сколько пометок каждого вида. */
export function todoCounts(items: readonly TodoItem[]): Record<TodoMarker, number> {
  const counts = Object.fromEntries(TODO_MARKERS.map((marker) => [marker, 0])) as Record<TodoMarker, number>;
  for (const item of items) counts[item.marker] += 1;
  return counts;
}

/** Пометки одного файла: подпись для заголовка и счётчики по видам. */
export interface TodoGroup {
  path: string;
  /** Короткая подпись файла (в приложении — путь от корня проекта). */
  label: string;
  items: TodoItem[];
  counts: Record<TodoMarker, number>;
}

/**
 * Сгруппировать по файлам, сохранив порядок списка (пути уже отсортированы). Файлы
 * без подходящих пометок в результат не попадают вовсе: пустые заголовки — шум.
 */
export function groupTodos(items: readonly TodoItem[], query: string, label: (path: string) => string): TodoGroup[] {
  const groups = new Map<string, TodoGroup>();
  for (const item of filterTodos(items, query)) {
    let group = groups.get(item.path);
    if (!group) {
      group = { path: item.path, label: label(item.path), items: [], counts: todoCounts([]) };
      groups.set(item.path, group);
    }
    group.items.push(item);
  }
  for (const group of groups.values()) group.counts = todoCounts(group.items);
  return [...groups.values()];
}

/** Заголовок панели: «3 TODO, 1 FIXME». Виды не склоняем — это аббревиатуры. */
export function todoSummary(items: readonly TodoItem[]): string {
  const counts = todoCounts(items);
  const parts: string[] = [];
  for (const marker of TODO_MARKERS) {
    if (counts[marker] > 0) parts.push(`${counts[marker]} ${marker}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'Пометок нет';
}

/** Текст значка на вкладке: всего пометок; нет ни одной — значка нет. */
export function todoBadgeText(items: readonly TodoItem[]): string | null {
  return items.length > 0 ? String(items.length) : null;
}
