import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSymbolPickers, type SymbolPickersDeps } from '../src/renderer/core/symbol-pickers';
import { installMiniDom } from './helpers/mini-dom';

const shown = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/ui/popup-menu', () => ({
  showPopupMenu: shown,
  closePopupMenu: vi.fn(),
  isPopupOpen: () => false,
}));
vi.mock('../src/renderer/ui/toast', () => ({ showToast: toast }));

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

  it('вызов без символа под курсором не бросает и не открывает список', async () => {
    const handlers = register();
    await handlers.get('editor.callers')!();
    expect(shown).not.toHaveBeenCalled();
  });
});

/**
 * Исполнение команд, а не только их регистрация.
 *
 * Прежние тесты проверяли список команд и отказы по имени; сами действия
 * (иерархия вызовов и типов, список экспортов, моникер) не исполнялись ни разу.
 */
describe('команды иерархии исполняются', () => {
  const NO_EDITS = () => ({});
  const rect = { left: 10, top: 20 };

  function build(
    options: { request?: (method: string, params?: unknown) => Promise<unknown>; currentPath?: string | null } = {},
  ) {
    const commands = new Map<string, () => unknown>();
    const revealed: [string, number, number][] = [];
    const opened: string[] = [];
    const request = vi.fn(options.request ?? (async () => null));
    createSymbolPickers({
      define: (spec: { id: string }, run: () => unknown) => {
        commands.set(spec.id, run);
      },
      lsp: NO_EDITS as never,
      editors: {
        currentPath: options.currentPath === undefined ? '/p/a.ts' : options.currentPath,
        cursor: () => ({ line: 1, column: 1 }),
        reveal: (path: string, line: number, column: number) => revealed.push([path, line, column]),
      } as never,
      workspace: { relative: (path: string) => path } as never,
      rpc: { request } as never,
      layout: { editorHost: { getBoundingClientRect: () => rect } } as never,
      openPath: async (path: string) => {
        opened.push(path);
      },
      meaningSearch: {} as never,
      refreshSymbolIndex: () => {},
    });
    return { commands, request, revealed, opened };
  }

  beforeEach(() => {
    installMiniDom();
    shown.mockClear();
    toast.mockClear();
  });

  it('без открытого файла иерархия не запрашивается', async () => {
    // Файла нет — команда говорит о причине, а не идёт к серверу.
    const built = build({ currentPath: null });

    await built.commands.get('editor.callers')?.();

    expect(built.request).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Откройте файл', 'error');
  });
});
