import { describe, expect, it } from 'vitest';
import { BookmarkModel } from '../src/renderer/core/bookmarks';

/**
 * Владелец закладок (`renderer/core/bookmarks.ts`).
 *
 * Сами правки — чистые функции в `shared/bookmarks.ts` (проверены отдельно). Здесь
 * обязанности модели: одно событие на изменение и НИ ОДНОГО события, когда список не
 * поменялся. Второе — не придирка: событие заставляет редактор перерисовать значки
 * всех открытых файлов, и лишняя перерисовка видна на прокрутке.
 */

function makeModel() {
  const model = new BookmarkModel();
  const changes: number[] = [];
  model.onDidChange((items) => changes.push(items.length));
  return { model, changes };
}

describe('закладки: правка и событие', () => {
  it('постановка и снятие меняют список и дают событие', () => {
    const { model, changes } = makeModel();

    expect(model.toggle('/p/a.ts', 3)).toBe(true);
    expect(model.toggle('/p/a.ts', 3)).toBe(false);

    expect(changes).toEqual([1, 0]);
  });

  it('снятие несуществующей закладки не даёт события', () => {
    // Иначе редактор перерисовывал бы значки ни с того ни с сего.
    const { model, changes } = makeModel();

    model.remove('/p/a.ts', 3);

    expect(changes).toEqual([]);
  });

  it('очистка файла без закладок не даёт события', () => {
    const { model, changes } = makeModel();
    model.toggle('/p/a.ts', 1);

    model.clearFile('/p/other.ts');

    expect(changes).toEqual([1]);
  });

  it('очистка файла убирает только его строки', () => {
    const { model } = makeModel();
    model.toggle('/p/a.ts', 1);
    model.toggle('/p/a.ts', 5);
    model.toggle('/p/b.ts', 2);

    model.clearFile('/p/a.ts');

    expect(model.all.map((item) => item.path)).toEqual(['/p/b.ts']);
  });

  it('счётчик и список файлов согласованы', () => {
    const { model } = makeModel();
    model.toggle('/p/a.ts', 1);
    model.toggle('/p/a.ts', 5);

    expect(model.count()).toBe(2);
    expect(model.linesOf('/p/a.ts').sort()).toEqual([1, 5]);
    expect(model.files()).toEqual(['/p/a.ts']);
    expect(model.isBookmarked('/p/a.ts', 5)).toBe(true);
    expect(model.isBookmarked('/p/a.ts', 6)).toBe(false);
  });
});

describe('закладки: переход и сессия', () => {
  it('следующая и предыдущая закладки идут по кругу', () => {
    const { model } = makeModel();
    model.toggle('/p/a.ts', 1);
    model.toggle('/p/a.ts', 9);
    model.toggle('/p/b.ts', 4);
    const first = model.all[0]!;

    expect(model.next(first, 1)?.line).toBe(9);
    // С последней — на первую: ходить по кругу удобнее, чем «дошли до края».
    expect(model.next(model.all.at(-1)!, 1)?.path).toBe('/p/a.ts');
    expect(model.next(first, -1)?.path).toBe('/p/b.ts');
  });

  it('одна закладка — переход возвращает её же', () => {
    const { model } = makeModel();
    model.toggle('/p/a.ts', 1);

    expect(model.next(model.all[0]!, 1)).toEqual(model.all[0]);
  });

  it('нет закладок — переходить некуда', () => {
    const { model } = makeModel();

    expect(model.next({ path: '/p/a.ts', line: 1 }, 1)).toBeNull();
  });

  it('записи сессии — копия, а не сам список', () => {
    // Иначе вызывающий правкой записи менял бы закладки в обход модели и её события.
    const { model } = makeModel();
    model.toggle('/p/a.ts', 1);

    const records = model.records();
    records.push({ path: '/p/b.ts', line: 2 });

    expect(model.count()).toBe(1);
  });

  it('восстановление берёт проверенные записи и будит подписчиков', () => {
    const { model, changes } = makeModel();

    model.restore([{ path: '/p/a.ts', line: 2 }, { path: '/p/a.ts', line: 2 }, { path: '', line: 0 }, 'мусор']);

    // Дубликат и мусор отброшены: список пришёл из сохранённой сессии.
    expect(model.all).toHaveLength(1);
    expect(changes).toEqual([1]);
  });

  it('мусор вместо списка даёт пустые закладки, а не падение', () => {
    const { model } = makeModel();
    model.toggle('/p/a.ts', 1);

    model.restore('не список');

    expect(model.count()).toBe(0);
  });
});
