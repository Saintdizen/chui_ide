import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDependencyRoots, listDependencyFiles, MAX_DEPENDENCY_FILES } from '../src/main/symbols/dependencies';

/**
 * Зависимости проекта: где их искать и какие файлы брать в карту.
 *
 * Проверяем то, на чём легко ошибиться молча: пакеты со областью (`@scope`), вложенный
 * `node_modules` (его обходить нельзя — это чужое дерево), `dist-info` (не пакет),
 * раскладку Windows (`Lib`) и правило «объявления раньше реализации». Без него карта
 * читала бы `index.js` вместо `index.d.ts` и не знала бы типов.
 */

const tempDirs: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'chui-deps-'));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findDependencyRoots', () => {
  it('пакеты node_modules, включая область; вложенные node_modules — мимо', async () => {
    const root = tree({
      'node_modules/express/package.json': '{}',
      'node_modules/express/lib/index.d.ts': 'export declare class Router {}',
      'node_modules/@types/node/index.d.ts': 'declare class Buffer {}',
      'node_modules/express/node_modules/nested/index.d.ts': 'declare class Nested {}',
      'node_modules/.bin/tsc': '',
    });

    const roots = await findDependencyRoots({ root });
    const names = roots.map((entry) => entry.package).sort();

    expect(names).toEqual(['@types/node', 'express']);
    expect(roots.every((entry) => entry.language === 'typescript')).toBe(true);
  });

  it('пакеты окружения Python: lib/pythonX.Y и раскладка Windows', async () => {
    const root = tree({
      '.venv/pyvenv.cfg': 'home = /usr/bin',
      '.venv/lib/python3.12/site-packages/requests/__init__.py': '',
      '.venv/lib/python3.12/site-packages/requests/api.py': '',
      '.venv/lib/python3.12/site-packages/single.py': '',
      '.venv/lib/python3.12/site-packages/requests-2.31.0.dist-info/METADATA': '',
      '.venv/Lib/site-packages/winpkg/__init__.py': '',
    });

    const roots = await findDependencyRoots({ root });
    const names = roots.map((entry) => entry.package).sort();

    // `requests-2.31.0.dist-info` — описание пакета, а не пакет.
    expect(names).toEqual(['requests', 'single', 'winpkg']);
  });

  it('окружение вне проекта тоже видно', async () => {
    const root = tree({ 'main.py': '' });
    const external = tree({ 'lib/python3.11/site-packages/shared_pkg/__init__.py': '' });

    const roots = await findDependencyRoots({ root, venvDir: external });
    expect(roots.map((entry) => entry.package)).toEqual(['shared_pkg']);
  });

  it('без node_modules и без окружения список пуст — и это не ошибка', async () => {
    const root = tree({ 'main.py': '' });
    expect(await findDependencyRoots({ root })).toEqual([]);
  });
});

describe('listDependencyFiles', () => {
  it('объявления важнее реализации: есть .d.ts — .js не берём', async () => {
    const root = tree({
      'node_modules/pkg/index.js': 'exports.x = 1;',
      'node_modules/pkg/index.d.ts': 'export declare const x: number;',
      'node_modules/pkg/lib/deep.d.ts': 'export declare function deep(): void;',
    });

    const files = await listDependencyFiles(await findDependencyRoots({ root }));
    expect(files.map((file) => path.basename(file.path))).toEqual(['index.d.ts', 'deep.d.ts']);
    expect(files.every((file) => file.package === 'pkg')).toBe(true);
  });

  it('реализация берётся, только когда объявлений нет', async () => {
    const root = tree({ 'node_modules/pkg/index.js': 'exports.run = () => {};' });
    const files = await listDependencyFiles(await findDependencyRoots({ root }));
    expect(files.map((file) => path.basename(file.path))).toEqual(['index.js']);
  });

  it('минифицированное и карты кода пропускаются', async () => {
    const root = tree({
      'node_modules/pkg/index.js': 'exports.run = () => {};',
      'node_modules/pkg/app.min.js': 'var a=1;',
      'node_modules/pkg/index.js.map': '{}',
    });

    const files = await listDependencyFiles(await findDependencyRoots({ root }));
    expect(files.map((file) => path.basename(file.path))).toEqual(['index.js']);
  });

  it('Python: .pyi вместо .py, тесты пакета не нужны', async () => {
    const root = tree({
      '.venv/lib/python3.12/site-packages/lib/api.py': 'def fetch(): pass',
      '.venv/lib/python3.12/site-packages/lib/api.pyi': 'def fetch() -> None: ...',
      '.venv/lib/python3.12/site-packages/lib/tests/test_api.py': '',
    });

    const files = await listDependencyFiles(await findDependencyRoots({ root }));
    expect(files.map((file) => path.basename(file.path))).toEqual(['api.pyi']);
  });

  it('предел на весь проект соблюдается', async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      many[`node_modules/pkg${index}/index.d.ts`] = 'export declare const a: number;';
    }
    const root = tree(many);

    const files = await listDependencyFiles(await findDependencyRoots({ root }), 5);
    expect(files).toHaveLength(5);
    expect(MAX_DEPENDENCY_FILES).toBeGreaterThan(5);
  });
});
