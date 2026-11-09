import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectTree, treeDepth, treeMaxLines, treeTail } from '../src/main/ai/agent-tree';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Самокат: дерево папки за один вызов (п.63).
 *
 * Плоский `list` называет только первый уровень, и модель обходит проект
 * `list` за `list` — по шагу на папку. `depth` отвечает на «как устроен
 * проект» одним вызовом, `maxLines` держит ответ в узде.
 */

let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-list-tree-'));
  for (const folder of ['src/app', 'src/lib/deep/er', 'docs']) {
    await fs.mkdir(path.join(dir, folder), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'src/app/main.ts'), 'export {};\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src/lib/util.ts'), 'export {};\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src/lib/deep/er/x.ts'), 'export {};\n', 'utf8');
  await fs.writeFile(path.join(dir, 'docs/readme.md'), '# hi\n', 'utf8');
  await fs.writeFile(path.join(dir, 'package.json'), '{}\n', 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const list = (args: Record<string, unknown>) =>
  runTool({ workspace } as unknown as ToolContext, 'list', JSON.stringify(args));

describe('list с depth', () => {
  it('без depth — прежний плоский список', async () => {
    const outcome = await list({ path: path.join(dir, 'src') });
    expect(String(outcome.summary)).toContain('записей');
    expect(String(outcome.summary)).not.toContain('дерево');
  });

  it('depth 2 показывает соседей и внуков', async () => {
    const outcome = await list({ path: path.join(dir, 'src'), depth: 2 });
    const detail = String(outcome.detail);
    expect(String(outcome.summary)).toContain('дерево');
    expect(detail).toContain('src/app/');
    expect(detail).toContain('src/app/main.ts');
    expect(detail).toContain('src/lib/util.ts');
    expect(detail).not.toContain('deep/er/x.ts');
  });

  it('вложенность видна отступом', async () => {
    const outcome = await list({ path: path.join(dir, 'src'), depth: 2 });
    const rows = String(outcome.detail).split('\n');
    const folder = rows.find((row) => row.includes('src/app/'))!;
    const file = rows.find((row) => row.includes('src/app/main.ts'))!;
    expect(file.startsWith('  ')).toBe(true);
    expect(folder.startsWith(' ')).toBe(false);
  });

  it('maxLines обрезает и говорит об этом', async () => {
    const outcome = await list({ path: dir, depth: 4, maxLines: 3 });
    const detail = String(outcome.detail);
    expect(detail.split('\n').length).toBeLessThan(6);
    expect(detail).toContain('увеличь maxLines');
    expect(String(outcome.summary)).toContain('обрезано');
  });

  it('обход идёт в ширину: соседи раньше внуков', async () => {
    const collected = await collectTree(workspace, path.join(dir, 'src'), { depth: 3, maxEntries: 10 });
    const names = collected.nodes.map((node) => path.basename(node.entry.path));
    expect(names.slice(0, 2)).toEqual(['app', 'lib']);
  });

  it('depth и maxLines держатся в разумных рамках', () => {
    expect(treeDepth({})).toBe(3);
    expect(treeDepth({ depth: 99 })).toBe(8);
    expect(treeDepth({ depth: 0 })).toBe(3);
    expect(treeMaxLines({})).toBe(400);
    expect(treeMaxLines({ maxLines: 10_000 })).toBe(2000);
  });

  it('хвост молчит, когда всё показано', () => {
    expect(treeTail({ truncated: false, total: 5, shown: 5, depth: 2, path: 'src' })).toBe('');
  });
});
