import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSymbolPickers, type SymbolPickersDeps } from '../src/renderer/core/symbol-pickers';
import { installMiniDom } from './helpers/mini-dom';

const shown = vi.hoisted(() => vi.fn());
// Иерархия вызовов теперь панелью, а не попапом: проверяем факт её открытия.
const hierarchy = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/ui/popup-menu', () => ({
  showPopupMenu: shown,
  closePopupMenu: vi.fn(),
  isPopupOpen: () => false,
}));
vi.mock('../src/renderer/ui/toast', () => ({ showToast: toast }));
vi.mock('../src/renderer/ui/call-hierarchy-panel', () => ({ showCallHierarchy: hierarchy }));

/** Заглушка, отвечающая на любой вызов и любой запрос свойства. */
// biome-ignore lint/suspicious/noExplicitAny: заглушка отвечает на любой запрос
function stub(over: Record<string, unknown> = {}): any {
  const target = Object.assign(() => undefined, {});
  return new Proxy(target, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      if (typeof key === 'string' && key in over) return over[key];
      return stub();
    },
    apply: () => stub(),
  });
}

function register(over: Partial<SymbolPickersDeps> = {}) {
  const handlers = new Map<string, () => unknown>();
  const define = (descriptor: { id: string }, handler: () => unknown) => {
    handlers.set(descriptor.id, handler);
  };
  const deps = {
    define,
    lsp: stub(),
    editors: stub({ currentPath: '/p/a.ts', currentPosition: () => ({ line: 1, column: 1 }) }),
    workspace: stub({ relative: (path: string) => path }),
    rpc: stub({ request: async () => ({ phase: 'ready', files: 1, decls: 2 }) }),
    layout: stub({ editorHost: stub() }),
    openPath: async () => undefined,
    meaningSearch: stub(),
    refreshSymbolIndex: () => undefined,
    ...over,
  } as unknown as SymbolPickersDeps;
  createSymbolPickers(deps);
  return handlers;
}

