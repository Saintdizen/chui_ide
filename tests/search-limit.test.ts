import { describe, expect, it } from 'vitest';
import { limitPerFile, MAX_HITS_PER_FILE } from '../src/shared/search-limit';

/**
 * Потолок совпадений на файл.
 *
 * Поиск отдаёт до 200 совпадений, и один шумный файл занимает их все:
 * `package-lock.json` отвечает на любой запрос. Модель видит двести строк из
 * одного места и делает вывод «больше нигде нет» — а до остальных файлов поиск
 * даже не дошёл.
 */

const hit = (path: string, line: number) => ({ path, line, column: 1, text: 'строка' });

describe('limitPerFile', () => {
  it('на файл остаётся не больше потолка', () => {
    const hits = Array.from({ length: 30 }, (_, index) => hit('package-lock.json', index + 1));
    const result = limitPerFile(hits, MAX_HITS_PER_FILE, 200);
    expect(result.hits).toHaveLength(MAX_HITS_PER_FILE);
    expect(result.hidden).toBe(20);
    // Общий предел не достигнут — скрыто именно потолком на файл.
    expect(result.truncated).toBe(false);
  });

  it('другие файлы не страдают от шумного', () => {
    const hits = [
      ...Array.from({ length: 30 }, (_, index) => hit('package-lock.json', index + 1)),
      hit('src/app.ts', 10),
      hit('src/boot.ts', 20),
    ];
    const paths = limitPerFile(hits, 10, 200).hits.map((item) => item.path);
    expect(paths.filter((path) => path === 'package-lock.json')).toHaveLength(10);
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('src/boot.ts');
  });

  it('общий предел по-прежнему режет список', () => {
    const hits = Array.from({ length: 30 }, (_, index) => hit(`src/f${index % 15}.ts`, index + 1));
    const result = limitPerFile(hits, 4, 10);
    expect(result.hits).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it('порядок сохраняется: первый файл в выдаче остаётся первым', () => {
    const hits = [hit('a.ts', 1), hit('b.ts', 2), hit('a.ts', 3)];
    expect(limitPerFile(hits, 10, 200).hits.map((item) => `${item.path}:${item.line}`)).toEqual([
      'a.ts:1',
      'b.ts:2',
      'a.ts:3',
    ]);
  });

  it('без общего предела (0) режет только потолок на файл', () => {
    const hits = Array.from({ length: 50 }, (_, index) => hit(`f${index}.ts`, 1));
    const result = limitPerFile(hits, 10, 0);
    expect(result.hits).toHaveLength(50);
    expect(result.hidden).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('когда всё влезает — ничего не скрыто', () => {
    const hits = [hit('a.ts', 1), hit('b.ts', 2)];
    expect(limitPerFile(hits, 10, 200)).toEqual({ hits, hidden: 0, truncated: false });
  });
});
