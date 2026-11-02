import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTodoPanel, type TodoPanelDeps } from '../src/renderer/ui/todo-panel';
import type { TodoItem } from '../src/shared/todo-list';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Панель «Задачи» (`renderer/ui/todo-panel.ts`).
 *
 * Отбор и группировка живут в `shared/todo-list.ts` и проверены отдельно. Здесь то,
 * что делает сама панель: когда идёт поиск, что вместо списка видит человек, куда
 * ведёт клик по пометке и какие числа показывает значок.
 */

function item(overrides: Partial<TodoItem> = {}): TodoItem {
  return { path: '/p/a.ts', line: 3, column: 5, marker: 'TODO', text: 'доделать', ...overrides };
}

function setup(overrides: Partial<TodoPanelDeps> = {}) {
  const revealed: [string, number, number][] = [];
  const deps: TodoPanelDeps = {
    scan: async () => [item()],
    reveal: (path, line, column) => revealed.push([path, line, column]),
    label: (path) => path.replace('/p/', ''),
    hasWorkspace: () => true,
    ...overrides,
  };
  const panel = createTodoPanel(deps);
  // Поиск асинхронный: `refresh` запускает `scan` и рисует ответ промисом.
  // `refresh` идёт через `.then/.catch`: двух микро-кадров хватает не всегда
  // (отказ отклонённого промиса приходит отдельным кадром), поэтому ждём макрозадачу.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { panel, deps, revealed, settle };
}

describe('панель «Задачи»', () => {
  beforeEach(() => {
    installMiniDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('без проекта ищет негде — говорит об этом вместо пустого списка', () => {
    const { panel } = setup({ hasWorkspace: () => false, scan: async () => [item()] });

    panel.refresh();

    expect(panel.items()).toEqual([]);
    expect(panel.element.querySelector('.todo-empty')?.textContent).toBe('Сначала откройте проект.');
  });

  it('найденные пометки показываются списком и считаются на значке', async () => {
    const { panel, settle } = setup({
      scan: async () => [item(), item({ line: 9, marker: 'FIXME', path: '/p/b.ts' })],
    });

    panel.refresh();
    // Пока ответ не пришёл, человек видит, что поиск идёт.
    expect(panel.element.querySelector('.todo-empty')?.textContent).toBe('Ищу пометки…');
    await settle();

    expect(panel.badge()).toBe('2');
    expect(panel.element.querySelectorAll('.todo-row')).toHaveLength(2);
  });

  it('нет пометок — значка нет, а список объясняет почему', async () => {
    const { panel, settle } = setup({ scan: async () => [] });

    panel.refresh();
    await settle();

    expect(panel.badge()).toBeNull();
    expect(panel.element.querySelector('.todo-empty')?.textContent).toContain('нет');
  });

  it('ошибка поиска не оставляет «Ищу пометки…» навсегда', async () => {
    const { panel, settle } = setup({ scan: async () => Promise.reject(new Error('нет доступа')) });

    panel.refresh();
    await settle();

    expect(panel.items()).toEqual([]);
    expect(panel.element.querySelector('.todo-empty')?.textContent).toBe('Не удалось выполнить поиск.');
  });

  it('поздний ответ старого поиска не затирает свежий', async () => {
    // Правки идут потоком: пока первый поиск ещё думает, может начаться второй.
    // Ответ первого приходит позже, но данные у него старее — показать надо второй.
    let release: (value: TodoItem[]) => void = () => {};
    const first = new Promise<TodoItem[]>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const { panel, settle } = setup({
      scan: () => {
        call += 1;
        return call === 1 ? first : Promise.resolve([item({ text: 'свежая' })]);
      },
    });

    panel.refresh();
    panel.refresh();
    await settle();
    release([item({ text: 'устаревшая' })]);
    await settle();

    expect(panel.items()).toHaveLength(1);
    expect(panel.items()[0]?.text).toBe('свежая');
  });

  it('клик по пометке открывает файл на её месте', async () => {
    const { panel, settle, revealed } = setup({
      scan: async () => [item({ path: '/p/src/x.ts', line: 12, column: 7 })],
    });
    panel.refresh();
    await settle();

    (panel.element.querySelector('.todo-row') as unknown as { click(): void }).click();

    expect(revealed).toEqual([['/p/src/x.ts', 12, 7]]);
  });

  it('фильтр сужает список, но число найденных задач не меняет', async () => {
    const { panel, settle } = setup({
      scan: async () => [item({ text: 'первая' }), item({ text: 'вторая', line: 8 })],
    });
    panel.refresh();
    await settle();

    const filter = panel.element.querySelector('.todo-filter') as unknown as {
      value: string;
      dispatchEvent(event: unknown): void;
    };
    filter.value = 'вторая';
    filter.dispatchEvent({ type: 'input' });

    expect(panel.element.querySelectorAll('.todo-row')).toHaveLength(1);
    // Сводка — по всем пометкам: фильтр меняет вид, а не число задач в проекте.
    expect(panel.badge()).toBe('2');
  });

  it('пусто после фильтра — так и говорит, а не показывает пустоту', async () => {
    const { panel, settle } = setup({ scan: async () => [item({ text: 'первая' })] });
    panel.refresh();
    await settle();

    const filter = panel.element.querySelector('.todo-filter') as unknown as {
      value: string;
      dispatchEvent(event: unknown): void;
    };
    filter.value = 'ничего такого';
    filter.dispatchEvent({ type: 'input' });

    expect(panel.element.querySelector('.todo-empty')?.textContent).toBe('Ничего не найдено по фильтру.');
  });
});
