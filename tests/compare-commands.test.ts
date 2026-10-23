import { describe, expect, it } from 'vitest';
import { registerCompareCommands, type CompareDeps } from '../src/renderer/core/compare-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Команды сравнения держат одну границу: папки показывает список различий, файлы —
 * построчный экран. Ещё они обязаны молчать на кривых аргументах, а не открывать
 * сравнение файла с самим собой.
 */
function setup(options: { picked?: string | null } = {}) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const opened: { kind: 'diff' | 'folder'; left: string; right: string }[] = [];
  const picked: string[] = [];
  const deps = {
    diffView: {
      openFiles: async (left: string, right: string) => {
        opened.push({ kind: 'diff', left, right });
      },
    },
    folderCompare: {
      open: async (left: string, right: string) => {
        opened.push({ kind: 'folder', left, right });
      },
    },
    quickOpen: {
      pick: async (title: string) => {
        picked.push(title);
        return options.picked ?? null;
      },
    },
  } as unknown as CompareDeps;
  registerCompareCommands(define, deps);
  return { commands, opened, picked };
}

describe('registerCompareCommands', () => {
  it('регистрирует четыре команды сравнения', () => {
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual([
      'diff.compareFiles',
      'file.compareSelection',
      'file.compareWith',
      'folder.compare',
    ]);
  });

  it('две папки открывает списком различий, а не построчным экраном', async () => {
    const { commands, opened } = setup();
    await commands.get('folder.compare')!('/a', '/b');
    expect(opened).toEqual([{ kind: 'folder', left: '/a', right: '/b' }]);
  });

  it('два файла открывает экраном различий', async () => {
    const { commands, opened } = setup();
    await commands.get('diff.compareFiles')!('/a.ts', '/b.ts');
    expect(opened).toEqual([{ kind: 'diff', left: '/a.ts', right: '/b.ts' }]);
  });

  it('«Сравнить с…» спрашивает второй файл и открывает пару', async () => {
    const { commands, opened, picked } = setup({ picked: '/b.ts' });
    await commands.get('file.compareWith')!('/a.ts');
    expect(picked).toEqual(['С чем сравнить?']);
    expect(opened).toEqual([{ kind: 'diff', left: '/a.ts', right: '/b.ts' }]);
  });

  it('отмена выбора вторым файлом ничего не открывает', async () => {
    const { commands, opened } = setup({ picked: null });
    await commands.get('file.compareWith')!('/a.ts');
    expect(opened).toEqual([]);
  });

  it('выбор того же файла — сравнения не будет', async () => {
    const { commands, opened } = setup({ picked: '/a.ts' });
    await commands.get('file.compareWith')!('/a.ts');
    expect(opened).toEqual([]);
  });

  it('выделенные файлы сравниваются, только когда их ровно два разных', async () => {
    const { commands, opened } = setup();
    await commands.get('file.compareSelection')!(['/a.ts', '/a.ts']);
    await commands.get('file.compareSelection')!(['/a.ts']);
    expect(opened).toEqual([]);
    await commands.get('file.compareSelection')!(['/a.ts', '/b.ts']);
    expect(opened).toEqual([{ kind: 'diff', left: '/a.ts', right: '/b.ts' }]);
  });

  it('кривые аргументы не роняют команды', async () => {
    const { commands, opened } = setup();
    await commands.get('folder.compare')!(undefined, null);
    await commands.get('diff.compareFiles')!('только один', undefined);
    await commands.get('file.compareSelection')!('не массив');
    expect(opened).toEqual([]);
  });
});
