import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGutterMenus, type GutterMenusDeps } from '../src/renderer/core/gutter-menus';

const shown = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/ui/toast', () => ({ showToast: toast }));

vi.mock('../src/renderer/ui/popup-menu', () => ({
  showPopupMenu: shown,
  closePopupMenu: vi.fn(),
  isPopupOpen: () => false,
}));

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

function menus(over: Partial<GutterMenusDeps> = {}) {
  const deps = {
    git: stub({ fileHunks: async () => ({ unstaged: [], staged: [] }) }),
    debug: stub(),
    workspace: stub(),
    explorer: stub(),
    editors: stub(),
    documents: stub({ get: () => undefined }),
    changeGutter: stub(),
    conditionInput: stub(),
    saveDocument: async () => true,
    reloadIfOpen: () => undefined,
    confirm: async () => ({ confirmed: false }),
    ...over,
  } as unknown as GutterMenusDeps;
  return createGutterMenus(deps);
}

describe('gutter-menus', () => {
  beforeEach(() => shown.mockClear());

  it('отдаёт оба меню', () => {
    const api = menus();
    expect(typeof api.openBreakpointMenu).toBe('function');
    expect(typeof api.openChangeStripMenu).toBe('function');
  });

  it('меню точки останова показывает пункты по месту последнего нажатия', () => {
    const api = menus();
    api.openBreakpointMenu({ path: '/p/a.ts', line: 3 });
    expect(shown).toHaveBeenCalledTimes(1);
    const [items, x, y] = shown.mock.calls[0]!;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect([x, y]).toEqual([0, 0]);
  });

  it('меню блока изменений без блока у строки ничего не показывает', async () => {
    const api = menus();
    await api.openChangeStripMenu({ path: '/p/a.ts', line: 1 });
    expect(shown).not.toHaveBeenCalled();
  });

  it('повторное открытие меню не бросает', () => {
    const api = menus();
    api.openBreakpointMenu({ path: '/p/a.ts', line: 1 });
    api.openBreakpointMenu({ path: '/p/a.ts', line: 2 });
    expect(shown).toHaveBeenCalledTimes(2);
  });
});
