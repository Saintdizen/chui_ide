import { describe, expect, it } from 'vitest';
import {
  canUndoTrash,
  createFileUndo,
  createFolderUndo,
  prepareRename,
  trackMove,
  undoMoves,
  undoRenamePlan,
} from '../src/renderer/core/file-actions';

describe('prepareRename', () => {
  it('активная вкладка закрыта, если переименовываем именно её', () => {
    expect(prepareRename('/a.txt', '/a.txt', true)).toEqual({ from: '/a.txt', hadTab: true, wasActive: true });
  });

  it('вкладка есть, но активна соседняя — вернуть на экран нечего', () => {
    expect(prepareRename('/a.txt', '/b.txt', true)).toEqual({ from: '/a.txt', hadTab: true, wasActive: false });
  });

  it('вкладки нет — закрывать нечего', () => {
    expect(prepareRename('/a.txt', null, false)).toEqual({ from: '/a.txt', hadTab: false, wasActive: false });
  });

  it('активной нет вовсе (null) — это не активность', () => {
    expect(prepareRename('/a.txt', null, true).wasActive).toBe(false);
  });
});

describe('undoRenamePlan', () => {
  it('возврат меняет пути местами', () => {
    const back = undoRenamePlan({ from: '/old.txt', to: '/new.txt', touched: 0 });
    expect([back.from, back.to]).toEqual(['/new.txt', '/old.txt']);
  });

  it('ссылки не правились — возвращать нечего, и это не повод считать правку', () => {
    expect(undoRenamePlan({ from: '/o', to: '/n', touched: 0 }).restoreImports).toBe(false);
  });

  it('ссылки правились — их тоже надо вернуть, иначе в проекте останутся битые', () => {
    expect(undoRenamePlan({ from: '/o', to: '/n', touched: 2 }).restoreImports).toBe(true);
  });
});

describe('отмена создания', () => {
  it('файл: вкладку открывали — закрываем её и уносим тот же путь', () => {
    expect(createFileUndo('/a.txt')).toEqual({ closeTab: true, closePath: '/a.txt', trashPath: '/a.txt' });
  });

  it('папка: вкладки нет — закрывать нечего', () => {
    expect(createFolderUndo('/dir')).toEqual({ closeTab: false, closePath: null, trashPath: '/dir' });
  });

  it('после отмены создания файла в дереве ничего не осталось бы, если б не refreshed', () => {
    // Тест на форму: всё для уборки — в одном значении, а не в трёх аргументах
    // на месте вызова, где один из них легко перепутать с путём папки.
    const undo = createFileUndo('/a.txt');
    expect(undo.closePath).toBe(undo.trashPath);
  });
});

describe('canUndoTrash', () => {
  it('восстановления из корзины нет — и не притворяемся, что есть', () => {
    expect(canUndoTrash()).toBe(false);
  });
});

describe('trackMove', () => {
  it('активность запоминается до закрытия вкладки', () => {
    expect(trackMove('/src/a.ts', '/lib/a.ts', '/src/a.ts')).toEqual({
      from: '/src/a.ts',
      to: '/lib/a.ts',
      active: true,
    });
  });

  it('переезжает не активный — экран не трогаем', () => {
    expect(trackMove('/src/a.ts', '/lib/a.ts', '/src/b.ts').active).toBe(false);
  });

  it('активной нет — это не активность', () => {
    expect(trackMove('/src/a.ts', '/lib/a.ts', null).active).toBe(false);
  });
});

describe('undoMoves', () => {
  const steps = [
    { from: '/src/a.ts', to: '/lib/a.ts', active: true },
    { from: '/src/b.ts', to: '/lib/b.ts', active: false },
    { from: '/src/c.ts', to: '/lib/c.ts', active: false },
  ];

  it('обратный порядок: последний переехавший возвращается первым', () => {
    expect(undoMoves(steps).map((step) => step.from)).toEqual(['/lib/c.ts', '/lib/b.ts', '/lib/a.ts']);
  });

  it('каждый шаг — ровно то же ребро, что и вперёд, только наоборот', () => {
    const back = undoMoves(steps);
    expect(back[0]).toEqual({ from: '/lib/c.ts', to: '/src/c.ts', active: false });
  });

  it('пустая пачка — пустой возврат', () => {
    expect(undoMoves([])).toEqual([]);
  });

  it('вход не меняется: возврат строится из снимка, а не переворачивает его на месте', () => {
    const copy = steps.map((step) => ({ ...step }));
    undoMoves(steps);
    expect(steps).toEqual(copy);
  });
});
