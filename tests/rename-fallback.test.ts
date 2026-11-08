import { describe, expect, it } from 'vitest';
import { planRename } from '../src/shared/rename-fallback';
import type { SearchHit } from '../src/shared/api/fs';

/**
 * Переименование без языкового сервера ищет слово по тексту, а не по смыслу.
 * Значит, оно обязано отказывать там, где нашло бы лишнее: иначе разом
 * переименует чужую переменную с тем же именем в другом файле.
 */

const hit = (path: string, line: number, column: number, text: string): SearchHit => ({
  path,
  line,
  column,
  text,
});

describe('planRename', () => {
  it('меняет только целые слова', () => {
    // column — номер СИМВОЛА с единицы, как отдаёт поиск.
    const plan = planRename('id', 'key', [
      hit('/p/a.ts', 1, 7, 'const id = 1;'),
      hit('/p/a.ts', 2, 7, 'const idx = 2;'),
    ]);
    expect(plan.total).toBe(1);
    expect(plan.files[0]!.edits).toEqual([{ path: '/p/a.ts', line: 1, column: 7, from: 'id', to: 'key' }]);
  });

  it('собирает правки по файлам', () => {
    const plan = planRename('a', 'b', [hit('/p/x.ts', 1, 1, 'a = a;'), hit('/p/y.ts', 3, 1, 'a;')]);
    expect(plan.files.map((file) => file.path)).toEqual(['/p/x.ts', '/p/y.ts']);
    // Поиск отдаёт строку с совпадением, а не каждое вхождение в ней: правка одна.
    expect(plan.files[0]!.edits).toHaveLength(1);
  });

  it('отказывает, когда совпадений слишком много', () => {
    const many = Array.from({ length: 400 }, (_, i) => hit('/p/a.ts', i + 1, 1, 'x;'));
    const plan = planRename('x', 'y', many);
    expect(plan.refused).not.toBeNull();
    expect(plan.files).toEqual([]);
  });

  it('пустой запрос — нечего искать', () => {
    const plan = planRename('', 'y', [hit('/p/a.ts', 1, 1, 'x;')]);
    expect(plan.refused).not.toBeNull();
  });
});
