import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Поиск с контекстом — как `-A`/`-B` у grep.
 *
 * Смысл проверок в том, ради чего контекст и добавлен: агент получает окружение
 * совпадения сразу и не делает следом отдельный `read`. Поэтому проверяем и
 * сами строки, и то, что номера в выводе — те же номера, что у `read`.
 *
 * Две роли строк видны по знаку: `N: текст` — совпадение (текст без отступов,
 * как и раньше), `N- текст` — соседняя строка (отступы сохранены: по ним видно
 * блок, к которому совпадение относится).
 */

let dir: string;
let workspace: WorkspaceService;

const FILE = `export function load(path) {
  const text = readFile(path);
  // Проверяем, что файл не пустой.
  if (!text) throw new Error('пустой файл');
  return text;
}
`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-search-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/loader.js'), FILE, 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const context = (): ToolContext => ({ workspace }) as unknown as ToolContext;

/** Найти в выводе строку по её тексту; null — её там нет. */
function lineContaining(detail: unknown, needle: string): string | null {
  return (
    String(detail)
      .split('\n')
      .find((line) => line.includes(needle)) ?? null
  );
}

/** Номера строк из блока вывода: `  12: текст` и `  13- текст`. */
function lineNumbers(detail: unknown): number[] {
  const numbers: number[] = [];
  for (const line of String(detail).split('\n')) {
    const match = /^\s*(\d+)[:-]/.exec(line);
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}

describe('search с контекстом', () => {
  it('без context совпадение — одна строка, как раньше', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'throw new Error' }));

    expect(outcome.ok).toBe(true);
    // Без контекста путь тоже идёт заголовком файла, а не в каждой строке:
    // повтор пути на каждом совпадении стоил 11% выдачи.
    expect(String(outcome.detail)).toContain('src/loader.js\n  4: ');
    // Соседних строк нет: без контекста вывод остаётся прежним.
    expect(String(outcome.detail)).not.toContain('readFile(path)');
  });

  it('с context рядом видны соседние строки — отдельный read не нужен', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'throw new Error', context: 2 }));

    // Строка совпадения и её окружение — в одном ответе. Текст совпадения без
    // отступов (так было и раньше), соседние строки — как в файле.
    expect(lineContaining(outcome.detail, 'throw new Error')).toContain('4: if (!text) throw new Error');
    expect(lineContaining(outcome.detail, 'readFile(path)')).toBe('2-   const text = readFile(path);');
    expect(lineContaining(outcome.detail, 'return text;')).toBe('5-   return text;');
  });

  it('номера строк в выводе те же, что у read', async () => {
    const file = path.join(dir, 'src/loader.js');
    const read = await runTool(context(), 'read', JSON.stringify({ path: file, startLine: 1, endLine: 6 }));
    // read с диапазоном нумерует строки сам — сверим номера двух инструментов.
    expect(String(read.detail)).toContain('2 |   const text = readFile(path);');

    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'readFile', context: 1 }));
    expect(lineContaining(outcome.detail, 'readFile(path)')).toMatch(/^2:/);
  });

  it('путь печатается заголовком один раз, а не в каждой строке блока', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'text', context: 2 }));
    const occurrences = String(outcome.detail).split('src/loader.js').length - 1;
    expect(occurrences).toBe(1);
  });

  it('отступы в контексте сохранены: по ним видно блок', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'return text', context: 1 }));
    expect(lineContaining(outcome.detail, 'return text;')).toContain(': return text;');
    expect(lineContaining(outcome.detail, 'throw new Error')).toBe("4-   if (!text) throw new Error('пустой файл');");
  });

  it('context сверх потолка не раздувает вывод', async () => {
    // Пять совпадений по одному слову: без потолка каждый блок тянул бы весь файл.
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'text', context: 50 }));
    for (const block of String(outcome.detail).split('\n\n')) {
      // Первая строка блока — путь, дальше строки: не больше потолка 5 + 1 + 5.
      expect(block.split('\n').length - 1).toBeLessThanOrEqual(11);
    }
  });

  it('filesOnly игнорирует контекст: там одна строка на файл', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'text', filesOnly: true, context: 3 }));
    expect(String(outcome.detail).trim()).toBe('src/loader.js');
  });

  it('без совпадений называет запрос и условия, которые можно ослабить', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'нет-такого', context: 3, glob: 'src/**' }));
    expect(String(outcome.detail)).toContain('Совпадений нет: «нет-такого»');
    expect(String(outcome.detail)).toContain('маска src/**');
  });
});

describe('search: границы файла', () => {
  it('в начале файла контекст не уходит в минус', async () => {
    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'export function', context: 2 }));

    expect(Math.min(...lineNumbers(outcome.detail))).toBe(1);
  });

  it('в конце файла контекст не выходит за пределы, которые знает read', async () => {
    const file = path.join(dir, 'src/loader.js');
    const read = await runTool(context(), 'read', JSON.stringify({ path: file }));
    // «путь: N строк» — столько строк знает read; столько же должен знать поиск.
    const total = Number(/(\d+) строк/.exec(String(read.summary))?.[1]);

    const outcome = await runTool(context(), 'search', JSON.stringify({ query: 'return text', context: 3 }));
    expect(Math.max(...lineNumbers(outcome.detail))).toBeLessThanOrEqual(total);
  });
});
