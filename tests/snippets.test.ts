import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { SNIPPETS_MAX, queryWords, rankSnippets, scoreSnippet, snippetOf } from '../src/main/ai/snippets';
import type { SearchSymbol } from '../src/shared/code-search';

/**
 * Подбор фрагментов под задачу (п.66).
 *
 * Между «вот 12 мест с этим словом» и рабочим контекстом у модели два-три
 * лишних `read`. `snippets` достаёт тела найденных объявлений и ранжирует их:
 * имя решает больше тела, короткий фрагмент плотнее.
 */

/** Языковой сервер в тестах: только то, что нужно `search action: code`. */
const mockSymbols = {
  projectSymbols: async () => [
    { name: 'readFile', kind: 'function', container: null, path: 'reader.ts', line: 1, column: 0 },
    { name: 'other', kind: 'function', container: null, path: 'reader.ts', line: 5, column: 0 },
  ],
};

const sym = (over: Partial<SearchSymbol> = {}): SearchSymbol => ({
  name: 'readFile',
  kind: 'function',
  container: null,
  path: 'src/main/ai/agent-read.ts',
  line: 1,
  column: 0,
  ...over,
});

describe('слова запроса', () => {
  it('делит camelCase и отбрасывает короткое', () => {
    expect(queryWords('readFile by path')).toEqual(['read', 'file', 'by', 'path']);
    expect(queryWords('a b')).toEqual([]);
  });
});

describe('оценка', () => {
  it('точное имя выше началом, начало выше вхождения', () => {
    const exact = scoreSnippet(sym(), 'function readFile() {}', 'readFile');
    const prefix = scoreSnippet(sym({ name: 'readFiles' }), 'function readFiles() {}', 'readFile');
    const inside = scoreSnippet(sym({ name: 'openReadFile' }), 'x', 'readFile');
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(inside.score);
  });

  it('слова в теле добавляют, но меньше имени', () => {
    const byName = scoreSnippet(sym({ name: 'unrelated' }), 'ничего', 'readFile');
    const byBody = scoreSnippet(sym({ name: 'unrelated' }), 'const read = file();', 'readFile');
    expect(byBody.score).toBeGreaterThan(byName.score);
  });

  it('короткий фрагмент плотнее длинного', () => {
    const short = scoreSnippet(sym(), 'x'.repeat(100), 'readFile');
    const long = scoreSnippet(sym(), 'x'.repeat(1400), 'readFile');
    expect(short.score).toBeGreaterThan(long.score);
  });

  it('причина названа словами', () => {
    expect(scoreSnippet(sym(), 'x', 'readFile').why).toContain('имя');
  });
});

describe('тело объявления', () => {
  const lines = ['function readFile() {', '  const a = 1;', '}', '', 'function other() {', '  return 2;', '}'];

  it('берёт от объявления до пустой строки', () => {
    const text = snippetOf(lines, sym({ line: 1 }), sym({ line: 5, name: 'other' }));
    expect(text).toBe('function readFile() {\n  const a = 1;');
  });

  it('без следующего объявления — до конца файла', () => {
    const text = snippetOf(lines, sym({ line: 5, name: 'other' }), undefined);
    expect(text).toContain('return 2;');
  });
});

describe('отбор', () => {
  it('лучшее первым, лимит соблюдён', () => {
    const candidates = [
      { symbol: sym({ name: 'zzz', path: 'b.ts', line: 1 }), text: 'x' },
      { symbol: sym({ name: 'readFile', path: 'a.ts', line: 1 }), text: 'y' },
    ];
    const picked = rankSnippets(candidates, 'readFile', 1);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.symbol.name).toBe('readFile');
  });

  it('равные оценки сортируются по пути — ответ устойчив', () => {
    const candidates = [
      { symbol: sym({ name: 'x', path: 'b.ts', line: 1 }), text: 'same' },
      { symbol: sym({ name: 'x', path: 'a.ts', line: 1 }), text: 'same' },
    ];
    expect(rankSnippets(candidates, 'q').map((s) => s.symbol.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('лимит не выходит за SNIPPETS_MAX', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      symbol: sym({ name: `f${index}`, line: index + 1 }),
      text: 't',
    }));
    expect(rankSnippets(many, 'q', 100).length).toBe(SNIPPETS_MAX);
  });
});

describe('search action: code со snippets', () => {
  let dir: string;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-snippets-'));
    await fs.writeFile(
      path.join(dir, 'reader.ts'),
      [
        'export function readFile(ctx: unknown): number {',
        '  return 1;',
        '}',
        '',
        'export function other(): number {',
        '  return 2;',
        '}',
      ].join('\n'),
      'utf8',
    );
    workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
  });

  afterEach(async () => {
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({ workspace, root: dir, symbols: mockSymbols }) as unknown as ToolContext;

  it('отдаёт тело объявления, а не только строку объявления', async () => {
    const outcome = await runTool(
      ctx(),
      'search',
      JSON.stringify({ action: 'code', query: 'readFile', snippets: true }),
    );
    const detail = String(outcome.detail);
    expect(detail).toContain('reader.ts:1 — function readFile');
    expect(detail).toContain('return 1;');
    expect(detail).not.toContain('return 2;');
  });

  it('без сервера символов — фрагменты из текстовых совпадений', async () => {
    const outcome = await runTool(
      { workspace, root: dir } as unknown as ToolContext,
      'search',
      JSON.stringify({ action: 'code', query: 'other', snippets: true }),
    );
    // Контекст без `symbols`: объявления берутся из текста, а сервер нужен только
    // для тел. Их не прочитать — так и сказано, а совпадение остаётся видно.
    expect(String(outcome.detail)).toContain('Языкового сервера нет');
    // Совпадение в тексте — `other()`, и его тело взято целиком.
    expect(String(outcome.detail)).toContain('return 2;');
    expect(String(outcome.detail)).not.toContain('return 1;');
  });
});
