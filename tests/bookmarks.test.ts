import { describe, expect, it } from 'vitest';
import {
  bookmarkFiles,
  bookmarkLabel,
  bookmarkLines,
  clearBookmarksIn,
  countBookmarks,
  isBookmarked,
  MAX_BOOKMARKS,
  nextBookmark,
  removeBookmark,
  sanitizeBookmarks,
  sortBookmarks,
  toggleBookmark,
  type BookmarkRecord,
} from '../src/shared/bookmarks';

const bm = (path: string, line: number): BookmarkRecord => ({ path, line });

/**
 * Закладки — чистый список записей: файл и строка. Проверяем порядок, постановку и
 * переходы (список замкнут), а также разбор из сессии — туда мог попасть мусор.
 */
describe('sanitizeBookmarks', () => {
  it('на не-массив даёт пустой список', () => {
    expect(sanitizeBookmarks(null)).toEqual([]);
    expect(sanitizeBookmarks({ path: '/a', line: 1 })).toEqual([]);
  });

  it('отбрасывает записи без пути или со нецелой строкой', () => {
    const raw = [
      bm('/a.ts', 2),
      { path: '/b.ts' },
      { line: 3 },
      { path: '/c.ts', line: 0 },
      { path: '/d.ts', line: 1.5 },
      7,
    ];
    expect(sanitizeBookmarks(raw)).toEqual([bm('/a.ts', 2)]);
  });

  it('убирает повторы и сортирует по файлу и строке', () => {
    const raw = [bm('/b.ts', 2), bm('/a.ts', 5), bm('/a.ts', 1), bm('/a.ts', 1)];
    expect(sanitizeBookmarks(raw)).toEqual([bm('/a.ts', 1), bm('/a.ts', 5), bm('/b.ts', 2)]);
  });

  it('держит потолок числа закладок', () => {
    const raw = Array.from({ length: MAX_BOOKMARKS + 20 }, (_, index) => bm('/a.ts', index + 1));
    expect(sanitizeBookmarks(raw)).toHaveLength(MAX_BOOKMARKS);
  });
});

describe('сортировка и выборки', () => {
  const records = [bm('/b.ts', 9), bm('/a.ts', 4), bm('/a.ts', 2)];

  it('sortBookmarks ставит файл, затем строку', () => {
    expect(sortBookmarks(records)).toEqual([bm('/a.ts', 2), bm('/a.ts', 4), bm('/b.ts', 9)]);
  });

  it('bookmarkLines отдаёт строки файла по возрастанию', () => {
    expect(bookmarkLines(records, '/a.ts')).toEqual([2, 4]);
    expect(bookmarkLines(records, '/нет.ts')).toEqual([]);
  });

  it('bookmarkFiles перечисляет файлы без повторов в порядке путей', () => {
    expect(bookmarkFiles(records)).toEqual(['/a.ts', '/b.ts']);
  });

  it('countBookmarks считает записи', () => {
    expect(countBookmarks(records)).toBe(3);
    expect(countBookmarks([])).toBe(0);
  });
});

describe('постановка и снятие', () => {
  it('toggleBookmark ставит и снимает, сохраняя порядок', () => {
    const one = toggleBookmark([], '/b.ts', 3);
    expect(one).toEqual([bm('/b.ts', 3)]);
    const two = toggleBookmark(one, '/a.ts', 1);
    expect(two).toEqual([bm('/a.ts', 1), bm('/b.ts', 3)]);
    expect(toggleBookmark(two, '/b.ts', 3)).toEqual([bm('/a.ts', 1)]);
  });

  it('isBookmarked спрашивает про конкретную строку', () => {
    expect(isBookmarked([bm('/a.ts', 2)], '/a.ts', 2)).toBe(true);
    expect(isBookmarked([bm('/a.ts', 2)], '/a.ts', 3)).toBe(false);
    expect(isBookmarked([bm('/a.ts', 2)], '/b.ts', 2)).toBe(false);
  });

  it('removeBookmark снимает одну строку', () => {
    expect(removeBookmark([bm('/a.ts', 2), bm('/a.ts', 5)], '/a.ts', 2)).toEqual([bm('/a.ts', 5)]);
    // Снятие несуществующей закладки список не меняет.
    expect(removeBookmark([bm('/a.ts', 2)], '/a.ts', 9)).toEqual([bm('/a.ts', 2)]);
  });

  it('clearBookmarksIn убирает файл целиком', () => {
    expect(clearBookmarksIn([bm('/a.ts', 2), bm('/b.ts', 5)], '/a.ts')).toEqual([bm('/b.ts', 5)]);
  });
});

describe('nextBookmark', () => {
  const records = [bm('/a.ts', 2), bm('/a.ts', 6), bm('/b.ts', 1)];

  it('идёт по каноническому порядку вперёд', () => {
    expect(nextBookmark(records, bm('/a.ts', 2), 1)).toEqual(bm('/a.ts', 6));
    expect(nextBookmark(records, bm('/a.ts', 6), 1)).toEqual(bm('/b.ts', 1));
  });

  it('идёт назад', () => {
    expect(nextBookmark(records, bm('/b.ts', 1), -1)).toEqual(bm('/a.ts', 6));
    expect(nextBookmark(records, bm('/a.ts', 6), -1)).toEqual(bm('/a.ts', 2));
  });

  it('список замкнут: за последней идёт первая', () => {
    expect(nextBookmark(records, bm('/b.ts', 1), 1)).toEqual(bm('/a.ts', 2));
    expect(nextBookmark(records, bm('/a.ts', 2), -1)).toEqual(bm('/b.ts', 1));
  });

  it('закладка одна — возвращает её же', () => {
    const only = [bm('/a.ts', 3)];
    expect(nextBookmark(only, bm('/a.ts', 3), 1)).toEqual(bm('/a.ts', 3));
    expect(nextBookmark(only, bm('/a.ts', 3), -1)).toEqual(bm('/a.ts', 3));
  });

  it('из места без закладки берёт ближайшую в нужную сторону', () => {
    expect(nextBookmark(records, bm('/a.ts', 4), 1)).toEqual(bm('/a.ts', 6));
    expect(nextBookmark(records, bm('/a.ts', 4), -1)).toEqual(bm('/a.ts', 2));
    // Позиция до первой закладки: назад — с последней, вперёд — с первой.
    expect(nextBookmark(records, bm('/a.ts', 1), 1)).toEqual(bm('/a.ts', 2));
    expect(nextBookmark(records, bm('/a.ts', 1), -1)).toEqual(bm('/b.ts', 1));
  });

  it('закладок нет — null', () => {
    expect(nextBookmark([], bm('/a.ts', 1), 1)).toBeNull();
  });
});

describe('подпись', () => {
  it('внутри корня путь показывается коротким и с номером строки', () => {
    expect(bookmarkLabel(bm('/p/src/app.ts', 12), '/p')).toBe('src/app.ts:12');
  });

  it('вне корня путь остаётся абсолютным', () => {
    expect(bookmarkLabel(bm('/q/app.ts', 3), '/p')).toBe('/q/app.ts:3');
    expect(bookmarkLabel(bm('/q/app.ts', 3), null)).toBe('/q/app.ts:3');
  });
});
