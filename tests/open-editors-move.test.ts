import { describe, expect, it } from 'vitest';

/**
 * Порядок вкладок при перетаскивании. Модель чистая — документов ей хватает
 * заглушки; проверяем то, что легко сломать: границу закреплённых и сдвиг
 * индекса при движении вправо.
 */
const { OpenEditors } = await import('../src/renderer/core/open-editors');

const make = () => {
  const documents = { get: () => null, onDidChange: () => ({ dispose: () => undefined }) } as never;
  const editors = new OpenEditors(documents);
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    (editors as never as { order: string[] }).order.push(name);
  }
  return editors;
};

describe('OpenEditors.move', () => {
  it('движение вправо: вкладка встаёт ПЕРЕД целью', () => {
    const editors = make();
    // b на место d: [a, c, b, d] — индекс цели считался до извлечения.
    expect(editors.move('b.ts', 'd.ts')).toEqual(['a.ts', 'c.ts', 'b.ts', 'd.ts']);
  });

  it('движение влево', () => {
    const editors = make();
    expect(editors.move('d.ts', 'b.ts')).toEqual(['a.ts', 'd.ts', 'b.ts', 'c.ts']);
  });

  it('null — в конец', () => {
    const editors = make();
    expect(editors.move('a.ts', null)).toEqual(['b.ts', 'c.ts', 'd.ts', 'a.ts']);
  });

  it('ставить на своё же место — ничего не меняется', () => {
    const editors = make();
    expect(editors.move('b.ts', 'b.ts')).toBeNull();
  });

  it('закреплённая не уезжает за границу закреплённых', () => {
    const editors = make();
    editors.pin('a.ts');
    // Тянем закреплённую в конец — она остаётся первой: «эти всегда слева».
    expect(editors.move('a.ts', null)).toBeNull();
  });

  it('обычная не уезжает в зону закреплённых', () => {
    const editors = make();
    editors.pin('a.ts');
    editors.pin('b.ts');
    // Тащим d перед a, то есть внутрь закреплённых: место прижимается к
    // первой свободной — сразу после последней закреплённой (c остаётся).
    expect(editors.move('d.ts', 'a.ts')).toEqual(['a.ts', 'b.ts', 'd.ts', 'c.ts']);
  });

  it('неизвестные пути — null, порядок не тронут', () => {
    const editors = make();
    expect(editors.move('zzz.ts', 'a.ts')).toBeNull();
    expect(editors.move('a.ts', 'zzz.ts')).toBeNull();
  });
});
