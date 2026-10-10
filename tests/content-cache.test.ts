import { describe, expect, it } from 'vitest';
import { ContentCache } from '../src/main/workspace/content-cache';

/**
 * Кэш содержимого. Проверяем две вещи, и вторая важнее первой: попадание в кэш
 * экономит чтение, но устаревшая запись опаснее отсутствия кэша — поиск нашёл бы
 * текст, которого в файле уже нет.
 */
describe('ContentCache', () => {
  it('отдаёт сохранённое, если версия файла не менялась', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 100, 10, 'первая версия');

    expect(cache.get('a.ts', 100, 10)).toBe('первая версия');
    expect(cache.stats().hits).toBe(1);
  });

  it('изменённый mtime — промах: устаревший текст не отдаём', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 100, 10, 'старое');

    expect(cache.get('a.ts', 200, 10)).toBeNull();
    expect(cache.stats().misses).toBe(1);
    // Испорченная запись выброшена, а не оставлена «на всякий случай».
    expect(cache.stats().entries).toBe(0);
  });

  it('изменённый размер при том же mtime — тоже промах', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 100, 10, 'старое');

    expect(cache.get('a.ts', 100, 20)).toBeNull();
  });

  it('неизвестный файл — промах, а не пустая строка', () => {
    const cache = new ContentCache();
    expect(cache.get('нет-такого.ts', 1, 1)).toBeNull();
    expect(cache.stats().hits).toBe(0);
  });

  it('invalidate забывает файл', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 100, 10, 'текст');
    cache.invalidate('a.ts');

    expect(cache.get('a.ts', 100, 10)).toBeNull();
    expect(cache.stats().bytes).toBe(0);
  });

  it('повторная запись того же файла не удваивает память', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 100, 5, 'первая');
    cache.set('a.ts', 200, 6, 'вторая версия');

    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe('вторая версия'.length);
    expect(cache.get('a.ts', 200, 6)).toBe('вторая версия');
  });

  it('при переполнении выбрасывает самое старое', () => {
    // Потолок 20 символов: три записи по 8 не помещаются.
    const cache = new ContentCache(20);
    cache.set('a.ts', 1, 1, 'аааааааа');
    cache.set('b.ts', 1, 1, 'bbbbbbbb');
    cache.set('c.ts', 1, 1, 'cccccccc');

    expect(cache.get('a.ts', 1, 1)).toBeNull();
    expect(cache.get('b.ts', 1, 1)).toBe('bbbbbbbb');
    expect(cache.get('c.ts', 1, 1)).toBe('cccccccc');
    expect(cache.stats().bytes).toBeLessThanOrEqual(20);
  });

  it('обращение отодвигает вытеснение: свежее нужное остаётся', () => {
    const cache = new ContentCache(20);
    cache.set('a.ts', 1, 1, 'аааааааа');
    cache.set('b.ts', 1, 1, 'bbbbbbbb');

    // Обращение к `a` делает его «нужным недавно» — теперь вытеснят `b`.
    expect(cache.get('a.ts', 1, 1)).toBe('аааааааа');
    cache.set('c.ts', 1, 1, 'cccccccc');

    expect(cache.get('a.ts', 1, 1)).toBe('аааааааа');
    expect(cache.get('b.ts', 1, 1)).toBeNull();
  });

  it('файл больше потолка не кэшируется вовсе', () => {
    const cache = new ContentCache(4);
    cache.set('big.ts', 1, 1, 'очень длинный текст');

    expect(cache.stats().entries).toBe(0);
    expect(cache.get('big.ts', 1, 1)).toBeNull();
  });

  it('clear обнуляет память и содержимое', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 1, 1, 'текст');
    cache.clear();

    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
    expect(cache.get('a.ts', 1, 1)).toBeNull();
  });

  it('счётчики обнуляются отдельно от содержимого', () => {
    const cache = new ContentCache();
    cache.set('a.ts', 1, 1, 'текст');
    cache.get('a.ts', 1, 1);
    cache.resetCounters();

    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, entries: 1 });
  });
});
