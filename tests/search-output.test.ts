import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHARS, runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Цена ответа поиска: предел выдачи и склейка контекста.
 *
 * `search` — самый дорогой читающий инструмент: замер на живом проекте до правок
 * давал 21 000 символов на запрос без контекста и 45 000 (упёршись в потолок) с
 * контекстом 2 — это 14 600 токенов за один шаг. Причин было две: предела выдачи
 * не существовало вовсе (всегда 200 совпадений, сколько бы ни просили), а блоки
 * контекста соседних совпадений печатались целиком, повторяя одни и те же строки.
 */

let dir: string | null = null;
let workspace: WorkspaceService | null = null;

afterEach(() => {
  workspace?.dispose();
  workspace = null;
  if (dir) fs.rm(dir, { recursive: true, force: true });
  dir = null;
});

/** Проект-заготовка: `files` файлов по `lines` строк, в каждой строке слово `needle`. */
async function project(files: number, lines: number, tail = ''): Promise<WorkspaceService> {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-search-cost-')));
  for (let file = 0; file < files; file += 1) {
    const rows = Array.from({ length: lines }, (_, index) => `строка ${file}-${index + 1}: needle ${tail}`);
    await fs.writeFile(path.join(dir, `f${file}.ts`), rows.join('\n'), 'utf8');
  }
  const created = new WorkspaceService(() => undefined);
  await created.open(dir);
  workspace = created;
  return created;
}

function context(ws: WorkspaceService): ToolContext {
  return { workspace: ws, signal: new AbortController().signal } as ToolContext;
}

function hits(detail: string): number {
  return detail.split('\n').filter((line) => line.includes('needle')).length;
}

describe('предел выдачи search', () => {
  it('limit работает и режет список', async () => {
    const ws = await project(6, 20);
    const small = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', limit: 5 }));
    const large = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', limit: 40 }));

    expect(hits(small.detail ?? '')).toBe(5);
    expect(hits(large.detail ?? '')).toBeGreaterThan(hits(small.detail ?? ''));
    expect(hits(large.detail ?? '')).toBeLessThanOrEqual(40);
  });

  it('без limit выдача тоже ограничена, а не «сколько нашлось»', async () => {
    const ws = await project(40, 20);
    const outcome = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle' }));
    // Потолок на файл даёт 10 записей из файла; общий предел — сто.
    expect(hits(outcome.detail ?? '')).toBeLessThan(120);
  });

  it('с контекстом умолчание ниже: блок из пяти строк дороже строки', async () => {
    const ws = await project(40, 20);
    const plain = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle' }));
    const withContext = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', context: 2 }));
    expect(hits(withContext.detail ?? '')).toBeLessThan(hits(plain.detail ?? ''));
  });
});

describe('контекст вокруг совпадений', () => {
  it('перекрывающиеся блоки печатаются один раз, а не дважды', async () => {
    // Совпадения в каждой строке: блоки контекста перекрываются полностью.
    const ws = await project(1, 12);
    const outcome = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', context: 2, limit: 12 }));
    const detail = outcome.detail ?? '';

    // Каждая строка файла встречается в выводе не больше одного раза.
    for (let line = 1; line <= 12; line += 1) {
      const seen = detail.split('\n').filter((row) => row.includes(`строка 0-${line}:`)).length;
      expect(seen, `строка ${line} напечатана ${seen} раз`).toBeLessThanOrEqual(1);
    }
  });

  it('совпадение помечено двоеточием, соседние строки — дефисом', async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-search-cost-')));
    // Совпадение ровно одно и в окружении: иначе все строки — совпадения, и
    // вид соседней строки проверить не на чем.
    await fs.writeFile(
      path.join(dir, 'one.ts'),
      ['первая', 'вторая', 'тут needle', 'четвёртая', 'пятая'].join('\n'),
      'utf8',
    );
    const ws = new WorkspaceService(() => undefined);
    await ws.open(dir);
    workspace = ws;

    const detail = (await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', context: 1 }))).detail ?? '';
    const rows = detail.split('\n').filter((row) => /^\d+[:-] /.test(row));
    expect(rows).toContain('3: тут needle');
    expect(rows).toContain('2- вторая');
    expect(rows).toContain('4- четвёртая');
  });
});

describe('общий потолок вывода', () => {
  it('filesOnly отдаёт только запрошенное число путей и называет остаток', async () => {
    const ws = await project(40, 5);
    const detail =
      (await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', filesOnly: true, limit: 10 }))).detail ??
      '';
    const paths = detail.split('\n').filter((row) => row.startsWith('f'));
    expect(paths).toHaveLength(10);
    // Остаток назван числом: иначе модель решит, что файлов ровно десять.
    expect(detail).toMatch(/ещё файлов: 30/);
  });
  it('ни один инструмент не отдаёт больше MAX_OUTPUT_CHARS', async () => {
    // Строки по 400 символов — потолок строки в поиске: один вызов иначе давал
    // до сотни тысяч символов, и шаг переполнялся с одного инструмента.
    const ws = await project(30, 30, 'шум'.repeat(200));
    const outcome = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', context: 0 }));
    expect((outcome.detail ?? '').length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 400);
  });
});

describe('путь в выдаче search', () => {
  it('без контекста путь идёт заголовком файла, а не в каждой строке', async () => {
    const ws = await project(2, 5);
    const out = await runTool(context(ws), 'search', JSON.stringify({ query: 'needle', limit: 10 }));
    const detail = out.detail ?? '';
    const lines = detail.split('\n');
    const heads = lines.filter((line) => line.startsWith('f0.ts') || line.startsWith('f1.ts'));
    // По одному заголовку на файл: повтор пути на каждом совпадении стоил 11%
    // выдачи, а совпадений в одном файле обычно много.
    expect(heads).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith('  '))).toHaveLength(hits(detail));
  });
});
