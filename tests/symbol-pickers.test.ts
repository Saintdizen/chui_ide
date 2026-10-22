import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSymbolPickers, type SymbolPickersDeps } from '../src/renderer/core/symbol-pickers';

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
