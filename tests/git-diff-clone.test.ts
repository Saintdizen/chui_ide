import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/git';

/**
 * Текстовый diff, сравнение ссылок и клонирование.
 *
 * `diffText` — то, что видит модель: не две версии файла целиком, а готовые
 * строки `+`/`-`. `compareRefs` — экран «сравнить ветки». `clone` — единственный
 * случай, где вывод идёт потоком: прогресс приходит из stderr кусками, которые
 * разделены возвратом каретки, а не переводом строки.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

let gitAvailable = true;

beforeAll(async () => {
  gitAvailable = await new Promise<boolean>((resolve) => {
    execFile('git', ['--version'], { cwd: os.tmpdir() }, (error) => resolve(!error));
  });
});

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, () => resolve());
  });
}

async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git2-')));
  roots.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await makeDir();
  await git(dir, ['init', '-q', '--template=']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  // Windows по умолчанию держит autocrlf=true: без этой строки файлы из
  // рабочей папки приходят с \r\n, и тест сравнивает их с чистым \n.
  await git(dir, ['config', 'core.autocrlf', 'false']);
  // `eol=lf` в .gitattributes сильнее core.autocrlf: на Windows рабочая папка
  // отдаёт CRLF даже при autocrlf=false. Правим правило только в этом репозитории.
  await git(dir, ['config', 'core.attributesFile', path.join(dir, '.gitattributes')]);
  await fs.writeFile(path.join(dir, '.gitattributes'), '* text=auto eol=lf\n');
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

describe('diffText', () => {
  it('без пути — общий diff рабочего дерева', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'одна\n');
    await commitAll(dir, 'init');
    await fs.writeFile(path.join(dir, 'a.txt'), 'одна\nдве\n');

    const diff = await serviceFor(dir).diffText();
    expect(diff).toContain('+две');
    expect(diff).toContain('a.txt');
  });

  it('с путём — только этот файл, остальные не протекают', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'b\n');
    await commitAll(dir, 'init');
    await fs.writeFile(path.join(dir, 'a.txt'), 'a2\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'b2\n');

    const diff = await serviceFor(dir).diffText(path.join(dir, 'a.txt'));
    expect(diff).toContain('-a');
    expect(diff).toContain('+a2');
    expect(diff).not.toContain('b2');
  });

  it('staged смотрит в индекс: правка после add в diff не попадает', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'первое\n');
    await commitAll(dir, 'init');
    await fs.writeFile(path.join(dir, 'a.txt'), 'второе\n');
    await git(dir, ['add', 'a.txt']);
    // После add правим ещё раз: в индексе «второе», на диске «третье».
    await fs.writeFile(path.join(dir, 'a.txt'), 'третье\n');

    const diff = await serviceFor(dir).diffText(path.join(dir, 'a.txt'), true);
    expect(diff).toContain('+второе');
    expect(diff).not.toContain('третье');
  });

  it('без изменений — пустая строка, не повод считать это ошибкой', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'то же\n');
    await commitAll(dir, 'init');

    expect(await serviceFor(dir).diffText()).toBe('');
  });
});

describe('compareRefs', () => {
  it('считает добавленные строки по файлам между двумя ссылками', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'один\n');
    await commitAll(dir, 'first');
    await git(dir, ['tag', 'base']);
    await fs.writeFile(path.join(dir, 'a.txt'), 'один\nдва\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'новый\n');
    await commitAll(dir, 'second');

    const diff = await serviceFor(dir).compareRefs('base', 'HEAD');
    expect(diff.base).toBe('base');
    expect(diff.head).toBe('HEAD');
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(byPath['a.txt']?.change).toBe('modified');
    expect(byPath['a.txt']?.additions).toBe(1);
    expect(byPath['b.txt']?.change).toBe('added');
    expect(byPath['b.txt']?.additions).toBe(1);
  });

  it('двоичный файл — добавленные/удалённые строки null, а не ноль', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'x\n');
    await commitAll(dir, 'first');
    await git(dir, ['tag', 'base']);
    // Байты NUL в начале — git считает файл двоичным.
    await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    await commitAll(dir, 'bin');

    const diff = await serviceFor(dir).compareRefs('base', 'HEAD');
    const bin = diff.files.find((f) => f.path === 'bin.dat');
    expect(bin?.change).toBe('added');
    expect(bin?.additions).toBeNull();
  });

  it('несуществующая ссылка — отказ, а не пустой список', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'x\n');
    await commitAll(dir, 'first');
    await expect(serviceFor(dir).compareRefs('нет-такой', 'HEAD')).rejects.toBeTruthy();
  });
});

describe('clone', () => {
  it('клонирует локальный репозиторий и отдаёт путь', async () => {
    if (!gitAvailable) return;
    const source = await makeRepo();
    await fs.writeFile(path.join(source, 'a.txt'), 'содержимое\n');
    await commitAll(source, 'init');

    const parent = await makeDir();
    const target = path.join(parent, 'clone');
    const result = await serviceFor(parent).clone(source, target);

    expect(result.path).toBe(target);
    expect(await fs.readFile(path.join(target, 'a.txt'), 'utf8')).toBe('содержимое\n');
  });

  it('прогресс приходит кусками из stderr, а не одной простыней в конце', async () => {
    if (!gitAvailable) return;
    const source = await makeRepo();
    await fs.writeFile(path.join(source, 'a.txt'), 'x\n');
    await commitAll(source, 'init');

    const parent = await makeDir();
    const lines: string[] = [];
    await serviceFor(parent).clone(source, path.join(parent, 'progress'), (line) => lines.push(line));
    // Содержимое прогресса от git не наше — проверяем, что канал живой и строки не склеены.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('\n');
  });

  it('пустой адрес — отказ до любого вызова git', async () => {
    const parent = await makeDir();
    await expect(serviceFor(parent).clone('   ', path.join(parent, 'x'))).rejects.toThrow(/Пустой адрес/);
  });

  it('папка уже существует — отказ, содержимое не тронуто', async () => {
    if (!gitAvailable) return;
    const source = await makeRepo();
    await fs.writeFile(path.join(source, 'a.txt'), 'x\n');
    await commitAll(source, 'init');

    const parent = await makeDir();
    const target = path.join(parent, 'занято');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'моё.txt'), 'не трогать\n');

    await expect(serviceFor(parent).clone(source, target)).rejects.toThrow(/уже существует/);
    expect(await fs.readFile(path.join(target, 'моё.txt'), 'utf8')).toBe('не трогать\n');
  });

  it('адрес с пробелами по краям обрезается', async () => {
    if (!gitAvailable) return;
    const source = await makeRepo();
    await fs.writeFile(path.join(source, 'a.txt'), 'x\n');
    await commitAll(source, 'init');

    const parent = await makeDir();
    const target = path.join(parent, 'trimmed');
    await serviceFor(parent).clone(`  ${source}  `, target);
    expect(await fs.readFile(path.join(target, 'a.txt'), 'utf8')).toBe('x\n');
  });
});
