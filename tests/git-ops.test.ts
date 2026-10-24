import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/git';

/**
 * Действия с индексом и рабочем деревом: init, убрать из индекса, откатить,
 * переключить ветку.
 *
 * Всё это меняет файлы человека, поэтому проверяется на настоящем репозитории:
 * цена ошибки здесь — потерянная работа, а не неправильная строка в ответе.
 * Особенно важны отказы: в репозитории БЕЗ коммитов `restore --staged` не работает,
 * и это единственное место, где код обязан пройти другой дорогой.
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

/** Пустой каталог (ещё не репозиторий). */
async function makeDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-gitops-')));
  roots.push(dir);
  return dir;
}

/** Репозиторий с одним коммитом. `commits: false` — свежий `git init` без HEAD. */
async function makeRepo(commits = true): Promise<string> {
  const dir = await makeDir();
  await git(dir, ['init', '-q', '--template=']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  // Windows по умолчанию держит autocrlf=true: без этой строки файлы из
  // рабочей папки приходят с \r\n, и тест сравнивает их с чистым \n.
  await git(dir, ['config', 'core.autocrlf', 'false']);
  if (commits) {
    await fs.writeFile(path.join(dir, 'a.txt'), 'на диске\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'init']);
  }
  return dir;
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

/** Содержимое файла или `null`, если его нет. */
async function read(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

describe('init', () => {
  it('пустой каталог становится репозиторием с веткой, но без коммитов', async () => {
    if (!gitAvailable) return;
    const dir = await makeDir();
    const status = await serviceFor(dir).init();
    expect(status.repository).toBeTruthy();
    // Git init не делает коммита: HEAD пуст, и это важно для discard ниже.
    expect(status.repository?.head).toBeNull();
    expect(await read(path.join(dir, '.git/HEAD'))).toBeTruthy();
  });

  it('повторный init не ломает уже готовый репозиторий', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    const before = await read(path.join(dir, 'a.txt'));
    const status = await serviceFor(dir).init();
    expect(status.repository?.head).toBeTruthy();
    expect(await read(path.join(dir, 'a.txt'))).toBe(before);
  });
});

describe('unstage', () => {
  it('в репозитории с коммитами файл уходит из индекса, но остаётся на диске', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    const file = path.join(dir, 'b.txt');
    await fs.writeFile(file, 'новое\n');
    await git(dir, ['add', 'b.txt']);

    const ws = await serviceFor(dir).unstage([file]);
    const staged = ws.files.filter((f) => f.path === path.resolve(file));
    expect(staged[0]?.change).toBe('untracked');
    // Содержимое не тронуто — убрали только из индекса.
    expect(await read(file)).toBe('новое\n');
  });

  it('БЕЗ коммитов тоже работает: restore --staged падает, спасает rm --cached', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo(false);
    const file = path.join(dir, 'first.txt');
    await fs.writeFile(file, 'первый\n');
    await git(dir, ['add', 'first.txt']);

    const ws = await serviceFor(dir).unstage([file]);
    expect(ws.files.find((f) => f.path === path.resolve(file))?.change).toBe('untracked');
    expect(await read(file)).toBe('первый\n');
  });
});

describe('discard', () => {
  it('отслеживаемый файл возвращается к HEAD', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    const file = path.join(dir, 'a.txt');
    await fs.writeFile(file, 'испорчено\n');

    await serviceFor(dir).discard([file]);
    expect(await read(file)).toBe('на диске\n');
  });

  // Новый файл и репозиторий без коммитов проверять в vitest нечем: discard
  // уводит их в корзину через shell.trashItem из Electron, которого здесь нет.
  // Отслеживаемый файл идёт другой дорогой — `git restore` — и проверен выше.

  it('незнакомый путь просто игнорируется, а не бросает ошибку', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    const ws = serviceFor(dir);
    await expect(ws.discard([path.join(dir, 'нет-такого.txt')])).resolves.toBeTruthy();
  });
});

describe('checkout', () => {
  it('переключает на существующую ветку', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await git(dir, ['branch', 'other']);

    const status = await serviceFor(dir).checkout('other');
    expect(status.repository?.branch).toBe('other');
  });

  it('создаёт ветку, когда просят', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    const status = await serviceFor(dir).checkout('feature', true);
    expect(status.repository?.branch).toBe('feature');
  });

  it('несуществующая ветка без создания — отказ с текстом git, а не тихий успех', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    // Текст не переводится: показываем stderr git как есть, но провал не глотаем.
    await expect(serviceFor(dir).checkout('нет-такой')).rejects.toThrow(/did not match|pathspec/i);
  });
});
