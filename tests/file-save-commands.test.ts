import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerFileSaveCommands, type FileSaveDeps } from '../src/renderer/core/file-save-commands';

type Run = (...args: unknown[]) => unknown;
const doc = (path: string) => ({ path }) as never;

function setup(opts: { active?: string | null; dirty?: string[] } = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  const dirty = (opts.dirty ?? []).map(doc);
  const deps = {
    openEditors: { active: opts.active ? doc(opts.active) : null },
    documents: {
      get: (path: string) =>
        (opts.dirty ?? []).concat(opts.active ? [opts.active] : []).includes(path) ? doc(path) : undefined,
      dirty: () => dirty,
    },
    saveDocument: async (document: { path: string }) => {
      log.push(`save:${document.path}`);
      return true;
    },
    saveDocumentAs: async (document: { path: string }) => {
      log.push(`saveAs:${document.path}`);
      return true;
    },
    revertFilesToDisk: async (targets: readonly string[]) => {
      log.push(`revert:${targets.join('|')}`);
    },
    showToast: (message: string) => toasts.push(message),
  } as unknown as FileSaveDeps;
  registerFileSaveCommands(define, deps);
  return { commands, log, toasts };
}

const run = (f: ReturnType<typeof setup>, id: string, ...args: unknown[]) => f.commands.get(id)!(...args);

describe('registerFileSaveCommands', () => {
  it('регистрирует пять команд сохранения и перечитывания', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'file.revertAllFromDisk',
      'file.revertFromDisk',
      'file.save',
      'file.saveAll',
      'file.saveAs',
    ]);
  });

  it('«Сохранить» без открытого файла говорит об этом, а не молчит', async () => {
    const f = setup();
    await run(f, 'file.save');
    expect(f.log).toEqual([]);
    expect(f.toasts).toEqual(['Нет открытого файла']);
  });

  it('«Сохранить как» с путём из меню вкладки сохраняет ЭТОТ файл, а не активный', async () => {
    const f = setup({ active: '/p/a.ts', dirty: ['/p/b.ts'] });
    await run(f, 'file.saveAs', '/p/b.ts');
    expect(f.log).toEqual(['saveAs:/p/b.ts']);
  });

  it('«Сохранить как» без аргумента берёт активный файл', async () => {
    const f = setup({ active: '/p/a.ts' });
    await run(f, 'file.saveAs');
    expect(f.log).toEqual(['saveAs:/p/a.ts']);
  });

  it('«Сохранить всё» идёт по грязным буферам', async () => {
    const f = setup({ dirty: ['/p/a.ts', '/p/b.ts'] });
    await run(f, 'file.saveAll');
    expect(f.log).toEqual(['save:/p/a.ts', 'save:/p/b.ts']);
  });

  it('перечитывание: путь в аргументе важнее активного, а «все» берёт грязные', async () => {
    const f = setup({ active: '/p/a.ts', dirty: ['/p/b.ts', '/p/c.ts'] });
    await run(f, 'file.revertFromDisk', '/p/c.ts');
    await run(f, 'file.revertFromDisk');
    await run(f, 'file.revertAllFromDisk');
    expect(f.log).toEqual(['revert:/p/c.ts', 'revert:/p/a.ts', 'revert:/p/b.ts|/p/c.ts']);
  });
});
