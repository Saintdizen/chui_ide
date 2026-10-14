import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Ответы по документации по проекту: обход файлов, отбор документов, нарезка на
 * разделы и ранжирование. Разбор и ранжирование самих разделов — в
 * `tests/docs-index.test.ts`; здесь проверяем шов main-слоя.
 */
let dir: string;
let workspace: WorkspaceService;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-docs-')));
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return file;
}

describe('workspace.searchDocs', () => {
  it('находит раздел документации и отдаёт путь, строку и заголовок', async () => {
    await write('README.md', '# Проект\n\nВступление.\n\n## Установка\n\nnpm install\n');

    const result = await workspace.searchDocs({ query: 'установка' });

    expect(result.files).toBe(1);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      path: path.join(dir, 'README.md'),
      line: 5,
      heading: 'Проект > Установка',
    });
  });

  it('ищет и в подпапке docs', async () => {
    await write('docs/guide.md', '# Руководство\n\n## Сборка\n\nКак собрать проект: npm run build\n');
    const result = await workspace.searchDocs({ query: 'как собрать' });
    expect(result.hits[0]?.path).toBe(path.join(dir, 'docs/guide.md'));
  });

  it('файлы, не являющиеся документацией, не просматриваются', async () => {
    await write('src/app.ts', '// установка проекта — тут ни при чём\n');
    const result = await workspace.searchDocs({ query: 'установка' });
    expect(result.files).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('пустой запрос — ошибка', async () => {
    await write('README.md', '# Проект\n');
    await expect(workspace.searchDocs({ query: '   ' })).rejects.toThrow();
  });

  it('ничего не найдено — пустой список, а не ошибка', async () => {
    await write('README.md', '# Проект\n\nВступление.\n');
    const result = await workspace.searchDocs({ query: 'космический деплой' });
    expect(result.files).toBe(1);
    expect(result.hits).toEqual([]);
  });
});
