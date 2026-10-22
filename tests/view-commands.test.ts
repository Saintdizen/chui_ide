import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerViewCommands, type ViewCommandDeps, type ZenSnapshot } from '../src/renderer/core/view-commands';

type Run = (...args: unknown[]) => unknown;

function setup(opts: { active?: { path: string } | null } = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  let zen: ZenSnapshot | null = null;
  const visible = { sidebar: true, right: true, dock: true, editor: true };
  const deps = {
    layout: {
      root: { classList: { add: (c: string) => log.push(`class+${c}`), remove: (c: string) => log.push(`class-${c}`) } },
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
    },
    dock: {
      visible: true,
      activeId: 'problems',
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
    },
    openEditors: { active: opts.active ?? null },
    statusBar: { gitAnchor: null },
    openGitManager: (anchor: unknown) => log.push(`git:${String(anchor)}`),
    isMarkdownPath: (path: string) => path.endsWith('.md'),
    toggleMarkdownPreview: (path: string) => log.push(`preview:${path}`),
    regexTester: { open: () => log.push('regex') },
    showToast: (message: string, kind?: string) => toasts.push(`${kind ?? 'info'}:${message}`),
  } as unknown as ViewCommandDeps;
  registerViewCommands(define, deps);
  return { commands, log, toasts, visible, zen: () => zen };
}

const run = (f: ReturnType<typeof setup>, id: string) => f.commands.get(id)!();

describe('registerViewCommands', () => {
  it('регистрирует пятнадцать команд вида', () => {
    expect(setup().commands.size).toBe(15);
  });

  it('панель редактора — такой же тумблер, как боковая и нижняя', () => {
    const f = setup();
    run(f, 'view.toggleEditor');
    expect(f.log).toEqual(['editor:false', 'sync']);
    run(f, 'view.toggleEditor');
    expect(f.log).toEqual(['editor:false', 'sync', 'editor:true', 'sync']);
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
    expect(f.log).toEqual(['nopersist', 'sidebar:false', 'right:false', 'dock:false', 'class+is-zen', 'sync']);
    expect(f.zen()).toEqual({ sidebar: true, right: true, dock: true });

    run(f, 'view.zen');
    expect(f.log.slice(6)).toEqual(['nopersist', 'sidebar:true', 'right:true', 'dock:true', 'class-is-zen', 'sync']);
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
