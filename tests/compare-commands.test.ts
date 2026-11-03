import { describe, expect, it } from 'vitest';
import { registerCompareCommands, type CompareDeps } from '../src/renderer/core/compare-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

/**
 * Команды сравнения держат одну границу: папки показывает список различий, файлы —
 * построчный экран. Ещё они обязаны молчать на кривых аргументах, а не открывать
 * сравнение файла с самим собой.
 */
function setup(
  options: { picked?: string | null; current?: string | null; draft?: string | null; saved?: string } = {},
) {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const opened: { kind: 'diff' | 'folder' | 'unsaved'; left?: string; right?: string }[] = [];
  const unsaved: { path: string; saved: string; edited: string }[] = [];
  const picked: string[] = [];
  const deps = {
    diffView: {
      openFiles: async (left: string, right: string) => {
        opened.push({ kind: 'diff', left, right });
      },
      openUnsaved: async (path: string, saved: string, edited: string) => {
        opened.push({ kind: 'unsaved', left: path });
        unsaved.push({ path, saved, edited });
      },
    },
    currentPath: () => options.current ?? null,
    textOf: () => (options.draft === undefined ? null : options.draft),
    readText: async () => options.saved ?? '',
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
  return { commands, opened, picked, unsaved };
}

describe('registerCompareCommands', () => {
  it('регистрирует пять команд сравнения', () => {
    // Пятая — `file.compareWithSaved` (F7): сверка несохранённого с диском.
    const { commands } = setup();
    expect([...commands.keys()].sort()).toEqual([
      'diff.compareFiles',
      'file.compareSelection',
      'file.compareWith',
      'file.compareWithSaved',
      'folder.compare',
    ]);
  });

  describe('сверить с сохранённым (F7)', () => {
    /**
     * Найдено разбором: сравнить можно было только два файла НА ДИСКЕ. Сверить
     * черновик с тем, что сохранено, было нечем — а это и есть рабочее
     * применение: посмотреть, что наменял, ДО записи.
     */
    it('берёт текущую вкладку, когда путь не назван', async () => {
      const { commands, unsaved } = setup({ current: '/a.ts', draft: 'новое', saved: 'старое' });
      await commands.get('file.compareWithSaved')!(undefined);
      expect(unsaved).toEqual([{ path: '/a.ts', saved: 'старое', edited: 'новое' }]);
    });

    it('слева сохранённое, справа черновик', async () => {
      // Стороны важно не перепутать: иначе «что убрал» и «что добавил» меняются
      // местами, и правка читается наоборот.
      const { commands, unsaved } = setup({ draft: 'НЕСОХРАНЁННОЕ', saved: 'НА ДИСКЕ' });
      await commands.get('file.compareWithSaved')!('/a.ts');
      expect(unsaved[0]).toEqual({ path: '/a.ts', saved: 'НА ДИСКЕ', edited: 'НЕСОХРАНЁННОЕ' });
    });

    it('нет открытого файла — молчит', async () => {
      const { commands, opened } = setup({ current: null });
      await commands.get('file.compareWithSaved')!(undefined);
      expect(opened).toEqual([]);
    });

    it('файла нет в реестре — молчит, а не сверяет с пустотой', async () => {
      const { commands, opened } = setup({ current: '/a.ts', draft: null });
      await commands.get('file.compareWithSaved')!('/a.ts');
      expect(opened).toEqual([]);
    });
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
