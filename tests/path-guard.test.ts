import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absoluteSearchPath, escapesRoot, isInsideRoot, resolveRealTarget } from '../src/main/workspace/path-guard';

/**
 * Проверки пути. Первая защищает от `..` в запросе, вторая — от чтения чужих
 * файлов по симлинку. Различие важно: уход за проект для содержимого запрещён,
 * а для метаданных разрешён — так устроены виртуальные окружения.
 */
describe('isInsideRoot', () => {
  const root = path.resolve('/proj');

  it('свой файл и подпапка — внутри', () => {
    expect(isInsideRoot(root, '/proj/a.py')).toBe(true);
    expect(isInsideRoot(root, '/proj/src/deep/a.py')).toBe(true);
  });

  it('сам корень — внутри', () => {
    expect(isInsideRoot(root, '/proj')).toBe(true);
  });

  it('выход через .. наружу', () => {
    expect(isInsideRoot(root, '/proj/../secret')).toBe(false);
  });

  it('абсолютный путь в стороне', () => {
    expect(isInsideRoot(root, '/etc/passwd')).toBe(false);
  });

  it('похожее имя каталога не считается своим', () => {
    // `/project` не должен проходить как часть `/proj`.
    expect(isInsideRoot(root, '/project/a.py')).toBe(false);
  });
});

describe('escapesRoot', () => {
  const rootReal = path.resolve('/proj');
  // Пути берём через `path.resolve`: модуль сравнивает готовые имена, а POSIX-литералы
  // на Windows не совпали бы с ними ни разделителем, ни диском.
  const inside = path.resolve('/proj/.venv/bin/python');
  const outside = path.resolve('/usr/bin/python3');
  const similar = path.resolve('/project/x');

  it('симлинк внутри проекта — не уход', () => {
    expect(escapesRoot(rootReal, inside)).toBe(false);
  });

  it('симлинк на системный интерпретатор — уход (так устроен venv)', () => {
    expect(escapesRoot(rootReal, outside)).toBe(true);
  });

  it('нечего сравнивать — не уход', () => {
    expect(escapesRoot(null, outside)).toBe(false);
    expect(escapesRoot(rootReal, null)).toBe(false);
  });

  it('похожее имя каталога не считается своим', () => {
    expect(escapesRoot(rootReal, similar)).toBe(true);
  });
});

describe('absoluteSearchPath', () => {
  const cwd = path.resolve('/proj/src');

  it('относительный путь ripgrep считается от каталога запуска, а не от процесса', () => {
    // Именно так `rg` печатает файл, когда cwd — область поиска.
    expect(absoluteSearchPath(cwd, './app.ts')).toBe(path.resolve('/proj/src/app.ts'));
    expect(absoluteSearchPath(cwd, 'helper.ts')).toBe(path.resolve('/proj/src/helper.ts'));
  });

  it('абсолютный путь не переписывается относительно cwd', () => {
    const absolute = path.resolve('/proj/src/app.ts');
    expect(absoluteSearchPath(cwd, absolute)).toBe(absolute);
  });
});

describe('resolveRealTarget — файла ещё нет', () => {
  /*
   * Дыра, которую эти тесты закрывают: раскрытие симлинка обращалось к диску
   * только для СУЩЕСТВУЮЩЕГО файла. При создании нового (`write.txt` внутри
   * папки-симлинка наружу) раскрыть было нечего, `resolved` начинался с корня —
   * и проверка пропускала запись за пределы проекта. Доказано опытом: файл вне
   * проекта перезаписывался через такой путь.
   */
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'pathguard-'));
    root = path.join(base, 'project');
    outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('раскрывает существующий файл как раньше', async () => {
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'x');
    const real = await fs.realpath(file);
    expect(resolveRealTarget(root, file, real)).toBe(real);
  });

  it('новый файл внутри проекта остаётся внутри', async () => {
    const created = path.join(root, 'sub', 'new.txt');
    const real = resolveRealTarget(root, created, null);
    expect(real.startsWith(await fs.realpath(root))).toBe(true);
  });

  it('НОВЫЙ файл в папке-симлинке наружу не считается своим', async () => {
    // Папка проекта целиком настоящая; симлинком наружу является её потомок.
    await fs.symlink(outside, path.join(root, 'link'));
    const created = path.join(root, 'link', 'secret.txt');
    const real = resolveRealTarget(root, created, null);
    // Раскрыт предок: путь обязан выйти за корень, а не притвориться своим.
    expect(real.startsWith(await fs.realpath(outside))).toBe(true);
    expect(real.startsWith(await fs.realpath(root))).toBe(false);
  });

  it('папка, которой ещё нет, не ломает создание', async () => {
    const created = path.join(root, 'a', 'b', 'c.txt');
    expect(() => resolveRealTarget(root, created, null)).not.toThrow();
  });

  it('корень слоя, которого ещё нет, не роняет проверку', () => {
    const created = path.join(root, 'x.txt');
    expect(() => resolveRealTarget('', created, null)).not.toThrow();
  });
});
