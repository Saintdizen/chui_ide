import { describe, expect, it } from 'vitest';
import { importsOf } from '../src/shared/import-rewrite';

/**
 * «Кто ссылается на файл» — обратный ход к переименованию: считаем, как ЭТОТ
 * файл писал бы путь к цели, и сравниваем. Проверка «заканчивается ли
 * спецификатор на имя» нашла бы ссылки на чужой одноимённый файл.
 */
describe('importsOf: ссылки на файл', () => {
  const target = 'src/shared/util.ts';

  it('находит относительный импорт', () => {
    const text = `import { a } from './shared/util';`;
    expect(importsOf(text, { file: 'src/app.ts', target })).toEqual(['./shared/util']);
  });

  it('не путает одноимённые файлы в разных папках', () => {
    // `./util` из src/a/ ведёт в src/a/util.ts, а не в src/shared/util.ts.
    const text = `import { a } from './util';`;
    expect(importsOf(text, { file: 'src/a/b.ts', target })).toEqual([]);
  });

  it('видит реэкспорт и динамический import', () => {
    const text = [`export { b } from '../shared/util';`, `const m = await import('../shared/util');`].join('\n');
    expect(importsOf(text, { file: 'src/main/x.ts', target })).toHaveLength(2);
  });

  it('граница сегмента: ./utilx — не наша цель', () => {
    expect(importsOf(`import './utilx';`, { file: 'src/shared/y.ts', target })).toEqual([]);
  });

  it('импорт ПАПКИ целиком — не ссылка на файл внутри неё', () => {
    // `./shared` ведёт на index/`__init__` папки, а не на util.ts. Считать это
    // ссылкой значило бы показывать файлы, которые цель не используют.
    expect(importsOf(`import './shared'`, { file: 'src/app.ts', target })).toEqual([]);
  });

  it('ссылки на папку: любой файл внутри неё', () => {
    expect(importsOf(`import './shared'`, { file: 'src/app.ts', target: 'src/shared' })).toEqual(['./shared']);
  });

  it('питон: from . import и from пакет import', () => {
    const target = 'pkg/db.py';
    const text = ['from .db import conn', 'from pkg.db import conn', 'import pkg.db'].join('\n');
    expect(importsOf(text, { file: 'pkg/app.py', target })).toHaveLength(3);
  });

  it('файл без импортов и неизвестный язык — пусто', () => {
    expect(importsOf('', { file: 'src/a.ts', target })).toEqual([]);
    expect(importsOf(`import './util'`, { file: 'README.md', target })).toEqual([]);
  });
});
