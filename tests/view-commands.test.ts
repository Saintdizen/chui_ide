import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import type { SidebarPosition } from '../src/shared/api/settings';
import { registerViewCommands, type ViewCommandDeps, type ZenSnapshot } from '../src/renderer/core/view-commands';

type Run = (...args: unknown[]) => unknown;

function setup(opts: { active?: { path: string } | null } = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  let uiScale = 1;
  let editorFont = 14;
  let zen: ZenSnapshot | null = null;
  /** Классы, реально висящие на корне: `contains` обязан отвечать правдой. */
  const zenClass = new Set<string>();
  const visible = { sidebar: true, right: true, dock: true, editor: true, minimap: true };
  let sidebarPosition: SidebarPosition = 'left';
  const deps = {
    layout: {
      root: {
        classList: {
          add: (c: string) => zenClass.add(c),
          remove: (c: string) => zenClass.delete(c),
          toggle: (c: string, on: boolean) => {
            if (on) zenClass.add(c);
            else zenClass.delete(c);
          },
          contains: (c: string) => zenClass.has(c),
        },
      },
      get sidebarVisible() {
        return visible.sidebar;
      },
      get rightVisible() {
        return visible.right;
      },
      get dockVisible() {
        return visible.dock;
      },
      get editorVisible() {
        return visible.editor;
      },
      setSidebarVisible: (on: boolean) => {
        visible.sidebar = on;
        log.push(`sidebar:${on}`);
      },
      setRightVisible: (on: boolean) => {
        visible.right = on;
        log.push(`right:${on}`);
      },
      setDockVisible: (on: boolean) => {
        visible.dock = on;
        log.push(`dock:${on}`);
      },
      setEditorVisible: (on: boolean) => {
        visible.editor = on;
        log.push(`editor:${on}`);
      },
      get sidebarPosition() {
        return sidebarPosition;
      },
      setSidebarPosition: (position: SidebarPosition) => {
        sidebarPosition = position;
        log.push(`position:${position}`);
      },
    },
    dock: {
      visible: true,
      activeId: 'problems',
      height: 0,
      setHeight: (height: number) => log.push(`height:${height}`),
      show: (id: string) => log.push(`show:${id}`),
      hide: () => log.push('hide'),
      toggle: (id: string) => log.push(`toggle:${id}`),
    },
    syncViewButtons: () => log.push('sync'),
    withoutPersist: (run: () => void) => {
      log.push('nopersist');
      run();
    },
    getZen: () => zen,
    setZen: (snapshot: ZenSnapshot | null) => {
      zen = snapshot;
    },
    editors: {
      isSplit: false,
      isGrid: false,
      splitEditor: () => log.push('split'),
      splitEditorGrid: () => log.push('grid'),
      closeSplit: () => log.push('closeSplit'),
      setZen: (on: boolean) => log.push(`zen:${on}`),
    },
    openEditors: { active: opts.active ?? null },
    statusBar: { gitAnchor: null },
    openGitManager: (anchor: unknown) => log.push(`git:${String(anchor)}`),
    isMarkdownPath: (path: string) => path.endsWith('.md'),
    toggleMarkdownPreview: (path: string) => log.push(`preview:${path}`),
    toggleMinimap: () => log.push(`minimap:${visible.minimap}`),
    regexTester: { open: () => log.push('regex') },
    showToast: (message: string, kind?: string) => toasts.push(`${kind ?? 'info'}:${message}`),
    uiScale: {
      get: () => uiScale,
      set: (value: number) => {
        uiScale = value;
        log.push(`scale:${value}`);
      },
    },
    editorFont: {
      get: () => editorFont,
      set: (value: number) => {
        editorFont = value;
        log.push(`font:${value}`);
      },
    },
  } as unknown as ViewCommandDeps;
  registerViewCommands(define, deps);
  return {
    commands,
    log,
    toasts,
    visible,
    zen: () => zen,
    scale: () => uiScale,
    font: () => editorFont,
  };
}

