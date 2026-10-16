/**
 * Панель «Задачи»: пометки TODO/FIXME/HACK/XXX по всему проекту.
 *
 * Панель только показывает и переходит: список ей отдаёт вызывающий (в приложении —
 * поиск по проекту с готовым запросом), а разбор находок, отбор и группировка —
 * чистое правило из `shared/todo-list.ts`. Поэтому здесь нет ни обхода файлов, ни
 * знания, откуда взялись находки.
 *
 * Список собирается по показу вкладки и по правкам в проекте (когда панель на виду):
 * поиск по проекту — работа заметная, держать её на каждое сохранение незачем.
 * Фильтр при пересборке не сбрасывается — в поле продолжается ввод.
 */

import { groupTodos, todoBadgeText, todoSummary, type TodoGroup, type TodoItem } from '../../shared/todo-list';
import { clear, h, svgIcon } from './dom';

export interface TodoPanelDeps {
  /** Найти пометки по проекту (в приложении — RPC `workspace.search` с готовым запросом). */
  scan: () => Promise<TodoItem[]>;
  /** Показать пометку: открыть файл и встать на место. */
  reveal: (path: string, line: number, column: number) => void;
  /** Короткая подпись файла — в приложении путь от корня проекта. */
  label: (path: string) => string;
  /** Есть ли открытый проект: без него искать негде. */
  hasWorkspace: () => boolean;
}

export interface TodoPanel {
  element: HTMLElement;
  /** Пересобрать список (при показе вкладки и по правкам проекта). */
  refresh(): void;
  /** Собрать список с задержкой — для потока событий о правках. */
  schedule(): void;
  /** Все пометки последней сборки — по ним считается значок вкладки. */
  items(): readonly TodoItem[];
  /** Текст значка на вкладке: всего пометок; нет ни одной — значка нет. */
  badge(): string | null;
}

/** Пауза перед повторным поиском: правки в проекте идут потоком. */
const REFRESH_DEBOUNCE_MS = 400;

export function createTodoPanel(deps: TodoPanelDeps): TodoPanel {
  const summary = h('span', { class: 'todo-summary' });
  const filter = h('input', {
    class: 'todo-filter',
    type: 'search',
    placeholder: 'Фильтр…',
    title: 'Отбор по тексту пометки, виду или файлу',
  });
  const refreshButton = h(
    'button',
    { class: 'todo-refresh btn btn-small', type: 'button', title: 'Пересобрать список' },
    svgIcon('search', 12),
  );
  const list = h('div', { class: 'todo-list' });
  const element = h(
    'div',
    { class: 'todo-panel' },
    h(
      'div',
      { class: 'todo-toolbar' },
      h('span', { class: 'todo-title' }, 'Задачи'),
      summary,
      h('div', { class: 'toolbar-spacer' }),
      filter,
      refreshButton,
    ),
    list,
  );

  /** Пометки последней сборки: держим, чтобы значок вкладки не ходил в поиск зря. */
  let current: TodoItem[] = [];
  /** Номер сборки: поздний ответ старого поиска не должен затирать свежий. */
  let sequence = 0;
  let timer: number | null = null;

  filter.addEventListener('input', () => render());

  /** Строка пометки: вид, текст и место — как в списке задач IDE. */
  const todoRow = (item: TodoItem): HTMLElement =>
    h(
      'button',
      {
        class: 'todo-row',
        type: 'button',
        title: `${item.marker}: ${item.text} — строка ${item.line}`,
        onClick: () => deps.reveal(item.path, item.line, item.column),
      },
      h('span', { class: `todo-marker is-${item.marker.toLowerCase()}` }, item.marker),
      h('span', { class: 'todo-text' }, item.text || '(без пояснения)'),
      h('span', { class: 'todo-position' }, `${item.line}:${item.column}`),
    );

  const groupHead = (group: TodoGroup): HTMLElement =>
    h(
      'div',
      { class: 'todo-group-head' },
      h('span', { class: 'todo-file', title: group.path }, group.label),
      h('span', { class: 'todo-group-counts' }, todoSummary(group.items)),
    );

  const render = (): void => {
    clear(list);
    // Итог — по всем пометкам, а не по отобранным: фильтр сужает список, но число
    // найденных задач не должно от него зависеть.
    summary.textContent = todoSummary(current);

    if (current.length === 0) {
      list.appendChild(h('div', { class: 'todo-empty' }, 'Пометок TODO, FIXME, HACK и XXX нет.'));
      return;
    }

    const groups = groupTodos(current, filter.value, deps.label);
    if (groups.length === 0) {
      list.appendChild(h('div', { class: 'todo-empty' }, 'Ничего не найдено по фильтру.'));
      return;
    }

    for (const group of groups) {
      list.appendChild(groupHead(group));
      for (const item of group.items) list.appendChild(todoRow(item));
    }
  };

  const refresh = (): void => {
    if (!deps.hasWorkspace()) {
      current = [];
      summary.textContent = '';
      clear(list);
      list.appendChild(h('div', { class: 'todo-empty' }, 'Сначала откройте проект.'));
      return;
    }
    const ticket = (sequence += 1);
    list.replaceChildren(h('div', { class: 'todo-empty' }, 'Ищу пометки…'));
    void deps
      .scan()
      .then((items) => {
        if (ticket !== sequence) return;
        current = items;
        render();
      })
      .catch(() => {
        if (ticket !== sequence) return;
        current = [];
        summary.textContent = '';
        clear(list);
        list.appendChild(h('div', { class: 'todo-empty' }, 'Не удалось выполнить поиск.'));
      });
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  refreshButton.addEventListener('click', () => refresh());

  return { element, refresh, schedule, items: () => current, badge: () => todoBadgeText(current) };
}
