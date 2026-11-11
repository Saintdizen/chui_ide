import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksLikeFileName, pickFileByQuery } from '../src/main/ai/agent-search';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Smart-режим поиска (п.62): запрос = имя файла — отдаём файл, а не совпадения.
 *
 * Поиск по слову с точкой (`agent-read.ts`) идёт за файлом, а возвращает пару
 * строк из документации. Модель лечит это ещё одним шагом — `read` по угаданному
 * пути. Один шаг вместо двух — и без угадывания.
 */

let dir: string;
let workspace: WorkspaceService;

const SAMPLE = [
  'export async function readFile(ctx: unknown): Promise<void> {',
  '  if (ctx) {',
  '    go();',
  '  }',
  '}',
  '',
  'export function helper(): number {',
  '  return 1;',
  '}',
].join('\n');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-smart-search-'));
  await fs.mkdir(path.join(dir, 'src/main/ai'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/main/ai/agent-read.ts'), SAMPLE, 'utf8');
  await fs.writeFile(path.join(dir, 'src/util.ts'), 'export const util = 1;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src/util.test.ts'), 'export const test = 1;\n', 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const search = (args: Record<string, unknown>) =>
  runTool({ workspace } as unknown as ToolContext, 'search', JSON.stringify(args));

describe('имя файла как запрос', () => {
  it('отличает имя от текста', () => {
    expect(looksLikeFileName('agent-read.ts')).toBe(true);
    expect(looksLikeFileName('service')).toBe(true);
    expect(looksLikeFileName('см. agent-read.ts')).toBe(false);
    expect(looksLikeFileName('read.*')).toBe(false);
    expect(looksLikeFileName('  ')).toBe(false);
  });

  it('расширение в запросе важнее базы: util.ts не тянет util.test.ts', () => {
    const files = ['src/util.ts', 'src/util.test.ts'];
    expect(pickFileByQuery(files, 'util.ts')).toBe('src/util.ts');
    // Без расширения подходят оба — не угадываем.
    expect(pickFileByQuery(files, 'util')).toBeUndefined();
    expect(pickFileByQuery(['src/util.ts'], 'util')).toBe('src/util.ts');
  });

  it('несколько совпадений — не угадываем', () => {
    expect(pickFileByQuery(['a/x.ts', 'b/x.ts'], 'x.ts')).toBeUndefined();
  });

  it('поиск по имени файла отдаёт каркас файла', async () => {
    const outcome = await search({ query: 'agent-read.ts' });
    expect(outcome.ok).toBe(true);
    expect(String(outcome.summary)).toContain('файл по запросу');
    const detail = String(outcome.detail);
    expect(detail).toContain('совпал с именем файла');
    expect(detail).toContain('readFile');
    expect(detail).not.toContain('go();');
  });

  it('обычный запрос идёт прежним путём', async () => {
    const outcome = await search({ query: 'return 1' });
    expect(String(outcome.detail)).toContain('return 1');
    expect(String(outcome.detail)).not.toContain('совпал с именем файла');
  });

  it('filesOnly smart-режим не трогает', async () => {
    const outcome = await search({ query: 'agent-read.ts', filesOnly: true });
    expect(String(outcome.detail)).not.toContain('совпал с именем файла');
  });

  it('имя не найдено — обычный поиск, без выдумки', async () => {
    const outcome = await search({ query: 'нет-такого.ts' });
    expect(String(outcome.detail)).not.toContain('совпал с именем файла');
  });

  it('limit больше потолка не обещает «увеличьте limit» впустую', async () => {
    // Потолок держит workspace (MAX_SEARCH_RESULTS), агент передаёт limit как
    // есть. Сравнивать files.length с н е з а ж а т ы м limit — значит советовать
    // «увеличьте limit» там, где увеличивать уже нечего.
    const outcome = await search({ query: 'util', filesOnly: true, limit: 5000 });
    const detail = String(outcome.detail);
    expect(detail).not.toContain('увеличьте limit');
  });

  it('limit строкой — тот же лимит, а не вежливое игнорирование', async () => {
    const wide = await search({ query: 'util', filesOnly: true, limit: '1' });
    const narrow = await search({ query: 'util', filesOnly: true, limit: 1 });
    expect(String(wide.detail)).toBe(String(narrow.detail));
  });
});
