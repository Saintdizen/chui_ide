import { describe, expect, it } from 'vitest';
import type { DefineCommand } from '../src/renderer/core/command-args';
import { registerEditorFixCommands, type EditorFixDeps } from '../src/renderer/core/editor-fix-commands';

type Run = (...args: unknown[]) => unknown;

function setup(path: string | null = '/p/a.ts') {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const log: string[] = [];
  const toasts: string[] = [];
  const deps = {
    currentPath: () => path,
    fixes: {
      runOrganizeImports: (target: string) => log.push(`organize:${target}`),
      runRefactorMenu: (target: string) => log.push(`menu:${target}`),
      runRefactor: (target: string, action: string) => log.push(`refactor:${action}:${target}`),
    },
    showToast: (message: string) => toasts.push(message),
  } as unknown as EditorFixDeps;
  registerEditorFixCommands(define, deps);
  return { commands, log, toasts };
}

const run = (f: ReturnType<typeof setup>, id: string) => f.commands.get(id)!();

describe('registerEditorFixCommands', () => {
  it('регистрирует четыре исправления', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'editor.extractSymbol',
      'editor.inlineSymbol',
      'editor.organizeImports',
      'editor.refactor',
    ]);
  });

  it('без открытого файла говорит об этом и сервис не трогает', () => {
    const f = setup(null);
    for (const id of f.commands.keys()) run(f, id);
    expect(f.log).toEqual([]);
    expect(f.toasts).toHaveLength(4);
    expect(f.toasts[0]).toBe('Нет открытого файла');
  });

  it('каждая команда зовёт свой вход сервиса с текущим путём', () => {
    const f = setup('/p/b.ts');
    run(f, 'editor.organizeImports');
    run(f, 'editor.refactor');
    run(f, 'editor.extractSymbol');
    run(f, 'editor.inlineSymbol');
    expect(f.log).toEqual([
      'organize:/p/b.ts',
      'menu:/p/b.ts',
      'refactor:extract:/p/b.ts',
      'refactor:inline:/p/b.ts',
    ]);
  });
});
