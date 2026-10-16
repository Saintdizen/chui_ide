import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingLocalImports, pythonImportCandidates, scriptImportCandidates } from '../src/main/project/local-imports';

/**
 * Разрешение относительных импортов: какие пути пробуем и что считаем ненайденным.
 * Файловой системы тут нет — проверка существования подставная, поэтому видно
 * ровно правило, а не диск.
 *
 * Пути собираем системным `path`, а не пишем `/p/src/a.ts` строкой: модуль берёт
 * каталог файла и присоединяет к нему спецификатор через тот же `path`, поэтому на
 * Windows кандидаты выходят с `\` и буквой диска, и записанный вручную POSIX-путь
 * с ними не сойдётся. Корень фикстуры — корень той системы, где идёт прогон.
 */
const ROOT = path.resolve(path.sep);
const at = (...parts: string[]): string => path.join(ROOT, ...parts);
const existsIn =
  (present: readonly string[]) =>
  async (target: string): Promise<boolean> =>
    present.includes(target);

describe('scriptImportCandidates', () => {
  it('без расширения пробует свои расширения и index', () => {
    const candidates = scriptImportCandidates(at('p', 'src', 'a.ts'), './util');
    expect(candidates[0]).toBe(at('p', 'src', 'util.ts'));
    expect(candidates).toContain(at('p', 'src', 'util.jsx'));
    expect(candidates).toContain(at('p', 'src', 'util', 'index.ts'));
  });

  it('импорт с расширением .js в TS-проекте ведёт к .ts', () => {
    const candidates = scriptImportCandidates(at('p', 'src', 'a.ts'), './util.js');
    // Расширение названо — это файл: `index` внутри него не пробуем.
    expect(candidates).toEqual([at('p', 'src', 'util.js'), at('p', 'src', 'util.ts')]);
  });

  it('поднимается по дереву для `../`', () => {
    expect(scriptImportCandidates(at('p', 'src', 'nested', 'a.ts'), '../util')).toContain(at('p', 'src', 'util.ts'));
  });
});

describe('pythonImportCandidates', () => {
  it('одна точка — каталог самого модуля', () => {
    const candidates = pythonImportCandidates(at('p', 'pkg', 'sub', 'a.py'), '.mod');
    expect(candidates).toContain(at('p', 'pkg', 'sub', 'mod.py'));
    expect(candidates).toContain(at('p', 'pkg', 'sub', 'mod', '__init__.py'));
  });

  it('две точки — родительский пакет', () => {
    expect(pythonImportCandidates(at('p', 'pkg', 'sub', 'a.py'), '..other')).toContain(at('p', 'pkg', 'other.py'));
  });

  it('точечный путь разворачивается в каталоги', () => {
    expect(pythonImportCandidates(at('p', 'pkg', 'a.py'), '.sub.mod')).toContain(at('p', 'pkg', 'sub', 'mod.py'));
  });

  it('без имени пути нет — проверять нечего', () => {
    // `from . import x`: имя может быть из `__init__.py`, файла для него не искать.
    expect(pythonImportCandidates(at('p', 'pkg', 'a.py'), '.')).toEqual([]);
  });
});

describe('missingLocalImports', () => {
  it('молчит, если файл нашёлся хоть по одному пути', async () => {
    const missing = await missingLocalImports(
      'typescript',
      at('p', 'src', 'a.ts'),
      ['./util'],
      existsIn([at('p', 'src', 'util.ts')]),
    );
    expect(missing).toEqual([]);
  });

  it('отмечает то, чего на диске нет', async () => {
    const missing = await missingLocalImports(
      'typescript',
      at('p', 'src', 'a.ts'),
      ['./util', './gone'],
      existsIn([at('p', 'src', 'util.ts')]),
    );
    expect(missing).toEqual(['./gone']);
  });

  it('у Python свои пути', async () => {
    const missing = await missingLocalImports(
      'python',
      at('p', 'pkg', 'a.py'),
      ['.mod', '.gone'],
      existsIn([at('p', 'pkg', 'mod.py')]),
    );
    expect(missing).toEqual(['.gone']);
  });

  it('спецификатор без путей не отмечается', async () => {
    // Так выглядит `from . import x`: кандидатов нет — значит и судить не о чем.
    const missing = await missingLocalImports('python', at('p', 'pkg', 'a.py'), ['.', '..'], existsIn([]));
    expect(missing).toEqual([]);
  });

  it('повторы не проверяются дважды', async () => {
    const seen: string[] = [];
    const exists = async (target: string): Promise<boolean> => {
      seen.push(target);
      return false;
    };
    const missing = await missingLocalImports('typescript', at('p', 'a.ts'), ['./x', './x'], exists);
    expect(missing).toEqual(['./x']);
    // Разные пути одного кандидата — это один кандидат, а не два.
    expect(new Set(seen).size).toBe(seen.length);
  });
});
