import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerFileMutationCommands, type FileMutationDeps } from '../src/renderer/core/file-mutation-commands';

type Run = (...args: unknown[]) => unknown;

function setup(opts: { confirmDelete?: boolean; confirmed?: boolean; active?: string | null } = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: { text: string; kind?: string; action?: () => unknown }[] = [];
  const deps = {
    rpc: {
      request: async (method: string, params: Record<string, unknown> = {}) => {
        log.push(`${method}:${params.path ?? params.from ?? ''}`);
        if (method === 'dialog.confirm') return { confirmed: opts.confirmed ?? true };
        if (method === 'workspace.copy') return { path: params.to };
        return {};
      },
    },
    openEditors: {
      active: opts.active ? { path: opts.active } : null,
      has: (path: string) => opts.active === path,
      close: (path: string) => log.push(`close:${path}`),
    },
    explorer: { scheduleRefresh: () => log.push('refresh') },
    settings: { explorer: { confirmDelete: opts.confirmDelete ?? true } },
    workspace: { relative: (path: string) => path.replace('/p/', '') },
    showToast: (text: string, kind?: string, options?: { action?: { run(): unknown } }) =>
      toasts.push({ text, kind, action: options?.action?.run }),
    openPath: async (path: string) => log.push(`open:${path}`),
  } as unknown as FileMutationDeps;
  registerFileMutationCommands(define, deps);
  return { commands, log, toasts };
}

const run = (f: ReturnType<typeof setup>, id: string, ...args: unknown[]) => f.commands.get(id)!(...args);

describe('registerFileMutationCommands', () => {
  it('регистрирует удаление, перенос и копирование — четыре команды', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'file.copyInto',
      'file.delete',
      'file.deleteMany',
      'file.moveInto',
    ]);
  });

  it('без настройки подтверждения удаляет сразу — но всё равно в корзину', async () => {
    const f = setup({ confirmDelete: false, active: '/p/a.ts' });
    await run(f, 'file.delete', '/p/a.ts');
    expect(f.log.some((l) => l.startsWith('dialog.confirm'))).toBe(false);
    expect(f.log).toContain('workspace.trash:/p/a.ts');
    expect(f.log).toContain('close:/p/a.ts');
    expect(f.log).toContain('refresh');
  });

  it('отказ в диалоге не трогает ни диск, ни вкладку', async () => {
    const f = setup({ confirmed: false, active: '/p/a.ts' });
    await run(f, 'file.delete', '/p/a.ts');
    expect(f.log).toEqual(['dialog.confirm:']);
    expect(f.toasts).toHaveLength(0);
  });

  it('пачка спрашивает один раз, а не по разу на файл', async () => {
    const f = setup();
    await run(f, 'file.deleteMany', ['/p/a.ts', '/p/b.ts', '/p/c.ts']);
    expect(f.log.filter((l) => l.startsWith('dialog.confirm'))).toHaveLength(1);
    expect(f.log.filter((l) => l.startsWith('workspace.trash'))).toHaveLength(3);
  });

  it('не-строки в пачке отбрасываются, пустой список ничего не делает', async () => {
    const f = setup();
    await run(f, 'file.deleteMany', [42, null]);
    expect(f.log).toEqual([]);
  });

  it('перенос переоткрывает активную вкладку по новому пути и умеет откатиться', async () => {
    const f = setup({ active: '/p/a.ts' });
    await run(f, 'file.moveInto', ['/p/a.ts'], '/p/sub');
    expect(f.log).toContain('workspace.rename:/p/a.ts');
    expect(f.log).toContain('open:/p/sub/a.ts');
    const cancel = f.toasts.at(-1)!.action!;
    f.log.length = 0;
    await cancel();
    expect(f.log).toContain('workspace.rename:/p/sub/a.ts');
    expect(f.log).toContain('open:/p/a.ts');
  });

  it('отмена копии отправляет в корзину копию, а не исходный файл', async () => {
    const f = setup();
    await run(f, 'file.copyInto', ['/p/a.ts'], '/p/sub');
    expect(f.log).toContain('workspace.copy:/p/a.ts');
    f.log.length = 0;
    await f.toasts.at(-1)!.action!();
    expect(f.log).toContain('workspace.trash:/p/sub/a.ts');
    expect(f.log).not.toContain('workspace.trash:/p/a.ts');
  });
});