const run = (f: ReturnType<typeof setup>, id: string) => f.commands.get(id)!();

describe('registerViewCommands', () => {
  it('регистрирует все команды вида, включая масштаб', () => {
    const commands = setup().commands;
    // Не число: оно росло с каждой новой командой и требовало правки теста,
    // ничего не проверяя по сути. Проверяем, что семейство на месте.
    for (const id of ['view.zen', 'view.toggleSidebar', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset']) {
      expect(commands.has(id), id).toBe(true);
    }
  });

  it('масштаб меняется шагом и говорит об этом', () => {
    // Раньше масштаб жил только списком в настройках: «буквы мелкие» →
    // ищи окно настроек. Молчаливая смена ещё хуже — непонятно, сработало ли.
    const f = setup();
    run(f, 'view.zoomIn');
    expect(f.scale()).toBeGreaterThan(1);
    expect(f.toasts.at(-1)).toContain('Масштаб интерфейса');
  });

  it('Ctrl+= и Ctrl+- меняют кегль ТЕКСТА, а не масштаб окна', () => {
    // Раньше шаг был только у `Ctrl+колеса` над редактором. Кегль и масштаб окна —
    // разные вещи, и путать их нельзя: команда вида не должна трогать оболочку.
    const f = setup();
    run(f, 'editor.fontZoomIn');
    expect(f.font()).toBe(15);
    expect(f.scale()).toBe(1);
    run(f, 'editor.fontZoomOut');
    run(f, 'editor.fontZoomOut');
    expect(f.font()).toBe(13);
    expect(f.scale()).toBe(1);
  });

  it('у границы кегля тост говорит цифру, а настройка не меняется', () => {
    const f = setup();
    for (let i = 0; i < 100; i += 1) run(f, 'editor.fontZoomIn');
    expect(f.font()).toBe(72);
    expect(f.toasts.at(-1)).toContain('72 px');
  });

  it('сброс масштаба — ровно 100 %', () => {
    const f = setup();
    run(f, 'view.zoomIn');
    run(f, 'view.zoomIn');
    run(f, 'view.zoomReset');
    expect(f.scale()).toBe(1);
  });

  it('панель редактора — такой же тумблер, как боковая и нижняя', () => {
    const f = setup();
    run(f, 'view.toggleEditor');
    expect(f.log).toEqual(['editor:false', 'sync']);
    run(f, 'view.toggleEditor');
    expect(f.log).toEqual(['editor:false', 'sync', 'editor:true', 'sync']);
  });

  it('переезд боковой панели — тумблер из «слева» в «справа» и обратно', () => {
    // Сторона панели — часть макета (см. `persistLayout`): команда обязана поменять
    // саму позицию и сказать об этом, иначе человек не поймёт, где теперь смотреть.
    const f = setup();
    run(f, 'view.sidebarPosition');
    expect(f.log).toEqual(['position:right', 'sync']);
    expect(f.toasts.at(-1)).toContain('справа');
    run(f, 'view.sidebarPosition');
    expect(f.log).toEqual(['position:right', 'sync', 'position:left', 'sync']);
    expect(f.toasts.at(-1)).toContain('слева');
  });

  it('панели просят перерисовать кнопки — иначе кнопка соврёт', () => {
    const f = setup();
    run(f, 'view.showExplorer');
    expect(f.log).toEqual(['sidebar:true', 'sync']);
    run(f, 'view.toggleSidebar');
    expect(f.log).toEqual(['sidebar:true', 'sync', 'sidebar:false', 'sync']);
  });

  it('дзен прячет обвязку без сохранения макета и возвращает ровно прежнее', () => {
    const f = setup();
    run(f, 'view.zen');
    expect(f.log).toEqual(['height:0', 'nopersist', 'sidebar:false', 'right:false', 'dock:false', 'zen:true', 'sync']);
    expect(f.zen()).toEqual({ sidebar: true, right: true, dock: true });

    run(f, 'view.zen');
    expect(f.log.slice(7)).toEqual(['nopersist', 'sidebar:true', 'right:true', 'dock:true', 'zen:false', 'sync']);
    expect(f.zen()).toBeNull();
  });

  it('дзен возвращает то, что было видно перед входом, а не «всё включено»', () => {
    const f = setup();
    f.visible.right = false;
    run(f, 'view.zen');
    run(f, 'view.zen');
    expect(f.log).toContain('right:false');
    expect(f.log).not.toContain('right:true');
  });

  it('дзен отдаёт место дока самому доку: спрятанный док своё место теряет', () => {
    const f = setup();
    // Высоту помнит сам док: спрятанный док своё место теряет, и открытый на выходе
    // вернулся бы к высоте по умолчанию. Поэтому её запоминают при входе, а не при выходе.
    run(f, 'view.zen');
    expect(f.log.filter((line) => line.startsWith('height:'))).toEqual(['height:0']);
    run(f, 'view.zen');
    // Выход высоту не трогает: док вернётся на своё место сам.
    expect(f.log.filter((line) => line.startsWith('height:'))).toEqual(['height:0']);
  });

  it('миникарта в дзене не показывается: команда отказывает и не трогает редактор', () => {
    const f = setup();
    run(f, 'view.zen');
    run(f, 'view.toggleMinimap');
    expect(f.log).not.toContain('minimap:true');
    expect(f.toasts).toEqual(['error:Миникарта в режиме дзен не показывается']);
  });

  it('вне дзена миникарта переключается', () => {
    // TASKS 51: раньше здесь стояло «без записи настроек» — `Alt+M` менял живой вид
    // в обход `editor.minimap`. От этого окно настроек показывало не то, что на
    // экране, а следующая правка настроек возвращала мини-карту назад. Теперь
    // команда идёт тем же путём, что тумблер, поэтому `minimap` в логе нет —
    // есть запись настройки в app.ts, а команда только зовёт `deps.toggleMinimap`.
    const f = setup();
    run(f, 'view.toggleMinimap');
    expect(f.log).toEqual(['minimap:true']);
    expect(f.toasts).toEqual([]);
  });

  it('миникарта — одна настройка, а не тайный флаг вида (TASKS 51)', () => {
    // Контракт: команда НЕ меняет вид напрямую и НЕ зовёт `editors.applyOptions`.
    // Она обязана идти через `settings.editor.minimap`, иначе окно настроек врёт о
    // том, что на экране, а следующая правка настроек возвращает мини-карту назад.
    // Здесь проверяем, что через команду редактор трогают ровно один раз и только
    // через `deps.toggleMinimap` — путь настройки живёт в app.ts.
    const f = setup();
    run(f, 'view.toggleMinimap');
    expect(f.log.filter((line) => line.startsWith('minimap:'))).toHaveLength(1);
    expect(f.log.filter((line) => line === 'nopersist')).toHaveLength(0);
  });

  it('тумблер нижней панели помнит вкладку и скрывает видимую', () => {
    const f = setup();
    run(f, 'view.toggleDock');
    expect(f.log).toEqual(['hide']);
    f.commands.get('view.showOutline')!();
    expect(f.log).toEqual(['hide', 'toggle:outline']);
  });

  it('предпросмотр Markdown без .md — отказ, с .md — открытие', () => {
    const plain = setup({ active: { path: '/p/a.ts' } });
    run(plain, 'view.showMarkdownPreview');
    expect(plain.toasts).toEqual(['error:Предпросмотр Markdown: откройте файл .md']);
    expect(plain.log).toEqual([]);

    const md = setup({ active: { path: '/p/readme.md' } });
    run(md, 'view.showMarkdownPreview');
    expect(md.log).toEqual(['preview:/p/readme.md']);
  });

  it('разделение редактора переключает по состоянию, а не по счётчику', () => {
    const f = setup();
    run(f, 'view.splitEditor');
    expect(f.log).toEqual(['split', 'sync']);
    run(f, 'view.splitEditorGrid');
    expect(f.log).toEqual(['split', 'sync', 'grid', 'sync']);
  });
});
