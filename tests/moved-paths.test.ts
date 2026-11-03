import { describe, expect, it } from 'vitest';
import { movedPaths } from '../src/renderer/core/moved-paths';

/**
 * План переноса. Главное здесь — не адреса, а список того, что надо сохранить
 * до переименования: буфер, не записанный заранее, исчезнет при переоткрытии.
 */
describe('movedPaths', () => {
  it('для каждого файла — откуда и куда', () => {
    expect(movedPaths(['/p/a.ts', '/p/b.ts'], '/p/sub', () => false)).toEqual({
      tabs: [
        { from: '/p/a.ts', to: '/p/sub/a.ts' },
        { from: '/p/b.ts', to: '/p/sub/b.ts' },
      ],
      unsaved: [],
      notice: 'a.ts, b.ts',
    });
  });

  it('в несохранённые попадают только грязные буферы', () => {
    const plan = movedPaths(['/p/a.ts', '/p/b.ts'], '/p/sub', (path) => path === '/p/b.ts');
    expect(plan.unsaved).toEqual(['/p/b.ts']);
  });

  it('пустой список — пустой план', () => {
    expect(movedPaths([], '/p/sub', () => true)).toEqual({ tabs: [], unsaved: [], notice: '' });
  });

  it('папка с разделителем на конце не даёт двойного слэша', () => {
    const plan = movedPaths(['/p/a.ts'], '/p/sub/', () => false);
    expect(plan.tabs[0]?.to).toBe('/p/sub/a.ts');
  });
});
