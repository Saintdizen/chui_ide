import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanTodoText } from '../src/main/ai/agent-todo';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * `todo` инструментом (п.59).
 *
 * У редактора панель пометок есть, у модели — не было. Обычный `search` по
 * `TODO` даёт сырые строки: не видно, пометка это или слово в литерале, и
 * границы слова не проверены.
 */

describe('разбор пометок', () => {
  it('ловятся TODO, FIXME, HACK, XXX', () => {
    const text = ['// TODO: доделать', '// FIXME потом', '/* HACK */', '# XXX'].join('\n');
    expect(scanTodoText('f.ts', text, 10).map((hit) => hit.kind)).toEqual(['TODO', 'FIXME', 'HACK', 'XXX']);
  });

  it('границы слова: TODOS и MethodTODO — не пометки', () => {
    expect(scanTodoText('f.ts', '// TODOS list\ncall(MethodTODO)', 10)).toEqual([]);
  });

  it('пометка в литерале тоже видна', () => {
    const hits = scanTodoText('f.ts', "throw new Error('TODO: реализовать');", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(1);
  });

  it('номера строк настоящие, длинная строка обрезана', () => {
    const text = ['первая', 'вторая', `// TODO ${'x'.repeat(300)}`].join('\n');
    const [hit] = scanTodoText('f.ts', text, 10);
    expect(hit!.line).toBe(3);
    expect(hit!.text.length).toBeLessThanOrEqual(161);
  });

  it('limit соблюдается', () => {
    const text = Array.from({ length: 20 }, () => '// TODO').join('\n');
    expect(scanTodoText('f.ts', text, 5)).toHaveLength(5);
  });
});

describe('todo инструментом', () => {
  let dir: string;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-todo-'));
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src/a.ts'), '// TODO: первое\nexport const a = 1;\n// FIXME: второе\n', 'utf8');
    await fs.writeFile(path.join(dir, 'src/b.ts'), 'export const b = 2;\n', 'utf8');
    await fs.writeFile(path.join(dir, 'notes.md'), 'TODO: в заметках\n', 'utf8');
    workspace = new WorkspaceService(() => undefined);
    await workspace.open(dir);
  });

  afterEach(async () => {
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const todo = (args: Record<string, unknown> = {}) =>
    runTool({ workspace } as unknown as ToolContext, 'todo', JSON.stringify(args));

  it('находит пометки по всему проекту', async () => {
    const outcome = await todo();
    expect(String(outcome.summary)).toContain('3 пометок');
    expect(String(outcome.detail)).toContain('src/a.ts:1');
    expect(String(outcome.detail)).toContain('notes.md:1');
  });

  it('path сужает до папки', async () => {
    const outcome = await todo({ path: 'src' });
    expect(String(outcome.detail)).not.toContain('notes.md');
    expect(String(outcome.detail)).toContain('src/a.ts');
  });

  it('path сужает до файла', async () => {
    const outcome = await todo({ path: 'notes.md' });
    expect(String(outcome.summary)).toContain('1 пометок');
  });

  it('kind фильтрует по виду', async () => {
    const outcome = await todo({ kind: 'FIXME' });
    expect(String(outcome.summary)).toContain('1 пометок');
    expect(String(outcome.detail)).toContain('FIXME');
    expect(String(outcome.detail)).not.toContain('TODO');
  });

  it('kind не теряет пометки, когда до лимита их много', async () => {
    // 200 TODO съедают limit=50 до того, как дойдём до FIXME в том же файле.
    const many = Array.from({ length: 200 }, (_, i) => `// TODO: ${i}`).join('\n');
    await fs.writeFile(path.join(dir, 'src/many.ts'), `${many}\n// FIXME: последний\n`, 'utf8');
    const outcome = await todo({ kind: 'FIXME' });
    expect(String(outcome.summary)).toContain('2 пометок');
    expect(String(outcome.detail)).toContain('src/many.ts:201');
  });

  it('пусто — говорит прямо и не выдумывает', async () => {
    await fs.writeFile(path.join(dir, 'clean.ts'), 'export const c = 3;\n', 'utf8');
    const outcome = await todo({ path: 'clean.ts' });
    expect(String(outcome.summary)).toContain('пометок нет');
  });
});
