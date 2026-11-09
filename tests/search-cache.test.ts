import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchCache, type SearchCacheKey } from '../src/main/ai/search-cache';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { searchCacheStats } from '../src/main/ai/agent-search';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Кэш поиска по версиям файлов (п.64).
 *
 * `search` — второй по цене ответ после `read`, и модель повторяет его: тот же
 * запрос другим написанием, тот же запрос после правки чужого файла. Ответ
 * меняется только вместе с файлами, где он нашёлся, — их `mtime` + размер и
 * есть ключ.
 */

const key = (over: Partial<SearchCacheKey> = {}): SearchCacheKey => ({
  call: 'search',
  query: 'q',
  files: ['a.ts'],
  versions: ['1:10'],
  tree: 't1',
  limit: 50,
  ...over,
});

describe('хранилище', () => {
  it('отдаёт то, что положили, и считает попадания', () => {
    const cache = new SearchCache();
    cache.set(key(), { ok: true }, 100);
    expect(cache.get(key())).toEqual({ ok: true });
    expect(cache.stats()).toEqual({ hits: 1, misses: 0, savedChars: 100 });
  });

  it('другой запрос — промах', () => {
    const cache = new SearchCache();
    cache.set(key(), { ok: true }, 100);
    expect(cache.get(key({ query: 'другой' }))).toBeUndefined();
    expect(cache.stats().hits).toBe(0);
  });

  it('вытесняет самый давний, попадание оживляет запись', () => {
    const cache = new SearchCache(2);
    cache.set(key({ query: 'a' }), 'a', 1);
    cache.set(key({ query: 'b' }), 'b', 1);
    expect(cache.get(key({ query: 'a' }))).toBe('a');
    cache.set(key({ query: 'c' }), 'c', 1);
    expect(cache.get(key({ query: 'b' }))).toBeUndefined();
    expect(cache.get(key({ query: 'a' }))).toBe('a');
  });

  it('правка файла забывает ответы, где он был', () => {
    const cache = new SearchCache();
    cache.set(key({ query: 'a', files: ['a.ts'] }), 'a', 1);
    cache.set(key({ query: 'b', files: ['b.ts'] }), 'b', 1);
    cache.forgetFile('a.ts');
    expect(cache.get(key({ query: 'a', files: ['a.ts'] }))).toBeUndefined();
    expect(cache.get(key({ query: 'b', files: ['b.ts'] }))).toBe('b');
  });
});

describe('search с кэшем', () => {
  let dir: string;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-search-cache-'));
    await fs.writeFile(path.join(dir, 'a.ts'), 'const needle = 1;\n', 'utf8');
    await fs.writeFile(path.join(dir, 'b.ts'), 'const other = 2;\n', 'utf8');
    workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
  });

  afterEach(async () => {
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const search = (query: string) =>
    runTool({ workspace } as unknown as ToolContext, 'search', JSON.stringify({ query }));

  it('повторный запрос берётся из кэша', async () => {
    const before = searchCacheStats();
    await search('needle');
    await search('needle');
    const after = searchCacheStats();
    expect(after.hits - before.hits).toBe(1);
    expect(after.savedChars - before.savedChars).toBeGreaterThan(0);
  });

  it('правка файла — ответ пересчитан', async () => {
    await search('needle');
    await fs.writeFile(path.join(dir, 'a.ts'), 'const needle = 1;\nconst needle2 = 2;\n', 'utf8');
    const before = searchCacheStats();
    const outcome = await search('needle');
    expect(outcome.ok).toBe(true);
    expect(searchCacheStats().hits - before.hits).toBe(0);
  });

  it('правка чужого файла кэш не сбрасывает', async () => {
    await search('needle');
    await fs.writeFile(path.join(dir, 'b.ts'), 'const other = 3;\n', 'utf8');
    const before = searchCacheStats();
    await search('needle');
    expect(searchCacheStats().hits - before.hits).toBe(1);
  });
});
