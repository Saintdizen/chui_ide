import { describe, expect, it } from 'vitest';
import {
  canUndoDiscard,
  canUndoTrash,
  copiedToTrash,
  createFileUndo,
  createFolderUndo,
  planCommitSave,
  planCommitStage,
  prepareDiscard,
  prepareRename,
  trackMove,
  trackMoves,
  undoMoves,
  undoRenamePlan,
  undoableAfterTrash,
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

describe('planCommitSave', () => {
  const dirty = [
    { path: '/src/a.ts', readOnly: false },
    { path: '/vendor/b.ts', readOnly: true },
    { path: '/src/c.ts', readOnly: false },
  ];

  it('сохраняет записываемые, а только для чтения — в blocked', () => {
    const plan = planCommitSave(dirty, true);
    expect(plan.save).toEqual(['/src/a.ts', '/src/c.ts']);
    expect(plan.blocked).toEqual(['/vendor/b.ts']);
  });

  it('настройка выключена — не сохраняем ничего, но только для чтения всё равно не сохранить', () => {
    // Тут важна честность плана: коммитить по устаревшему диску нельзя, даже если
    // человек сам отказался от автосохранения. Иначе настройка превращается в баг.
    const plan = planCommitSave(dirty, false);
    expect(plan.save).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });

  it('нечего сохранять — нечего и блокировать', () => {
    expect(planCommitSave([], true)).toEqual({ save: [], blocked: [] });
  });
});

describe('planCommitStage', () => {
  it('в индексе есть — коммитим', () => {
    expect(planCommitStage(2, 5)).toBe('commit');
  });

  it('индекс пуст, а правки есть — спрашиваем', () => {
    expect(planCommitStage(0, 3)).toBe('ask');
  });

  it('пусто везде — коммитить нечего', () => {
    expect(planCommitStage(0, 0)).toBe('nothing');
  });
});

describe('prepareDiscard', () => {
  const hasTab = (path: string): boolean => path.startsWith('/open/');

  it('закрывает только открытые вкладки', () => {
    const plan = prepareDiscard(['/open/a.ts', '/closed/b.ts'], null, hasTab);
    expect(plan.close).toEqual(['/open/a.ts']);
  });

  it('активный файл помним по пути, а не по «первому в списке»', () => {
    const plan = prepareDiscard(['/open/a.ts', '/open/b.ts'], '/open/b.ts', hasTab);
    expect(plan.activePath).toBe('/open/b.ts');
    expect(plan.wasActive).toBe(true);
  });

  it('активный не среди откатываемых — открывать заново нечего', () => {
    const plan = prepareDiscard(['/open/a.ts'], '/open/other.ts', hasTab);
    expect(plan.activePath).toBeNull();
    expect(plan.wasActive).toBe(false);
  });

  it('активной нет — это не активность', () => {
    expect(prepareDiscard(['/open/a.ts'], null, hasTab).activePath).toBeNull();
  });

  it('откат необратим — и не притворяемся, что нет', () => {
    expect(canUndoDiscard()).toBe(false);
  });
});

describe('trackMoves', () => {
  it('снимок делается по всем шагам и одной активной вкладке', () => {
    const tracks = trackMoves(
      [
        { from: '/src/a.ts', to: '/lib/a.ts' },
        { from: '/src/b.ts', to: '/lib/b.ts' },
      ],
      '/src/b.ts',
    );
    expect(tracks).toEqual([
      { from: '/src/a.ts', to: '/lib/a.ts', active: false },
      { from: '/src/b.ts', to: '/lib/b.ts', active: true },
    ]);
  });
});

describe('copiedToTrash', () => {
  it('в корзину идёт копия, а не исходник', () => {
    expect(copiedToTrash(['/lib/a.ts'])).toEqual(['/lib/a.ts']);
  });

  it('ничего не скопировалось — нечего убирать', () => {
    expect(copiedToTrash([])).toEqual([]);
  });

  it('вход не переворачивается и не чистит сам себя', () => {
    const copied = ['/lib/a.ts', '/lib/b.ts'];
    copiedToTrash(copied).push('/lib/c.ts');
    expect(copied).toEqual(['/lib/a.ts', '/lib/b.ts']);
  });
});

describe('undoableAfterTrash', () => {
  it('без восстановления из корзины возвращать нечего, сколько ни удали', () => {
    expect(undoableAfterTrash(5)).toBe(0);
    expect(undoableAfterTrash(0)).toBe(0);
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
