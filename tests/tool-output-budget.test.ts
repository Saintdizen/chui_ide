import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTool } from '../src/main/ai/agent-tools';
import { MAX_OUTPUT_CHARS, STEP_OUTPUT_CHARS, stepOutputChars, toolOutputChars } from '../src/main/ai/output-budget';
import { TOOL_OUTPUT_CHARS } from '../src/main/ai/output-budget';
import { AGENT_TOOLS } from '../src/shared/tools';
import type { ToolContext } from '../src/main/ai/tool-context';
import { WorkspaceService } from '../src/main/workspace/workspace';
import type { WebFetchRunner } from '../src/main/ai/tool-context';
import { estimateTextTokens } from '../src/shared/context-fit';

/**
 * Бюджет ответов читающих инструментов — на настоящих файлах проекта, с числами.
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

const SOURCE_ROOT = process.cwd();
let ROOT = '';
let workspace: WorkspaceService;
const rows: string[] = [];
const sizes = new Map<string, number>();

beforeAll(async () => {
  // Корень — временное зеркало исходников, не сам проект: 885 МБ `node_modules`
  // в корне заставляет `fs.watch(recursive)` перебирать их при каждом `open`
  // (~440 мс). Цена ответов зависит от ФОРМЫ кода, а не от его веса — те же
  // файлы под другим корнем дают те же числа. Слежение нужно только для
  // `search`/`list`/`read`: они идут мимо него.
  ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-budget-'));
  await fs.cp(path.join(SOURCE_ROOT, 'src'), path.join(ROOT, 'src'), { recursive: true });
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(ROOT);
});

afterAll(async () => {
  workspace.dispose();
  await fs.rm(ROOT, { recursive: true, force: true });
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
      // Пометка «обрезано» с путём к копии — ещё строка сверх потолка. Свой
      // потолок инструмента — то, до чего он реально ужимается: без него
      // таблица `TOOL_OUTPUT_CHARS` осталась бы объявленной и мёртвой.
      const cap = Math.min(toolOutputChars(name), MAX_OUTPUT_CHARS) + 500;
      expect(size, `${name}: ${size} символов (потолок ${cap})`).toBeLessThanOrEqual(cap);
    }
  }, 180_000);

  it('отказ режется общим пределом, а не потолком инструмента', async () => {
    // Потолки `checks: 8_000` и `run_tests: 12_000` ставились под объём вывода,
    // который читают с конца. Отказ читают с начала: `01_deploy.test.ts ✗` стоит
    // первой строкой при двух тысячах упавших. Резать его инструментным потолком —
    // значит отдать модели хвост вместо причины; общий предел (18 000) остаётся,
    // чтобы отказ не съел весь шаг.
    //
    // Отказ настоящий и заведомо длинный: `web fetch` без подключения к сети
    // доносит сообщение о сбое целиком, а адрес из двух тысяч символов делает это
    // сообщение длиннее любого инструментного потолка. Бюджет шага не снимаем —
    // проверяем именно потолок инструмента.
    const host = `${'a'.repeat(2_000)}.invalid`;
    const failed: WebFetchRunner = {
      fetch: async (url) => {
        throw new Error(`getaddrinfo ENOTFOUND ${url.replace('http://', '')}`);
      },
    };
    const context = {
      workspace,
      signal: new AbortController().signal,
      webFetch: failed,
    } as ToolContext;
    const outcome = await runTool(
      context,
      'web',
      JSON.stringify({ action: 'fetch', url: `http://${'a'.repeat(9_000)}.invalid/` }),
    );
    const text = outcome.ok ? (outcome.detail ?? outcome.summary ?? '') : (outcome.summary ?? '');

    rows.push(
      `отказ web:fetch ${text.length} симв. (потолок web ${toolOutputChars('web')}, общий ${MAX_OUTPUT_CHARS})`,
    );
    expect(outcome.ok).toBe(false);
    // Решающая строка: со старым кодом отказ режется до потолка `web` (8 000),
    // с новым доходит до общего (18 000). Сравниваем с инструментным потолком,
    // а не только с общим — иначе сторож проходил бы при любом коде.
    expect(text.length).toBeGreaterThan(toolOutputChars('web'));
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  }, 60_000);

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

  /**
   * Ключи `TOOL_OUTPUT_CHARS` — имена инструментов, а не их действий: `runTool`
   * и `clipOutcome` спрашивают потолок по имени. Ключ, переживший переименование,
   * не падает и не мигает — он молча перестаёт работать: `run` (когда команда
   * была действием `terminal`) висел в таблице, а настоящий шелл получал общий
   * предел 18 000 вместо 12 000 (вдвое дороже каждый вызов, до конца диалога).
   *
   * Поэтому сторож двусторонний: таблица не смеет знать несуществующих имён и
   * не смеет забывать существующие. Новый инструмент без строки — не ошибка
   * (общий предел честный), но пропажа уже объявленного — регрессия.
   */
  it('таблица потолков говорит об именах, которые существуют', () => {
    const names = new Set(AGENT_TOOLS.map((tool) => tool.name));
    const orphans = Object.keys(TOOL_OUTPUT_CHARS).filter((key) => !names.has(key));
    expect(orphans, `в TOOL_OUTPUT_CHARS нет таких инструментов: ${orphans.join(', ')}`).toEqual([]);

    // Объявленные однажды имена держатся: `terminal` — дорогой вывод процесса,
    // `edit`/`file`/`terminalList` — короткий отчёт, которому общий предел ни к чему.
    // `read` — исключение по смыслу: он и объявлен как `MAX_OUTPUT_CHARS`
    // (пачка файлов целиком), поэтому у него проверяется только наличие строки.
    expect(TOOL_OUTPUT_CHARS.read).toBe(MAX_OUTPUT_CHARS);
    for (const name of ['list', 'search', 'terminal', 'terminalOutput', 'checks', 'run_tests', 'edit', 'file']) {
      expect(names).toContain(name);
      expect(toolOutputChars(name), `${name} потерял свой потолок`).toBeLessThan(MAX_OUTPUT_CHARS);
    }
  });
});
