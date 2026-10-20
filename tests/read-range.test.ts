import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

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
    expect(outcome.read).toEqual({ path: file, from: 1, to: 6 });
  });

  it('диапазон читает ровно запрошенные строки', async () => {
    const outcome = await run({ path: file, startLine: 2, endLine: 4 });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('вторая');
    expect(outcome.detail).not.toContain('первая');
    expect(outcome.read).toEqual({ path: file, from: 2, to: 4 });
  });

  it('конец за концом файла зажимается: «3–999» это «от третьей до конца»', async () => {
    const outcome = await run({ path: file, startLine: 3, endLine: 999 });
    expect(outcome.ok).toBe(true);
    expect(outcome.read).toEqual({ path: file, from: 3, to: 6 });
  });

  it('начало за концом файла: отказ, который называет конец файла', async () => {
    const outcome = await run({ path: file, startLine: 99, endLine: 120 });
    expect(outcome.ok).toBe(false);
    // Раньше здесь было «диапазон 99–6 вне файла» — начало больше конца, читать нечего.
    expect(outcome.summary).toContain('начало диапазона 99');
    expect(outcome.summary).toContain('строк: 6');
    expect(outcome.detail).toContain('file_outline');
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

describe('read: номера строк пришли строками', () => {
  it('«2»–«4» читают вторую–четвёртую строку, а не весь файл', async () => {
    const outcome = await run({ path: file, startLine: '2', endLine: '4' });
    expect(outcome.ok).toBe(true);
    expect(outcome.read).toEqual({ path: file, from: 2, to: 4 });
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
    expect(outcome.read).toEqual({ path: file, from: 1, to: 3 });
  });
});