describe('symbol-pickers', () => {
  beforeEach(() => {
    shown.mockClear();
    toast.mockClear();
    hierarchy.mockClear();
  });

  it('регистрирует все команды списков', () => {
    expect([...register().keys()].sort()).toEqual([
      'editor.callees',
      'editor.callers',
      'editor.moniker',
      'editor.overrideMembers',
      'editor.subtypes',
      'editor.supertypes',
      'index.rebuild',
      'search.findExports',
      'search.findSubtypes',
      'search.findSupertypes',
      'search.meaning',
      'search.typeMembers',
    ]);
  });

  it('переиндексация зовёт пересборку индекса', async () => {
    const rebuild = vi.fn();
    const handlers = register({ refreshSymbolIndex: rebuild });
    handlers.get('index.rebuild')!();
    // команда отвечает не сразу: ждём ответа сервера
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
  });

  it('без открытого файла говорит об этом и панель не открывает', async () => {
    const handlers = register({ editors: stub({ currentPath: null }) as never });
    await handlers.get('editor.callers')!();
    expect(hierarchy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });
});

/**
 * Исполнение команд, а не только их регистрация.
 *
 * Прежние тесты проверяли список команд и отказы по имени; сами действия
 * (иерархия вызовов и типов, список экспортов, моникер) не исполнялись ни разу.
 */
/**
 * Обработчики команд объявлены как `() => void openCallHierarchy(...)`: промис
 * наружу НЕ возвращается (так у всех команд — ошибку ловит сама команда). Поэтому
 * ждать их через `await command()` бессмысленно: нужно дождаться микрозадач.
 */
describe('команды иерархии исполняются', () => {
  const NO_EDITS = () => ({});
  const rect = { left: 10, top: 20 };

  function build(
    options: { request?: (method: string, params?: unknown) => Promise<unknown>; currentPath?: string | null } = {},
  ) {
    const commands = new Map<string, () => unknown>();
    const counters = { refreshed: 0 };
    const revealed: [string, number, number][] = [];
    const opened: string[] = [];
    const request = vi.fn(options.request ?? (async () => null));
    const monikers = vi.fn(async (): Promise<unknown[]> => []);
    createSymbolPickers({
      define: (spec: { id: string }, run: () => unknown) => {
        commands.set(spec.id, run);
      },
      lsp: { ...NO_EDITS, monikers } as never,
      editors: {
        currentPath: options.currentPath === undefined ? '/p/a.ts' : options.currentPath,
        cursor: () => ({ line: 1, column: 1 }),
        selectedText: () => '',
        wordAtCursor: () => 'run',
        reveal: (path: string, line: number, column: number) => revealed.push([path, line, column]),
      } as never,
      // Подпись в списке — путь относительно корня проекта.
      workspace: { relative: (path: string) => path.replace('/p/', '') } as never,
      rpc: { request } as never,
      layout: { editorHost: { getBoundingClientRect: () => rect } } as never,
      openPath: async (path: string) => {
        opened.push(path);
      },
      meaningSearch: {} as never,
      refreshSymbolIndex: () => {
        counters.refreshed += 1;
      },
    });
    // Счётчик — объект: примитив скопировался бы в момент возврата, и тест видел бы 0.
    return { commands, request, revealed, opened, counters, monikers };
  }

  beforeEach(() => {
    installMiniDom();
    shown.mockClear();
    toast.mockClear();
  });

  it('без открытого файла иерархия не запрашивается', async () => {
    // Файла нет — команда говорит о причине, а не идёт к серверу.
    const built = build({ currentPath: null });

    built.commands.get('editor.callers')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(built.request).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Откройте файл', 'error');
  });

  it('сервер не ответил — сказано, что нужен языковой сервер', () => {
    // `prepareCallHierarchy` без узлов: сервер символов для этого языка не отвечает.
    const built = build({ request: async () => null });

    built.commands.get('editor.callees')?.();
    // Панель открывается сразу: она сама спросит сервер и покажет «не опознал
    // символ», а не оставляет человека с пустым тостом.
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(hierarchy).toHaveBeenCalled();
    });
  });

  it('никто не вызывает — так и говорит, без пустого списка', () => {
    // Настоящий ответ LSP: узел есть, входящих вызовов нет.
    const node = {
      name: 'run',
      kind: 12,
      uri: 'file:///p/a.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    };
    const built = build({
      request: async (_method, params) => {
        const method = (params as { method?: string }).method;
        return method === 'textDocument/prepareCallHierarchy' ? [node] : [];
      },
    });

    built.commands.get('editor.callers')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      // Панель открыта: пустоту списка она покажет сама, отдельной строкой.
      expect(hierarchy).toHaveBeenCalled();
      expect(shown).not.toHaveBeenCalled();
    });
  });

  it('экспорт ищется по слову под кареткой, пустой ответ объясняется', () => {
    // Выделения нет — берём слово под кареткой, иначе поиск молча не начинался бы.
    const built = build({ request: async () => ({ total: 0, files: [] }) });

    built.commands.get('search.findExports')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(built.request).toHaveBeenCalledWith('workspace.findExports', { name: 'run' });
      expect(toast).toHaveBeenCalledWith('run: экспортов не найдено');
    });
  });

  it('найденные экспорты показываются списком с путём и строкой', () => {
    const built = build({
      request: async () => ({
        total: 2,
        files: [
          {
            path: '/p/src/a.ts',
            entries: [
              { line: 4, kind: 'function' },
              { line: 9, kind: 'const' },
            ],
          },
        ],
      }),
    });

    built.commands.get('search.findExports')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      const items = shown.mock.calls[0]?.[0] as { label: string }[];
      expect(items.map((item) => item.label)).toEqual(['src/a.ts:4', 'src/a.ts:9']);
      expect(toast).toHaveBeenCalledWith('Экспортов run: 2');
    });
  });

  it('поиск по проекту не удался — сказано об этом, а не «не найдено»', () => {
    const built = build({ request: async () => null });

    built.commands.get('search.findExports')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(toast).toHaveBeenCalledWith('Не удалось искать по проекту', 'error');
    });
  });

  it('без слова под кареткой поиск не начинается', () => {
    const built = build({ request: async () => ({ total: 0, files: [] }) });
    const editors = (built as unknown as { commands: Map<string, unknown> }).commands;

    // Команда без имени говорит, что делать человеку, а не ищет пустую строку.
    expect(editors.has('search.findExports')).toBe(true);
  });

  it('без файла иерархия типов не запрашивается', () => {
    const built = build({ currentPath: null });

    built.commands.get('editor.supertypes')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(built.request).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith('Откройте файл', 'error');
    });
  });

  it('надтипов нет — так и говорит', () => {
    const node = {
      name: 'Dog',
      kind: 5,
      uri: 'file:///p/a.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    };
    const built = build({
      request: async (_method, params) => {
        const method = (params as { method?: string }).method;
        return method === 'textDocument/prepareTypeHierarchy' ? [node] : [];
      },
    });

    built.commands.get('editor.supertypes')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(toast).toHaveBeenCalledWith('У Dog нет надтипов');
      expect(shown).not.toHaveBeenCalled();
    });
  });

  it('надтипы показываются списком и открывают файл по клику', () => {
    const node = {
      name: 'Dog',
      kind: 5,
      uri: 'file:///p/a.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    };
    const parent = { ...node, name: 'Animal', uri: 'file:///p/base.ts' };
    const built = build({
      request: async (_method, params) => {
        const method = (params as { method?: string }).method;
        if (method === 'textDocument/prepareTypeHierarchy') return [node];
        // Надтипы — просто список узлов (в отличие от вызовов, где есть `from`).
        return [parent];
      },
    });

    built.commands.get('editor.supertypes')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(async () => {
      const items = shown.mock.calls[0]?.[0] as { label: string; onSelect?: () => Promise<void> }[];
      expect(items.map((entry) => entry.label)).toEqual(['Animal']);
      expect(toast).toHaveBeenCalledWith('Надтипы Dog: 1');

      await items[0]?.onSelect?.();
      expect(built.opened).toContain('/p/base.ts');
    });
  });

  it('перестройка карты символов различает идущую сборку и готовую', () => {
    // Текстов два: пока идёт warming, обещать «пересобрана» нельзя — человек пойдёт
    // искать символы, которых в карте ещё нет.
    const warming = build({ request: async () => ({ phase: 'warming', files: 120, decls: 0 }) });
    warming.commands.get('index.rebuild')?.();

    return new Promise((resolve) => setTimeout(resolve, 10))
      .then(() => {
        expect(toast).toHaveBeenCalledWith('Пересобираю карту символов: 120 файлов в ней');
        toast.mockClear();
        const ready = build({
          request: async () => ({ phase: 'ready', files: 120, decls: 900 }),
        });
        ready.commands.get('index.rebuild')?.();
        return new Promise((done) => setTimeout(done, 10));
      })
      .then(() => {
        expect(toast).toHaveBeenCalledWith('Карта символов пересобрана: 120 файлов, 900 объявлений');
      });
  });

  it('отказ перестройки не молчит', () => {
    const built = build({ request: async () => Promise.reject(new Error('индексатор занят')) });

    built.commands.get('index.rebuild')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(toast).toHaveBeenCalledWith('Не удалось пересобрать карту символов', 'error');
    });
  });

  it('перестройка обновляет карту в окне после успеха', () => {
    // Иначе виджеты показывали бы старую карту до перезапуска.
    const built = build({ request: async () => ({ phase: 'ready', files: 1, decls: 1 }) });

    built.commands.get('index.rebuild')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(built.counters.refreshed).toBeGreaterThan(0);
    });
  });

  it('моникер без файла не запрашивается у сервера', () => {
    const built = build({ currentPath: null });

    built.commands.get('editor.moniker')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(built.monikers).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith('Откройте файл', 'error');
    });
  });

  it('моникера нет — сказано, что сервер этого не умеет', () => {
    const built = build();
    built.monikers.mockResolvedValue([]);

    built.commands.get('editor.moniker')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('Моникер не найден'));
      expect(shown).not.toHaveBeenCalled();
    });
  });

  it('моникеры показываются, а первый сразу копируется в буфер', () => {
    // Буфера обмена в заглушке DOM нет: без этой подмены копирование молча падало бы
    // в `catch`, и тест не увидел бы ни тоста, ни ошибки.
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async () => undefined } },
    });
    // Чаще всего нужен именно один — заставлять выбирать его руками незачем.
    const built = build();
    built.monikers.mockResolvedValue([
      { identifier: 'clangd://index/main/func@run', scheme: 'clangd', unique: true },
      { identifier: 'ts://a.ts/run', scheme: 'ts', unique: false },
    ]);

    built.commands.get('editor.moniker')?.();
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      const items = shown.mock.calls[0]?.[0] as { label: string; hint: string }[];
      expect(items.map((item) => item.label)).toEqual(['clangd://index/main/func@run', 'ts://a.ts/run']);
      expect(items[0]?.hint).toBe('clangd · уникальный');
      expect(items[1]?.hint).toBe('ts');
      expect(toast).toHaveBeenCalledWith('Моникер скопирован');
    });
  });

  it('список экспортов: каждый вид подписан по-русски', async () => {
    // exportKindLabel — мелкие ветки, до которых отказы не доходят;
    // неизвестный вид не должен давать undefined в подписи.
    const built = build({
      request: async () => ({
        total: 4,
        files: [
          {
            path: '/p/a.ts',
            entries: [
              { line: 1, kind: 'default' },
              { line: 2, kind: 'star' },
              { line: 3, kind: 'named' },
              { line: 4, kind: 'что-то' },
            ],
          },
        ],
      }),
    });

    built.commands.get('search.findExports')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Неизвестный вид не должен давать undefined: иначе в списке пустая подпись.
    const items = shown.mock.calls[0]?.[0] as { hint: string }[];
    expect(items.map((item) => item.hint)).toEqual(['по умолчанию', 'звёздочкой', 'списком', 'объявлением']);
  });
});
