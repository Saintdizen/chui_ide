import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_OUTPUT_CHARS,
  STEP_OUTPUT_CHARS,
  runTool,
  stepOutputChars,
  type ToolContext,
} from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { estimateTextTokens } from '../src/shared/context-fit';

/**
 * Бюджет ответов читающих инструментов — на настоящем проекте, с числами.
 *
 * Сторож держит не отдельный инструмент, а свойство: ответ одного вызова не
 * может перевалить за `MAX_OUTPUT_CHARS`. До правок это соблюдали только чтение
 * файлов и вывод команд: `search` с контекстом отдавал 45 000 символов
 * (≈14 600 токенов) за шаг, а предел выдачи у него вообще не существовал —
 * двести совпадений при любом запросе.
 *
 * Числа печатаются всегда: цена ответа — это то, что видно только замером.
 * Пороги держим широкими (сам потолок, а не сегодняшнее значение): проект
 * растёт, и сторож обязан ловить не прирост кода, а возврат к прежнему
 * «сколько нашлось — столько и отдадим».
 */

const ROOT = process.cwd();
let workspace: WorkspaceService;
const rows: string[] = [];
const sizes = new Map<string, number>();

beforeAll(async () => {
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(ROOT);
});

afterAll(() => {
  workspace.dispose();
  console.log(rows.join('\n'));
});

async function measure(name: string, args: Record<string, unknown>): Promise<string> {
  const context = { workspace, signal: new AbortController().signal } as ToolContext;
  const outcome = await runTool(context, name, JSON.stringify(args));
  const detail = outcome.detail ?? outcome.summary ?? '';
  sizes.set(name, detail.length);
  rows.push(
    `${(outcome.ok ? '' : 'ОШИБКА ') + name} ${JSON.stringify(args).slice(0, 54).padEnd(56)} ` +
      `${String(detail.length).padStart(6)} симв. ${String(estimateTextTokens(detail)).padStart(6)} ток.`,
  );
  return detail;
}

describe('бюджет ответов инструментов', () => {
  it('ни один читающий инструмент не отдаёт больше потолка одного вызова', async () => {
    await measure('project_map', {});
    await measure('list', { path: path.join(ROOT, 'src/main/ai') });
    await measure('list', { glob: '**/*.ts', limit: 200 });
    await measure('search', { query: 'export function' });
    await measure('search', { query: 'export function', context: 2 });
    await measure('search', { query: 'export function', filesOnly: true });
    await measure('read', { path: path.join(ROOT, 'src/main/ai/service.ts') });
    await measure('read', {
      paths: [path.join(ROOT, 'src/shared/tool-presets.ts'), path.join(ROOT, 'src/shared/agent-prompt.ts')],
    });

    for (const [name, size] of sizes) {
      // Пометка «обрезано» с путём к копии — ещё строка сверх потолка.
      expect(size, `${name}: ${size} символов`).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 500);
    }
  }, 180_000);

  it('умолчания поиска не возвращаются к «сколько нашлось»', async () => {
    // Верхняя граница именно для умолчаний: предел выдачи и склейка блоков
    // контекста держат ответ на порядок ниже потолка вызова. Если кто-то вернёт
    // двести совпадений или блочный контекст без склейки — этот порог сработает.
    const plain = sizes.get('search') ?? 0;
    expect(plain).toBeLessThan(30_000);
  });
});

describe('структурные инструменты', () => {
  // Символы подставные, форма ответа настоящая: цена зависит от формы, а не от
  // того, настоящий ли языковой сервер. Без этого `file_outline` и
  // `codebase_search` (самые «многословные» из читающих) оставались вне сторожа.
  const many = (n: number) =>
    Array.from({ length: n }, (_, index) => ({
      name: `symbol${index}`,
      kind: 'функция',
      line: index * 10 + 1,
      endLine: index * 10 + 8,
      children: [] as never[],
    }));
  const symbols = {
    projectSymbols: async () =>
      many(60).map((item, i) => ({ ...item, path: path.join(ROOT, `src/file${i}.ts`) })) as never,
    languageFor: () => 'typescript',
    outline: async () => many(120) as never,
  };

  it('скелет файла и поиск объявлений тоже укладываются в потолок', async () => {
    const context = { workspace, symbols, signal: new AbortController().signal } as unknown as ToolContext;
    for (const args of [
      { path: path.join(ROOT, 'src/main/ai/service.ts') },
      { path: path.join(ROOT, 'src/shared/tools.ts') },
    ]) {
      const outcome = await runTool(context, 'lsp', JSON.stringify({ ...args, action: 'outline' }));
      const detail = outcome.detail ?? outcome.summary ?? '';
      expect(detail.length, `lsp outline: ${detail.length}`).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 500);
    }
    const found = await runTool(context, 'codebase_search', JSON.stringify({ query: 'readFile' }));
    expect((found.detail ?? '').length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 500);
  }, 180_000);
});

describe('новые пределы выдачи', () => {
  it('хвост о неполном списке виден модели', async () => {
    const context = { workspace, signal: new AbortController().signal } as ToolContext;
    const out = await runTool(context, 'search', JSON.stringify({ query: 'export function' }));
    // `summary` модель в контексте не видит: без этой строки обрезанный список
    // читается как «больше нигде нет».
    expect(out.detail ?? '').toContain('список неполный');
    expect(out.detail ?? '').toContain('limit');
  }, 60_000);

  it('файл в пачке режется по границе строки и называет продолжение', async () => {
    const context = { workspace, signal: new AbortController().signal } as ToolContext;
    const out = await runTool(
      context,
      'read',
      JSON.stringify({ paths: [path.join(ROOT, 'src/main/ai/service.ts'), path.join(ROOT, 'src/shared/tools.ts')] }),
    );
    const detail = out.detail ?? '';
    expect(detail).toContain('дальше read с диапазоном');
    expect(detail.length).toBeLessThan(20_000);
  }, 60_000);
});

describe('бюджет шага под окно модели', () => {
  it('полный потолок — только на большом окне', () => {
    expect(stepOutputChars(200_000)).toBe(STEP_OUTPUT_CHARS);
    // На окне 32k шаг больше не съедает половину контекста.
    expect(stepOutputChars(32_000)).toBeLessThan(20_000);
    expect(stepOutputChars(32_000)).toBeGreaterThanOrEqual(6_000);
    // Совсем маленькое окно не обнуляет ответ инструмента.
    expect(stepOutputChars(1_000)).toBe(6_000);
  });
});
