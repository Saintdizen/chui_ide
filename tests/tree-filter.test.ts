import { describe, expect, it } from 'vitest';
import { countMatches, filterTreePaths, matchesName } from '../src/renderer/core/tree-filter';

/**
 * Фильтр дерева проводника. Промахи тут тихие: лишняя скрытая папка выглядит
 * как «ничего не найдено», а лишний предок — как пустая папка в списке. Поэтому
 * проверяем не только «нашлось», но и что именно осталось.
 */

const rows = [
  { name: 'src', path: '/p/src', parent: '/p' },
  { name: 'util', path: '/p/src/util', parent: '/p/src' },
  { name: 'format.ts', path: '/p/src/util/format.ts', parent: '/p/src/util' },
  { name: 'parser.ts', path: '/p/src/util/parser.ts', parent: '/p/src/util' },
  { name: 'docs', path: '/p/docs', parent: '/p' },
  { name: 'readme.md', path: '/p/docs/readme.md', parent: '/p/docs' },
];

describe('matchesName', () => {
  it('пустой запрос пропускает всё', () => {
    expect(matchesName('что угодно', '')).toBe(true);
    expect(matchesName('что угодно', '   ')).toBe(true);
  });

  it('ищет подстроку без учёта регистра', () => {
    expect(matchesName('format.ts', 'FORMAT')).toBe(true);
    expect(matchesName('format.ts', 'rmat')).toBe(true);
  });

  it('не находит перестановку букв — это не нечёткий поиск', () => {
    expect(matchesName('util', 'utl')).toBe(false);
  });
});

describe('filterTreePaths', () => {
  it('пустой запрос оставляет все строки', () => {
    expect(filterTreePaths(rows, '').size).toBe(rows.length);
  });

  it('оставляет совпадение и всех его предков', () => {
    // `util` совпадает, значит нужны пути до него: src → util.
    // Совпадает только имя папки `util`; `src` остаётся как её родитель, а
    // файлы внутри — нет: они ни совпали, ни являются предками совпадения.
    // Их покажет раскрытие папки, а не сам фильтр.
    const keep = filterTreePaths(rows, 'util');
    expect(keep).toEqual(new Set(['/p/src', '/p/src/util']));
  });

  it('прячет ветки без совпадений', () => {
    const keep = filterTreePaths(rows, 'util');
    expect(keep.has('/p/docs')).toBe(false);
    expect(keep.has('/p/docs/readme.md')).toBe(false);
  });

  it('совпадение по имени файла поднимает всю цепочку до корня', () => {
    const keep = filterTreePaths(rows, 'parser');
    expect(keep.has('/p/src/util/parser.ts')).toBe(true);
    expect(keep.has('/p/src/util')).toBe(true);
    expect(keep.has('/p/src')).toBe(true);
    expect(keep.has('/p/src/util/format.ts')).toBe(false);
  });

  it('не находит ничего, когда совпадений нет', () => {
    expect(filterTreePaths(rows, 'нетакого').size).toBe(0);
  });

  it('корень без совпадений не появляется сам по себе', () => {
    // `/p` родителя не имеет и ни с чем не совпал — его в наборе быть не должно.
    expect(filterTreePaths(rows, 'util').has('/p')).toBe(false);
  });

  it('не зависает на цикле в родителях', () => {
    // Защита от испорченных данных: a → b → a.
    const cyclic = [
      { name: 'a', path: '/a', parent: '/b' },
      { name: 'b', path: '/b', parent: '/a' },
      { name: 'find-me', path: '/a/find-me', parent: '/a' },
    ];
    const keep = filterTreePaths(cyclic, 'find-me');
    expect(keep.has('/a/find-me')).toBe(true);
    expect(keep.size).toBeLessThanOrEqual(3);
  });

  it('сирота остаётся, даже если предка нет в наборе', () => {
    const orphan = [{ name: 'deep.ts', path: '/x/y/deep.ts', parent: '/x/y' }];
    expect(filterTreePaths(orphan, 'deep')).toEqual(new Set(['/x/y/deep.ts']));
  });
});

describe('countMatches', () => {
  it('считает совпадения, а не оставленные строки', () => {
    // Считаем именно совпадения по имени: `util` — одна папка, а `ts`
    // находится только в именах двух файлов (сам `util` не совпадает).
    expect(countMatches(rows, 'util')).toBe(1);
    expect(countMatches(rows, 'ts')).toBe(2);
  });

  it('на пустом запросе ноль', () => {
    expect(countMatches(rows, '')).toBe(0);
  });
});
