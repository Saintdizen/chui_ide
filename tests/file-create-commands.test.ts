import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerFileCreateCommands, type FileCreateDeps } from '../src/renderer/core/file-create-commands';

type Run = (...args: unknown[]) => unknown;

function setup(opts: { active?: string | null; updateImports?: boolean } = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: { text: string; action?: () => unknown }[] = [];
  const deps = {
    rpc: {
      request: async (method: string, params: Record<string, unknown> = {}) => {
        log.push(
          `${method}:${params.path ?? params.from ?? params.oldPath ?? ''}->${params.to ?? params.newPath ?? ''}`,
        );
        if (method === 'workspace.updateImports') return { files: ['/p/x.ts'] };
        if (method === 'workspace.createFile' || method === 'workspace.createDir') return { path: params.path };
        if (method === 'workspace.rename') return { path: params.to };
        return {};
      },
    },
    commands: { execute: async (id: string, ...args: unknown[]) => log.push(`cmd:${id}:${String(args[0])}`) },
    openEditors: {
      active: opts.active ? { path: opts.active } : null,
      has: (path: string) => opts.active === path,
      close: (path: string) => log.push(`close:${path}`),
    },
    explorer: {
      scheduleRefresh: () => log.push('refresh'),
      startCreate: (kind: string) => log.push(`startCreate:${kind}`),
    },
    settings: { explorer: { updateImportsOnRename: opts.updateImports ?? true } },
    showToast: (text: string, _kind?: string, options?: { action?: { run(): unknown } }) =>
      toasts.push({ text, action: options?.action?.run }),
    openPath: async (path: string) => log.push(`open:${path}`),
  } as unknown as FileCreateDeps;
  registerFileCreateCommands(define, deps);
  return { commands, log, toasts };
}

const run = (f: ReturnType<typeof setup>, id: string, ...args: unknown[]) => f.commands.get(id)!(...args);

describe('registerFileCreateCommands', () => {
  it('регистрирует создание и переименование — пять команд', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'file.createFile',
      'file.createFolder',
      'file.newFile',
      'file.newFolder',
      'file.rename',
    ]);
  });

  it('создание файла открывает его и предлагает отменить', async () => {
    const f = setup();
    expect(await run(f, 'file.createFile', '/p/new.ts')).toBe('/p/new.ts');
    expect(f.log).toContain('open:/p/new.ts');
    expect(f.toasts[0]!.text).toBe('Создан файл new.ts');
    f.log.length = 0;
    await f.toasts[0]!.action!();
    expect(f.log).toContain('cmd:file.close:/p/new.ts');
  });

  it('создание папки не закрывает вкладок — их нет', async () => {
    const f = setup();
    await run(f, 'file.createFolder', '/p/sub');
    f.log.length = 0;
    await f.toasts[0]!.action!();
    expect(f.log).toEqual(['workspace.trash:/p/sub->', 'refresh']);
  });

  it('новый файл и папка начинают ввод имени в дереве, а не пишут на диск', async () => {
    const f = setup();
    run(f, 'file.newFile');
    run(f, 'file.newFolder');
    expect(f.log).toEqual(['startCreate:file', 'startCreate:directory']);
  });

  it('переименование: закрыть вкладку, диск, ссылки, вернуть активность', async () => {
    const f = setup({ active: '/p/a.ts' });
    expect(await run(f, 'file.rename', '/p/a.ts', '/p/b.ts')).toBe('/p/b.ts');
    expect(f.log).toContain('close:/p/a.ts');
    expect(f.log).toContain('workspace.rename:/p/a.ts->/p/b.ts');
    expect(f.log).toContain('workspace.updateImports:/p/a.ts->/p/b.ts');
    expect(f.log).toContain('open:/p/b.ts');
    expect(f.toasts[0]!.text).toContain('b.ts');
  });

  it('отмена переименования идёт обратными шагами и возвращает прежний путь', async () => {
    const f = setup({ active: '/p/a.ts' });
    await run(f, 'file.rename', '/p/a.ts', '/p/b.ts');
    f.log.length = 0;
    await f.toasts[0]!.action!();
    expect(f.log).toContain('workspace.rename:/p/b.ts->/p/a.ts');
    expect(f.log).toContain('open:/p/a.ts');
  });

  it('без настройки правки ссылок переименование не трогает импорты', async () => {
    const f = setup({ updateImports: false });
    await run(f, 'file.rename', '/p/a.ts', '/p/b.ts');
    expect(f.log.some((l) => l.startsWith('workspace.updateImports'))).toBe(false);
  });
});
