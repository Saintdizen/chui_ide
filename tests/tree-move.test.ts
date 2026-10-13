import { describe, expect, it } from 'vitest';
import { copyPlan, movePlan } from '../src/renderer/core/tree-move';

/**
 * План переноса в целевую папку. Разбор путей — на разделителе системы, поэтому
 * те же случаи проверяем и для обратных слэшей: на Windows иначе перенос
 * «в никуда» не распознаётся и файл уезжает сам в себя.
 */
describe('movePlan', () => {
  it('переносит файлы в целевую папку, сохраняя имена', () => {
    expect(movePlan(['/p/src/a.ts', '/p/b.ts'], '/p/lib')).toEqual([
      { from: '/p/src/a.ts', to: '/p/lib/a.ts' },
      { from: '/p/b.ts', to: '/p/lib/b.ts' },
    ]);
  });

  it('разбирает пути Windows с обратными слэшами', () => {
    expect(movePlan(['C:\\p\\src\\a.ts'], 'C:\\p\\lib')).toEqual([
      { from: 'C:\\p\\src\\a.ts', to: 'C:\\p\\lib\\a.ts' },
    ]);
  });

  it('файл уже в целевой папке — шага нет', () => {
    expect(movePlan(['/p/lib/a.ts'], '/p/lib')).toEqual([]);
  });

  it('папку нельзя перенести внутрь себя', () => {
    expect(movePlan(['/p/src'], '/p/src')).toEqual([]);
  });

  it('папку нельзя перенести внутрь своего потомка', () => {
    expect(movePlan(['/p/src'], '/p/src/nested')).toEqual([]);
  });

  it('вложенный путь не переносится отдельно, если едет его предок', () => {
    expect(movePlan(['/p/src', '/p/src/a.ts'], '/p/lib')).toEqual([{ from: '/p/src', to: '/p/lib/src' }]);
  });

  it('сосед по имени не путается с вложенным путём', () => {
    // «src2» не лежит внутри «src», хотя и начинается так же.
    expect(movePlan(['/p/src', '/p/src2'], '/p/lib')).toEqual([
      { from: '/p/src', to: '/p/lib/src' },
      { from: '/p/src2', to: '/p/lib/src2' },
    ]);
  });
});

/**
 * Копирование считает шаги теми же правилами: копия в ту же папку или внутрь себя
 * так же бессмысленна, а вложенный путь не копируется отдельно от предка —
 * иначе он попал бы в цель дважды.
 */
describe('copyPlan', () => {
  it('даёт те же шаги, что перенос', () => {
    expect(copyPlan(['/p/src/a.ts', '/p/b.ts'], '/p/lib')).toEqual(movePlan(['/p/src/a.ts', '/p/b.ts'], '/p/lib'));
  });

  it('не копирует файл в его же папку и папку внутрь себя', () => {
    expect(copyPlan(['/p/lib/a.ts'], '/p/lib')).toEqual([]);
    expect(copyPlan(['/p/src'], '/p/src')).toEqual([]);
  });
});
