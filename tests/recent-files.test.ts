import { describe, expect, it } from 'vitest';
import { RECENT_FILES_LIMIT, createRecentFiles, recentFor } from '../src/renderer/core/recent-files';

describe('recentFor', () => {
  it('оставляет только файлы текущего проекта, относительными путями', () => {
    const history = ['/p/a.ts', '/other/b.ts', '/p/nested/c.ts'];
    expect(recentFor(history, '/p', () => true)).toEqual(['a.ts', 'nested/c.ts']);
  });

  it('без проекта не отдаёт ничего', () => {
    expect(recentFor(['/p/a.ts'], null, () => true)).toEqual([]);
  });

  it('пропускает исчезнувшие файлы: история живёт дольше диска', () => {
    expect(recentFor(['/p/a.ts', '/p/gone.ts'], '/p', (path) => path === 'a.ts')).toEqual(['a.ts']);
  });

  it('корень с косой чертой на конце не даёт двойного слэша', () => {
    expect(recentFor(['/p/a.ts'], '/p/', () => true)).toEqual(['a.ts']);
  });
});

describe('createRecentFiles', () => {
  it('повторное открытие поднимает файл наверх, не дублируя', () => {
    const recent = createRecentFiles();
    recent.remember('/p/a.ts');
    recent.remember('/p/b.ts');
    recent.remember('/p/a.ts');
    expect(recent.paths()).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  it('пустые пути и каталоги не запоминаются', () => {
    const recent = createRecentFiles();
    recent.remember('');
    recent.remember('/p/dir/');
    // Каталог не файл: если бы попал, в палитре висел бы путь, который не открыть.
    expect(recent.paths()).toEqual([]);
  });

  it('длина списка ограничена', () => {
    const recent = createRecentFiles(3);
    for (const path of ['/a', '/b', '/c', '/d']) recent.remember(path);
    expect(recent.paths()).toEqual(['/d', '/c', '/b']);
  });

  it('по умолчанию держит не больше RECENT_FILES_LIMIT', () => {
    const recent = createRecentFiles();
    for (let index = 0; index < RECENT_FILES_LIMIT + 5; index += 1) recent.remember(`/p/${index}.ts`);
    expect(recent.paths()).toHaveLength(RECENT_FILES_LIMIT);
  });

  it('forget убирает путь', () => {
    const recent = createRecentFiles();
    recent.remember('/p/a.ts');
    recent.forget('/p/a.ts');
    expect(recent.paths()).toEqual([]);
  });

  it('restore чистит испорченный сохранённый список', () => {
    const recent = createRecentFiles(4);
    // По одному повторы и мусор; два хороших пути сохранены.
    recent.restore(['/a', 42 as unknown as string, '/b', '/a', '/c', '/d', '/e']);
    expect(recent.paths()).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('clear обнуляет историю', () => {
    const recent = createRecentFiles();
    recent.remember('/p/a.ts');
    recent.clear();
    expect(recent.paths()).toEqual([]);
  });

  it('paths отдаёт копию: правка снаружи не ломает историю', () => {
    const recent = createRecentFiles();
    recent.remember('/p/a.ts');
    const list = recent.paths() as string[];
    list.push('/p/b.ts');
    expect(recent.paths()).toEqual(['/p/a.ts']);
  });
});
