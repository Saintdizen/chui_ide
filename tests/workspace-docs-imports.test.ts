import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DOC_BYTES, MAX_FILE_BYTES, WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Поиск по документации и перезапись импортов после переименования.
 *
 * `searchDocs` возвращает РАЗДЕЛЫ, а не файлы: важно, что на запрос «как
 * установить» приходит раздел «Установка», а не весь README, и что код с
 * расширением `.ts` в индекс документации не попадает, хотя имя совпадает.
 *
 * `updateImports` — самая рискованная из правок по проекту: она переписывает
 * файлы, которых человек не открывал. Поэтому проверяются обе границы: что
 * импорт на переехавший путь переписан И что чужие файлы (и файлы внутри самой
 * переехавшей папки) не тронуты.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ws-docs-')));
  roots.push(base);
  return base;
}

function service(): WorkspaceService {
  return new WorkspaceService(
    () => undefined,
    () => undefined,
  );
}

async function write(dir: string, relative: string, text: string): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
}

async function read(dir: string, relative: string): Promise<string> {
  return fs.readFile(path.join(dir, ...relative.split('/')), 'utf8');
}

describe('searchDocs', () => {
  it('возвращает раздел по смыслу, а не файл целиком', async () => {
    const root = await makeDir();
    await write(
      root,
      'README.md',
      [
        '# Проект',
        '',
        'Вступление про всякое.',
        '',
        '## Установка',
        '',
        'Ставится через пакетный менеджер.',
        '',
        '## Прочее',
        '',
        'Ещё текст.',
      ].join('\n'),
    );
    const ws = service();
    await ws.open(root);
    const result = await ws.searchDocs({ query: 'установка' });

    expect(result.files).toBe(1);
    expect(result.hits.length).toBeGreaterThan(0);
    // Заголовок раздела — цепочка вложенности, и это именно тот раздел.
    expect(result.hits[0]?.heading).toContain('Установка');
    expect(result.hits[0]?.line).toBe(5);
  });

  it('код в индекс документации не попадает, даже с именем readme', async () => {
    const root = await makeDir();
    await write(root, 'readme.ts', '// установка здесь тоже упомянута\n');
    await write(root, 'src/install.ts', '// и тут\n');
    const ws = service();
    await ws.open(root);
    const result = await ws.searchDocs({ query: 'установка' });

    // Расширение .ts — код: имя «readme» без учёта расширения не спасает.
    expect(result.files).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('README без расширения считается документацией', async () => {
    const root = await makeDir();
    await write(root, 'README', '# Установка\n\nПоставьте пакет.\n');
    const ws = service();
    await ws.open(root);
    const result = await ws.searchDocs({ query: 'установка' });

    expect(result.files).toBe(1);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('пустой запрос — InvalidParams, а не весь индекс', async () => {
    const root = await makeDir();
    await write(root, 'README.md', '# Что-то\n');
    const ws = service();
    await ws.open(root);
    await expect(ws.searchDocs({ query: '   ' })).rejects.toThrow(/запрос/i);
  });

  it('потолок выдачи ограничен, даже если подходящих разделов много', async () => {
    const root = await makeDir();
    const sections = Array.from({ length: 30 }, (_, i) => `## Установка ${i}\n\nПакет ставится так.\n`).join('\n');
    await write(root, 'docs/guide.md', `# Гайд\n\n${sections}`);
    const ws = service();
    await ws.open(root);
    const result = await ws.searchDocs({ query: 'установка', limit: 100 });

    // 20 — верхняя граница, limit больше неё не раздувает ответ.
    expect(result.hits.length).toBeLessThanOrEqual(20);
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

describe('updateImports', () => {
  it('переписывает относительный импорт на переехавший файл', async () => {
    const root = await makeDir();
    await write(root, 'src/util.ts', 'export const x = 1;\n');
    await write(root, 'src/app.ts', "import { x } from './util';\nconsole.log(x);\n");
    const ws = service();
    await ws.open(root);

    // Файл переехал в подпапку — импорт обязан за ним.
    const result = await ws.updateImports(path.join(root, 'src/util.ts'), path.join(root, 'lib/util.ts'));
    expect(result.files.map((f) => path.relative(root, f).split(path.sep).join('/'))).toEqual(['src/app.ts']);
    expect(await read(root, 'src/app.ts')).toContain("'../lib/util'");
  });

  it('файлы внутри переехавшей папки не трогаются', async () => {
    const root = await makeDir();
    await write(root, 'old/a.ts', 'export const a = 1;\n');
    // Сосед внутри папки ссылается на соседа по имени — путь между ними не изменился.
    await write(root, 'old/b.ts', "import { a } from './a';\n");
    const ws = service();
    await ws.open(root);

    const result = await ws.updateImports(path.join(root, 'old'), path.join(root, 'new'));
    // b.ts переехал вместе с a.ts: «./a» верен и после переезда.
    expect(result.files).toEqual([]);
    expect(await read(root, 'old/b.ts')).toContain("'./a'");
  });

  it('внешние пакеты и чужие пути не переписываются', async () => {
    const root = await makeDir();
    await write(root, 'src/util.ts', 'export const x = 1;\n');
    await write(root, 'src/other.ts', 'export const y = 2;\n');
    await write(
      root,
      'src/app.ts',
      ["import fs from 'node:fs';", "import { y } from './other';", 'export const z = [fs, y];', ''].join('\n'),
    );
    const ws = service();
    await ws.open(root);

    const result = await ws.updateImports(path.join(root, 'src/util.ts'), path.join(root, 'src/deep/util.ts'));
    expect(result.files).toEqual([]);
    const text = await read(root, 'src/app.ts');
    expect(text).toContain("'node:fs'");
    expect(text).toContain("'./other'");
  });

  it('путь вне проекта — пустой ответ, а не обход дерева', async () => {
    const root = await makeDir();
    await write(root, 'src/app.ts', "import { x } from '../outside/util';\n");
    const ws = service();
    await ws.open(root);

    const result = await ws.updateImports('/совсем/другой/путь/util.ts', '/совсем/другой/путь/lib/util.ts');
    expect(result.files).toEqual([]);
  });

  it('прежнее содержимое уходит в историю перед перезаписью', async () => {
    const root = await makeDir();
    await write(root, 'src/util.ts', 'export const x = 1;\n');
    await write(root, 'src/app.ts', "import { x } from './util';\n");
    const saved: string[] = [];
    const ws = new WorkspaceService(
      () => undefined,
      () => undefined,
    );
    // onBeforeChange — порт «до правки»: без него перезапись необратима.
    (ws as unknown as { onBeforeChange?: (file: string, kind: string) => void }).onBeforeChange = (file) => {
      saved.push(path.relative(root, file));
    };
    await ws.open(root);

    await ws.updateImports(path.join(root, 'src/util.ts'), path.join(root, 'lib/util.ts'));
    expect(saved).toEqual(['src/app.ts']);
  });
});

/**
 * Потолки документации и переписывания импортов. Оба гейта экономят память
 * на «случайно огромном» файле; важнее всего, что при превышении сервис молча
 * не ест гигабайт, но и не падает.
 */
describe('searchDocs: потолки', () => {
  it('документ больше потолка пропускается, соседи индексируются', async () => {
    const dir = await makeDir();
    const big = path.join(dir, 'ОГРОМНЫЙ.md');
    await fs.writeFile(big, '', 'utf8');
    await fs.truncate(big, MAX_DOC_BYTES + 1);
    await fs.writeFile(path.join(dir, 'README.md'), '# Установка\n\nкак установить проект\n', 'utf8');
    const ws = service();
    await ws.open(dir);

    const result = await ws.searchDocs({ query: 'установить' });

    // Огромный файл не попал в индекс вовсе — иначе он заслонил бы README.
    expect(result.files).toBe(1);
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) expect(hit.path).toContain('README.md');
  });

  it('документ ровно в потолок индексируется', async () => {
    const dir = await makeDir();
    const body = '# Установка\n\nкак установить\n';
    const doc = path.join(dir, 'README.md');
    await fs.writeFile(doc, body, 'utf8');
    await fs.truncate(doc, MAX_DOC_BYTES);
    const ws = service();
    await ws.open(dir);

    const result = await ws.searchDocs({ query: 'установить' });

    // Граница включающая: ровно потолок — ещё читаем.
    expect(result.files).toBe(1);
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

describe('updateImports: потолки', () => {
  it('файл больше потолка не переписывается и не ломает остальные', async () => {
    const dir = await makeDir();
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'old.ts'), 'export const a = 1;\n', 'utf8');

    const big = path.join(dir, 'src', 'big.ts');
    await fs.writeFile(big, `import { a } from './old';\n`, 'utf8');
    await fs.truncate(big, MAX_FILE_BYTES + 1);

    const small = path.join(dir, 'src', 'small.ts');
    await fs.writeFile(small, `import { a } from './old';\n`, 'utf8');
    const ws = service();
    await ws.open(dir);

    const result = await ws.updateImports(path.join(dir, 'src', 'old.ts'), path.join(dir, 'src', 'new.ts'));

    // Крупный файл пропущен: его содержимое не читали и не переписывали.
    // Пути отдаются абсолютными — сверяем хвост, а не весь путь.
    expect(result.files).toHaveLength(1);
    expect(result.files[0].endsWith('/src/small.ts')).toBe(true);
    expect(await fs.readFile(big, 'utf8')).toContain(`from './old'`);
    expect(await fs.readFile(small, 'utf8')).toContain(`from './new'`);
  });
});
