import { describe, expect, it } from 'vitest';
import { restoreRoots } from '../src/shared/workspace-restore';

/** Все папки, кроме тех, что тест объявил пропавшими. */
const only = (...gone: string[]): ((root: string) => boolean) => {
  return (root) => !gone.includes(root);
};

describe('восстановление рабочей области при старте', () => {
  it('возвращает все корни и не теряет второй', () => {
    // Ровно та дыра, из-за которой пункт и был открыт: помнилась ОДНА папка,
    // и второй корень исчезал при перезапуске.
    const plan = restoreRoots(['/p/app', '/p/lib'], '/p/lib', only());
    expect(plan).toEqual({ roots: ['/p/app', '/p/lib'], activeRoot: '/p/lib' });
  });

  it('порядок корней сохраняется — дерево не переезжает при каждом старте', () => {
    const plan = restoreRoots(['/p/c', '/p/a', '/p/b'], '/p/c', only());
    expect(plan.roots).toEqual(['/p/c', '/p/a', '/p/b']);
  });

  it('пропавшую папку не поднимает — иначе дерево начнёт с чужой ошибки', () => {
    const plan = restoreRoots(['/p/app', '/p/gone', '/p/lib'], '/p/lib', only('/p/gone'));
    expect(plan.roots).toEqual(['/p/app', '/p/lib']);
    expect(plan.activeRoot).toBe('/p/lib');
  });

  it('активный выпал — его роль берёт первый выживший', () => {
    const plan = restoreRoots(['/p/app', '/p/lib'], '/p/gone', only());
    expect(plan.activeRoot).toBe('/p/app');
  });

  it('активный вне набора не возвращается: git и поиск пошли бы в никуда', () => {
    const plan = restoreRoots(['/p/app'], '/p/other', only());
    expect(plan.activeRoot).toBe('/p/app');
  });

  it('мусор из файла настроек не ломает восстановление', () => {
    // Файл правят руками: там могут оказаться не строки, пустые строки и дубли.
    const plan = restoreRoots(['/p/app', 42, '', null, '/p/app', '/p/lib'], undefined, only());
    expect(plan).toEqual({ roots: ['/p/app', '/p/lib'], activeRoot: '/p/app' });
  });

  it('все папки пропали — не открываем ничего, пусть будет список проектов', () => {
    expect(restoreRoots(['/p/a', '/p/b'], '/p/a', only('/p/a', '/p/b'))).toEqual({ roots: [], activeRoot: null });
    expect(restoreRoots([], null, only())).toEqual({ roots: [], activeRoot: null });
  });
});
