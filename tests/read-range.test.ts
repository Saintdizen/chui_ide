import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { rememberRead, uncoveredRequest } from '../src/shared/read-coverage';

/**
 * Чтение файла диапазоном: границы и разбор аргументов.
 *
 * Два повода, оба из живых ошибок.
 *
 * Первый: начало за концом файла. Отказ правильный (файл короче, чем думает
 * спросивший), но сообщение было бессмысленным — «диапазон 99–6 вне файла»,
 * где начало больше конца. Теперь отказ называет, что именно не так.
 *
 * Второй, и он важнее: номера строк, пришедшие СТРОКОЙ («2»), отбрасывались как
 * «аргумента нет», и читался весь файл вместо запрошенного куска. Молчаливый
 * промах: и контекст расходуется зря, и в ответе не то, что просили.
 */

let dir: string;
let workspace: WorkspaceService;
let file: string;

/** Файл из пяти строк: границы видно с одного взгляда. */
const LINES = ['первая', 'вторая', 'третья', 'четвёртая', 'пятая'];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-read-range-'));
  file = path.join(dir, 'sample.txt');
  await fs.writeFile(file, `${LINES.join('\n')}\n`, 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const context = (): ToolContext => ({ workspace }) as unknown as ToolContext;
const run = (args: Record<string, unknown>) => runTool(context(), 'read', JSON.stringify(args));

describe('read: границы диапазона', () => {
  it('без диапазона читает файл целиком и помечает прочитанное', async () => {
    const outcome = await run({ path: file });
    expect(outcome.ok).toBe(true);
    // Пять строк содержимого плюс последняя пустая: так же считает редактор в жёлобе.
    expect(outcome.summary).toContain('6 строк');
    expect(outcome.read).toMatchObject({ path: file, from: 1, to: 6 });
  });

  it('диапазон читает ровно запрошенные строки', async () => {
    const outcome = await run({ path: file, startLine: 2, endLine: 4 });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('вторая');
    expect(outcome.detail).not.toContain('первая');
    expect(outcome.read).toMatchObject({ path: file, from: 2, to: 4 });
  });

  it('конец за концом файла зажимается: «3–999» это «от третьей до конца»', async () => {
    const outcome = await run({ path: file, startLine: 3, endLine: 999 });
    expect(outcome.ok).toBe(true);
    expect(outcome.read).toMatchObject({ path: file, from: 3, to: 6 });
  });

  it('начало за концом файла: отказ, который называет конец файла', async () => {
    const outcome = await run({ path: file, startLine: 99, endLine: 120 });
    expect(outcome.ok).toBe(false);
    // Раньше здесь было «диапазон 99–6 вне файла» — начало больше конца, читать нечего.
    expect(outcome.summary).toContain('начало диапазона 99');
    expect(outcome.summary).toContain('строк: 6');
    expect(outcome.detail).toContain('lsp, action: outline');
  });

  it('конец раньше начала — отдельный отказ, а не «вне файла»', async () => {
    const outcome = await run({ path: file, startLine: 4, endLine: 2 });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('конец диапазона 2 раньше начала 4');
  });

  it('только startLine за концом файла — тот же отказ', async () => {
    const outcome = await run({ path: file, startLine: 99 });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('за концом файла');
  });
});

describe('read: покрытие обрезанного вывода', () => {
  it('помнит полный показанный префикс и продолжает с первой невидимой строки', async () => {
    const lines = Array.from({ length: 600 }, (_, index) => `строка${index + 1}: ${'value '.repeat(15)}`);
    await fs.writeFile(file, lines.join('\n'));
    const outcome = await run({ path: file, startLine: 1, endLine: 600 });
    expect(outcome.read).toBeDefined();
    const read = outcome.read!;
    expect(read.to).toBeGreaterThan(20);
    expect(read.to).toBeLessThan(600);
    expect(read.eof).not.toBe(true);
    expect(outcome.detail).toContain(`${read.to} | ${lines[read.to - 1]}`);
    expect(outcome.detail).not.toContain(`${read.to + 1} |`);
    expect(outcome.detail).toContain(`startLine с ${read.to + 1}`);
    const coverage = new Map();
    rememberRead(coverage, read);
    const next = uncoveredRequest('read', JSON.stringify({ path: file, startLine: 1, endLine: 600 }), coverage);
    expect(next?.from).toBe(read.to + 1);
  });

  it('повтор файла в другой пачке продолжает хвост, а изменившийся файл читает сначала', async () => {
    await fs.writeFile(file, Array.from({ length: 400 }, (_, i) => `line${i + 1} ${'x'.repeat(80)}`).join('\n'));
    const coverage = new Map();
    const ctx = { workspace, coveredReads: coverage } as ToolContext;
    const first = await runTool(ctx, 'read', JSON.stringify({ paths: [file] }));
    const before = first.reads![0]!;
    expect(before.to).toBeGreaterThan(20);
    rememberRead(coverage, before);
    const next = await runTool(ctx, 'read', JSON.stringify({ paths: [file] }));
    expect(next.reads![0]!.from).toBe(before.to + 1);
    expect(next.detail).not.toContain('1 | line1 ');
    await fs.writeFile(file, 'changed file\n');
    const changed = await runTool(ctx, 'read', JSON.stringify({ paths: [file] }));
    expect(changed.detail).toContain('1 | changed file');
    expect(changed.reads![0]!.from).toBe(1);
  });

  it('очень длинную первую строку не объявляет прочитанной', async () => {
    await fs.writeFile(file, `${'я'.repeat(30_000)}\nnext`);
    const outcome = await run({ path: file, startLine: 1, endLine: 2 });
    expect(outcome.read).toBeUndefined();
    expect(outcome.detail).toContain('строка 1 показана частично');
    expect(outcome.detail).toContain('startLine с 1');
  });

  it('пачка помнит частичные файлы, но не скрытые строки', async () => {
    await fs.writeFile(file, Array.from({ length: 400 }, (_, i) => `line${i + 1} ${'x'.repeat(80)}`).join('\n'));
    const second = path.join(dir, 'second.txt');
    await fs.copyFile(file, second);
    const outcome = await run({ paths: [file, second] });
    expect(outcome.reads?.length).toBe(2);
    for (const read of outcome.reads!) {
      expect(read.to).toBeLessThan(400);
      expect(read.eof).toBe(false);
      const block = outcome.detail!.split(`### ${path.basename(read.path)}`)[1]!.split('### ')[0]!;
      expect(block).toContain(`${read.to} | line${read.to} `);
      expect(block).not.toContain(`${read.to + 1} | line${read.to + 1} `);
    }
  });
});

describe('read: номера строк пришли строками', () => {
  it('«2»–«4» читают вторую–четвёртую строку, а не весь файл', async () => {
    const outcome = await run({ path: file, startLine: '2', endLine: '4' });
    expect(outcome.ok).toBe(true);
    expect(outcome.read).toMatchObject({ path: file, from: 2, to: 4 });
    expect(outcome.detail).toContain('вторая');
    expect(outcome.detail).not.toContain('первая');
  });

  it('дробный номер строки — отказ, а не чтение с начала файла', async () => {
    const outcome = await run({ path: file, startLine: 2.5, endLine: 4 });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('startLine');
    expect(outcome.summary).toContain('целый');
  });

  it('номер строки мусором — отказ с названным значением', async () => {
    const outcome = await run({ path: file, startLine: 'вторая', endLine: 4 });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('«вторая»');
  });

  it('endLine строкой без startLine читает до этой строки', async () => {
    const outcome = await run({ path: file, endLine: '3' });
    expect(outcome.ok).toBe(true);
    expect(outcome.read).toMatchObject({ path: file, from: 1, to: 3 });
  });
});

describe('read: повтор целого файла не платится второй раз', () => {
  /**
   * Первое чтение даёт текст, второе — только весточку, если файл не менялся.
   * Версия сверяется по `stat`: файл, поправленный мимо инструментов, повторяется.
   */
  it('второй полный read того же файла не тащит текст снова', async () => {
    const ctx = { workspace, coveredReads: new Map() } as unknown as ToolContext;
    const first = await runTool(ctx, 'read', JSON.stringify({ path: file }));
    expect(first.ok).toBe(true);
    const reads = (ctx as unknown as { coveredReads: Map<string, unknown> }).coveredReads;
    // Как это делает цикл: `runTool` покрытие только ЧИТАЕТ, запись — забота прогона.
    // `eof` обязателен: без него «файл прочитан до конца» неизвестно, и повтор разрешён.
    expect(first.read?.eof).toBe(true);
    if (first.read) rememberRead(reads as never, first.read);

    const second = await runTool(ctx, 'read', JSON.stringify({ path: file }));
    expect(second.ok).toBe(true);
    expect(second.summary).toContain('уже прочитано');
    expect(second.detail).not.toContain('третья');
    expect(second.detail).toContain('force: true');
  });

  it('изменённый файл читается заново', async () => {
    const ctx = { workspace, coveredReads: new Map() } as unknown as ToolContext;
    const first = await runTool(ctx, 'read', JSON.stringify({ path: file }));
    const reads = (ctx as unknown as { coveredReads: Map<string, unknown> }).coveredReads;
    for (const r of first.reads ?? []) rememberRead(reads as never, r);

    await fs.writeFile(file, `${LINES.join('\n')}\nшестая\n`, 'utf8');
    const second = await runTool(ctx, 'read', JSON.stringify({ path: file }));
    expect(second.detail).toContain('шестая');
  });

  it('range-запрос (startLine) не подавляется', async () => {
    const ctx = { workspace, coveredReads: new Map() } as unknown as ToolContext;
    const first = await runTool(ctx, 'read', JSON.stringify({ path: file }));
    const reads = (ctx as unknown as { coveredReads: Map<string, unknown> }).coveredReads;
    for (const r of first.reads ?? []) rememberRead(reads as never, r);

    const second = await runTool(ctx, 'read', JSON.stringify({ path: file, startLine: 1, endLine: 3 }));
    expect(second.detail).toContain('третья');
  });
});

describe('read: бюджет считается по чистому тексту, а не по номерам', () => {
  /**
   * Потолок вывода режется по тексту, и только потом ставится нумерация.
   * Раньше бюджет тратился на «1234 | » в каждой строке: длинный файл
   * обрезался заметно раньше, чем кончался сам текст.
   */
  it('в узком бюджете доезжает больше строк, чем съел бы запас на номера', async () => {
    const long = path.join(dir, 'long.txt');
    const lines = Array.from({ length: 4000 }, (_, index) => `строка ${index + 1} текста`);
    await fs.writeFile(long, `${lines.join('\n')}\n`, 'utf8');

    const withBudget = (chars: number) =>
      ({
        workspace,
        stepBudget: { left: chars, spent: 0, tokensLeft: chars / 3.5, tokensSpent: 0 },
      }) as unknown as ToolContext;
    const outcome = await runTool(withBudget(4000), 'read', JSON.stringify({ path: long }));
    expect(outcome.ok).toBe(true);
    expect(outcome.read?.to).toBeGreaterThan(60);
    expect(outcome.read?.to).toBeLessThan(4000);
    // Нумерация на месте — без неё нельзя назвать диапазон правки.
    expect(outcome.detail).toMatch(/^\s*1 \| /m);
    expect(outcome.detail).toContain('вывод обрезан');
  });
});
