import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient } from '../src/renderer/core/rpc';
import type { WorkspaceModel } from '../src/renderer/core/workspace-model';
import { createQuickOpen } from '../src/renderer/ui/quick-open';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Окно быстрого перехода целиком: файлы, `>` команды, `#` поиск.
 *
 * Проверяем не разбор префикса (он в quick-prefix.test.ts), а то, что режим
 * меняет сам СПИСОК и что пустой список объясняется словами.
 */
const rpc = { request: vi.fn(async () => ['ui/chat.ts', 'core/dom.ts']) } as unknown as RpcClient;
const workspace = { root: '/project' } as WorkspaceModel;

type Deps = Parameters<typeof createQuickOpen>[0];

function view(extra: Partial<Deps> = {}) {
  return createQuickOpen({ rpc, workspace, openFile: vi.fn(), ...extra } as Deps);
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function titles(quick: ReturnType<typeof view>): (string | null)[] {
  return [...quick.element.querySelectorAll('.palette-item-title')].map((node) => node.textContent);
}

// jsdom в проекте нет: мини-DOM ровно на те методы, которыми живёт окно.
beforeEach(() => {
  const { document: mini, window: miniWindow } = installMiniDom();
  (globalThis as { document?: unknown }).document = mini;
  (globalThis as { window?: unknown }).window = miniWindow;
  (globalThis as { Event?: unknown }).Event =
    mini.Event ??
    class {
      constructor(public type: string) {}
    };
  (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent =
    mini.KeyboardEvent ??
    class {
      constructor(
        public type: string,
        public init: { key?: string } = {},
      ) {}
      get key() {
        return this.init.key ?? '';
      }
      preventDefault() {}
      stopPropagation() {}
    };
});

describe('окно быстрого перехода', () => {
  it('без префикса показывает файлы проекта', async () => {
    const quick = view();
    document.body.append(quick.element);
    await quick.open();
    expect(titles(quick)).toEqual(['chat.ts', 'dom.ts']);
  });

  it('файлов нет — так и сказано, а не «ничего не найдено»', async () => {
    const empty = { request: vi.fn(async () => []) } as unknown as RpcClient;
    const quick = createQuickOpen({ rpc: empty, workspace, openFile: vi.fn() } as Deps);
    document.body.append(quick.element);
    await quick.open();
    expect(quick.element.querySelector('.palette-empty')?.textContent).toBe('В проекте нет файлов');
  });

  it('`>` переключает список на команды без переоткрытия окна', async () => {
    const quick = view({
      commands: {
        list: () => [
          { id: 'view.collapseAll', title: 'Свернуть всё', category: 'Вид' },
          { id: 'file.save', title: 'Сохранить', category: 'Файл' },
        ],
        isEnabled: () => true,
        run: vi.fn(),
      },
    } as unknown as Partial<Deps>);
    document.body.append(quick.element);
    await quick.open();
    type(quick.element.querySelector('input')!, '>сверн');
    expect(titles(quick)).toEqual(['Свернуть всё']);
    // Подсветка совпавших букв: видно, почему строка осталась.
    expect(quick.element.querySelectorAll('mark').length).toBeGreaterThan(0);
    // Режим назван в подвале — иначе `>` выглядит опечаткой.
    expect(quick.element.querySelector('.palette-mode.is-active')?.textContent).toContain('>');
  });

  it('Enter в режиме команд запускает команду', async () => {
    const run = vi.fn();
    const quick = view({
      commands: {
        list: () => [{ id: 'file.save', title: 'Сохранить', category: 'Файл' }],
        isEnabled: () => true,
        run,
      },
    } as unknown as Partial<Deps>);
    document.body.append(quick.element);
    await quick.open('>сохр');
    quick.element.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(run).toHaveBeenCalledWith('file.save');
  });

  it('`#` показывает совпадения поиска от хоста', async () => {
    const search = vi.fn(async () => [
      { path: '/project/a.ts', line: 3, column: 1, label: 'const x = 1', detail: 'a.ts' },
    ]);
    const quick = view({ search } as unknown as Partial<Deps>);
    document.body.append(quick.element);
    await quick.open('#const');
    await vi.waitFor(() => {
      expect(quick.element.querySelector('.palette-item-title')?.textContent).toBe('const x = 1');
    });
  });

  it('Escape из режима возвращает к файлам, а не закрывает окно', async () => {
    const quick = view({ search: async () => [] } as unknown as Partial<Deps>);
    document.body.append(quick.element);
    await quick.open('#запрос');
    const input = quick.element.querySelector('input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(quick.element.hidden).toBe(false);
    expect(input.value).toBe('');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(quick.element.hidden).toBe(true);
  });

  // TASKS п.1.3: серый пункт обязан объяснить, чего не хватает. Без причины
  // «недоступно» читается как поломка, и человек идёт искать причину в догадках.
  it('недоступная команда называет причину рядом с названием', async () => {
    const quick = view({
      commands: {
        list: () => [
          { id: 'git.pull', title: 'Влить изменения', category: 'Git' },
          { id: 'file.save', title: 'Сохранить', category: 'Файл' },
        ],
        isEnabled: (id: string) => id !== 'git.pull',
        disabledReason: (id: string) => (id === 'git.pull' ? 'В проекте нет git-репозитория' : ''),
        run: vi.fn(),
      },
    } as unknown as Partial<Deps>);
    document.body.append(quick.element);
    await quick.open('>');
    const reasons = [...quick.element.querySelectorAll('.palette-item-reason')].map((node) => node.textContent);
    expect(reasons).toEqual(['В проекте нет git-репозитория']);
    // Причина стоит у того пункта, которого касается, а не отдельной строкой.
    const disabled = quick.element.querySelector('.is-disabled');
    expect(disabled?.querySelector('.palette-item-reason')?.textContent).toBe('В проекте нет git-репозитория');
  });

  it('доступная команда причины не показывает — даже если причина есть', async () => {
    const quick = view({
      commands: {
        list: () => [{ id: 'file.save', title: 'Сохранить', category: 'Файл' }],
        isEnabled: () => true,
        disabledReason: () => 'Нет открытого файла',
        run: vi.fn(),
      },
    } as unknown as Partial<Deps>);
    document.body.append(quick.element);
    await quick.open('>');
    expect(quick.element.querySelectorAll('.palette-item-reason').length).toBe(0);
  });
});
