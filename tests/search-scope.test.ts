import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Сузить поиск до папки, отказаться от бинарного файла.
 *
 * Оба поведения — про экономию: поиск по всему проекту там, где нужна одна
 * папка, тратит шаг и место в контексте; а бинарный файл, прочитанный как текст,
 * не даёт ничего, кроме мусора.
 */

let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-scope-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/app.ts'), 'const marker = 1;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src/helper.ts'), 'export const marker = 2;\n', 'utf8');
  await fs.writeFile(path.join(dir, 'docs/readme.md'), 'marker в документации\n', 'utf8');
  await fs.writeFile(path.join(dir, 'root.ts'), 'marker в корне\n', 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const context = (): ToolContext => ({ workspace }) as unknown as ToolContext;
const run = (name: string, args: Record<string, unknown>) => runTool(context(), name, JSON.stringify(args));

describe('search: область поиска', () => {
  it('без path ищет по всему проекту', async () => {
    const outcome = await run('search', { query: 'marker' });
    expect(String(outcome.detail)).toContain('src/app.ts');
    expect(String(outcome.detail)).toContain('docs/readme.md');
    expect(String(outcome.detail)).toContain('root.ts');
  });

  it('с path ищет только внутри папки', async () => {
    const outcome = await run('search', { query: 'marker', path: path.join(dir, 'src') });
    expect(String(outcome.detail)).toContain('src/app.ts');
    expect(String(outcome.detail)).not.toContain('docs/readme.md');
    expect(String(outcome.detail)).not.toContain('root.ts');
  });

  it('с path-файлом ищет ровно в нём', async () => {
    const outcome = await run('search', { query: 'marker', path: path.join(dir, 'src/helper.ts') });
    expect(String(outcome.detail)).toContain('helper.ts');
    expect(String(outcome.detail)).not.toContain('app.ts');
  });

  it('маска glob меряется от области, а не от корня проекта', async () => {
    const outcome = await run('search', { query: 'marker', path: path.join(dir, 'src'), glob: '*.ts' });
    expect(String(outcome.detail)).toContain('app.ts');
    // Из docs файла .ts нет вовсе, а в корне есть — но корень вне области.
    expect(String(outcome.detail)).not.toContain('root.ts');
  });

  it('путь вне проекта — отказ, а не поиск снаружи', async () => {
    const outcome = await run('search', { query: 'marker', path: os.tmpdir() });
    expect(outcome.ok).toBe(false);
    expect(String(outcome.summary)).toMatch(/вне рабочей папки/i);
  });
});

/**
 * Обход `fs` — путь для машин без ripgrep.
 *
 * Пока пустой поиск уходил в обход, он проверялся попутно, на каждом «ничего не
 * нашлось». Теперь пустой результат приходит от ripgrep, и обход надо звать
 * явно: иначе его поведение (абсолютные пути, число просмотренных файлов,
 * порядок совпадений) остаётся без присмотра до чьей-то машины без `rg`.
 */
describe('search: свой обход без ripgrep', () => {
  const withoutRipgrep = (service: WorkspaceService): void => {
    (service as unknown as { ripgrepFound: boolean | null }).ripgrepFound = false;
  };

  it('находит то же, что ripgrep, и считает те же файлы', async () => {
    const viaRipgrep = await workspace.search({ query: 'marker' });
    withoutRipgrep(workspace);
    const viaFs = await workspace.search({ query: 'marker' });

    // Два пути обязаны быть неразличимы снаружи — иначе поиск менял бы
    // поведение от того, установлена ли в системе команда.
    expect(viaFs.hits).toEqual(viaRipgrep.hits);
    expect(viaFs.scanned).toBe(viaRipgrep.scanned);
  });

  it('пустой поиск не рапортует нулём просмотренных файлов', async () => {
    withoutRipgrep(workspace);
    const result = await workspace.search({ query: 'такого-нет-нигде' });

    expect(result.hits).toEqual([]);
    // Четыре файла проекта: src/app.ts, src/helper.ts, docs/readme.md, root.ts.
    expect(result.scanned).toBe(4);
  });
});

describe('read: бинарный файл', () => {
  it('отказывает словами, а не отдаёт мусор', async () => {
    const binary = path.join(dir, 'image.bin');
    await fs.writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x47, 0x0d, 0x0a]));

    const outcome = await run('read', { path: binary });
    expect(outcome.ok).toBe(false);
    expect(String(outcome.summary)).toContain('бинарный');
  });

  it('в пакетном чтении бинарный файл пропускается с причиной', async () => {
    const binary = path.join(dir, 'blob.bin');
    await fs.writeFile(binary, Buffer.from([0x00, 0x01, 0x02]));
    const text = path.join(dir, 'src/app.ts');

    const outcome = await run('read', { paths: [text, binary] });
    expect(String(outcome.detail)).toContain('const marker = 1;');
    expect(String(outcome.detail)).toContain('blob.bin');
  });
});
