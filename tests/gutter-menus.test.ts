import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGutterMenus, type GutterMenusDeps } from '../src/renderer/core/gutter-menus';
import type { PopupMenuItem } from '../src/renderer/ui/popup-menu';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Меню жёлоба: точка останова и блок изменений (`core/gutter-menus.ts`).
 *
 * Модуль собирает пункты меню и решает, когда спрашивать подтверждение. Проверяем
 * именно это: состав пунктов по состоянию (какие стороны правки, отмечена ли
 * точка), порядок «сначала сохранить», и что откат без согласия не выполняется —
 * откат теряет правки безвозвратно.
 *
 * Попап-меню и тосты подменены: тест смотрит на собранные пункты и зовёт их
 * обработчики.
 */

type Item = PopupMenuItem & { separator?: boolean };

let shown: Item[][] = [];
vi.mock('../src/renderer/ui/popup-menu', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/renderer/ui/popup-menu')>();
  return {
    ...original,
    showPopupMenu: (items: readonly Item[]) => {
      shown.push([...items]);
    },
  };
});

const toasts: string[] = [];
vi.mock('../src/renderer/ui/toast', () => ({
  showToast: (text: string) => {
    toasts.push(text);
  },
}));

function setup(overrides: Partial<GutterMenusDeps> = {}) {
  const deps = {
    git: {
      fileHunks: vi.fn(async () => ({ unstaged: [], staged: [] })),
      stageHunk: vi.fn(async () => ({})),
      unstageHunk: vi.fn(async () => ({})),
      discardHunk: vi.fn(async () => ({})),
    },
    debug: {
      breakpointsOf: vi.fn(() => []),
      setBreakpointOptions: vi.fn(async () => []),
      toggleBreakpoint: vi.fn(async () => []),
      removeBreakpoint: vi.fn(async () => []),
    },
    workspace: { relative: (path: string) => path },
    explorer: { scheduleRefresh: vi.fn() },
    editors: { setBreakpoints: vi.fn() },
    documents: { get: vi.fn(() => null) },
    changeGutter: { refreshContent: vi.fn() },
    conditionInput: { open: vi.fn() },
    saveDocument: vi.fn(async () => true),
    reloadIfOpen: vi.fn(async () => {}),
    confirm: vi.fn(async () => ({ confirmed: true })),
    ...overrides,
  } as unknown as GutterMenusDeps;
  return { menus: createGutterMenus(deps), deps };
}

const item = (items: Item[] | undefined, label: string) =>
  items?.find((entry) => 'label' in entry && entry.label === label);

/** Блок правки в форме, которую ждёт `hunkAtLine`: строки 2–4 новой версии. */
function hunk() {
  return { oldStart: 2, oldCount: 3, newStart: 2, newCount: 3 };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('меню блока изменений', () => {
  beforeEach(() => {
    installMiniDom();
    shown = [];
    toasts.length = 0;
  });

  it('правок в строке нет — так и говорит, меню не открывает', async () => {
    const { menus } = setup();

    await menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });

    expect(shown).toHaveLength(0);
    expect(toasts).toEqual(['Правок в этой строке нет']);
  });

  it('несохранённый файл сначала сохраняется', async () => {
    // Откат блока на несохранённом файле потерял бы то, чего ещё нет на диске.
    const { menus, deps } = setup({
      documents: { get: () => ({ path: '/p/a.ts', dirty: true }) } as never,
    });

    await menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });

    expect(deps.saveDocument).toHaveBeenCalled();
  });

  it('отказ сохранить отменяет действие: меню не открывается', async () => {
    const { menus } = setup({
      documents: { get: () => ({ path: '/p/a.ts', dirty: true }) } as never,
      saveDocument: vi.fn(async () => false),
    });

    await menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });

    expect(shown).toHaveLength(0);
  });

  it('незакоммиченная правка предлагает индексацию', async () => {
    const { menus } = setup({
      git: { fileHunks: async () => ({ unstaged: [hunk()], staged: [] }) } as never,
    });

    await menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });

    const labels = (shown[0] ?? []).flatMap((entry) => ('label' in entry ? [entry.label] : []));
    expect(labels).toContain('Проиндексировать это изменение');
    const discard = item(shown[0], 'Откатить это изменение') as { danger?: boolean } | undefined;
    expect(discard?.danger).toBe(true);
  });

  it('изменение в индексе предлагает убрать его оттуда', async () => {
    const { menus } = setup({
      git: { fileHunks: async () => ({ unstaged: [], staged: [hunk()] }) } as never,
    });

    await menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });

    expect((shown[0] ?? []).flatMap((entry) => ('label' in entry ? [entry.label] : []))).toEqual([
      'Убрать это изменение из индекса',
    ]);
  });
});

describe('действия с блоком изменений', () => {
  beforeEach(() => {
    installMiniDom();
    shown = [];
    toasts.length = 0;
  });

  async function open(overrides: Partial<GutterMenusDeps> = {}) {
    // `git` собираем по частям: переопределяем только нужный метод, остальные
    // остаются заглушками — иначе снос всего объекта роняет чтение блоков.
    const built = setup({
      ...overrides,
      git: {
        fileHunks: async () => ({ unstaged: [hunk()], staged: [] }),
        stageHunk: async () => ({}),
        unstageHunk: async () => ({}),
        discardHunk: async () => ({}),
        ...(overrides.git as object),
      } as never,
    });
    await built.menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });
    return built;
  }

  it('индексация зовёт git с номером блока и обновляет полоски', async () => {
    const stageHunk = vi.fn(async () => ({}));
    const refreshContent = vi.fn();
    await open({
      git: { stageHunk } as never,
      changeGutter: { refreshContent, enabled: true, toggle: vi.fn(), refresh: vi.fn() } as never,
    });

    (item(shown[0], 'Проиндексировать это изменение') as { onSelect?: () => void } | undefined)?.onSelect?.();
    await settled();

    expect(stageHunk).toHaveBeenCalledWith('/p/a.ts', 0);
    expect(refreshContent).toHaveBeenCalled();
  });

  it('откат без согласия ничего не делает', async () => {
    const discardHunk = vi.fn(async () => ({}));
    await open({
      git: { discardHunk } as never,
      confirm: vi.fn(async () => ({ confirmed: false })),
    });

    (item(shown[0], 'Откатить это изменение') as { onSelect?: () => void } | undefined)?.onSelect?.();
    // Подтверждение — асинхронное: обработчик сам зовёт `void (async () => …)()`.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(discardHunk).not.toHaveBeenCalled();
  });

  it('согласие откатывает блок и перечитывает файл с диска', async () => {
    const discardHunk = vi.fn(async () => ({}));
    const reloadIfOpen = vi.fn(async () => {});
    await open({ git: { discardHunk } as never, reloadIfOpen });

    (item(shown[0], 'Откатить это изменение') as { onSelect?: () => void } | undefined)?.onSelect?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(discardHunk).toHaveBeenCalledWith('/p/a.ts', 0);
    // Файл изменился на диске — открытый редактор обязан это увидеть.
    expect(reloadIfOpen).toHaveBeenCalledWith('/p/a.ts');
  });

  it('ошибка чтения правок не ломает меню: сказано «правок нет»', async () => {
    const { menus } = setup({
      git: { fileHunks: async () => Promise.reject(new Error('нет git')) } as never,
    });

    await menus.openChangeStripMenu({ path: '/p/a.ts', line: 3 });

    expect(toasts).toEqual(['Правок в этой строке нет']);
  });
});
