import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * `git` инструментом (п.57): status, diff, log, blame, show — только чтение.
 *
 * Раньше git шёл через `terminal`: с `cd` впереди, без структуры и без потолка
 * вывода. Теперь у него своя форма ответа — и работа в настоящем репозитории.
 */

const run = promisify(execFile);

let dir: string;
let workspace: WorkspaceService;

async function git(...args: string[]): Promise<void> {
  await run('git', args, { cwd: dir });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-tool-'));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'ai@example.com');
  await git('config', 'user.name', 'AI');
  await fs.writeFile(path.join(dir, 'file.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  await git('add', '.');
  await git('commit', '-q', '-m', 'первый коммит');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>) =>
  runTool({ workspace } as unknown as ToolContext, 'git', JSON.stringify(args));

describe('git инструментом', () => {
  it('status: чистое дерево называет ветку', async () => {
    const outcome = await call({ action: 'status' });
    expect(outcome.ok).toBe(true);
    expect(String(outcome.summary)).toContain('main');
    expect(String(outcome.summary)).toContain('чистое');
  });

  it('status: правка видна с буквой изменения', async () => {
    await fs.writeFile(path.join(dir, 'file.ts'), 'const a = 9;\n', 'utf8');
    const outcome = await call({ action: 'status' });
    expect(String(outcome.summary)).toContain('изменено 1');
    expect(String(outcome.detail)).toContain('file.ts');
    expect(String(outcome.detail)).toContain('.M');
  });

  it('diff: считает файлы и отдаёт патч', async () => {
    await fs.writeFile(path.join(dir, 'file.ts'), 'const a = 9;\nconst b = 2;\n', 'utf8');
    const outcome = await call({ action: 'diff' });
    expect(String(outcome.summary)).toContain('1 файл');
    expect(String(outcome.detail)).toContain('const a = 9');
    expect(String(outcome.detail)).toContain('Что изменено:');
  });

  it('diff: пусто — говорит прямо', async () => {
    const outcome = await call({ action: 'diff' });
    expect(String(outcome.summary)).toContain('пусто');
  });

  it('diff: патч режется по maxLines с пометкой', async () => {
    await fs.writeFile(
      path.join(dir, 'file.ts'),
      Array.from({ length: 200 }, (_, index) => `const x${index} = ${index};`).join('\n'),
      'utf8',
    );
    const outcome = await call({ action: 'diff', maxLines: 10 });
    expect(String(outcome.detail)).toContain('показаны 10 строк');
    expect(String(outcome.detail)).toContain('увеличь maxLines');
  });

  it('log: коммиты одной строкой', async () => {
    const outcome = await call({ action: 'log', limit: 5 });
    expect(String(outcome.summary)).toContain('1 коммит');
    expect(String(outcome.detail)).toContain('первый коммит');
  });

  it('blame: называет коммит и строки', async () => {
    const outcome = await call({ action: 'blame', path: path.join(dir, 'file.ts'), startLine: 1, endLine: 1 });
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('const a = 1;');
    expect(String(outcome.detail)).toContain('AI');
  });

  it('show: показывает HEAD', async () => {
    const outcome = await call({ action: 'show' });
    expect(String(outcome.summary)).toContain('HEAD');
    expect(String(outcome.detail)).toContain('первый коммит');
  });

  it('неизвестное действие — отказ со списком допустимых', async () => {
    // `commit` не входит в набор сознательно: пишущие операции — за terminal.
    const outcome = await call({ action: 'commit' });
    expect(outcome.ok).toBe(false);
    expect(String(outcome.detail)).toContain('status, diff, log, blame, show');
  });

  it('вне репозитория — отказ, а не пустой ответ', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-nogit-'));
    const other = new WorkspaceService(() => undefined);
    await other.open(outside);
    const outcome = await runTool(
      { workspace: other } as unknown as ToolContext,
      'git',
      JSON.stringify({ action: 'status' }),
    );
    expect(outcome.ok).toBe(false);
    expect(String(outcome.summary)).toContain('не репозиторий');
    other.dispose();
    await fs.rm(outside, { recursive: true, force: true });
  });
});
