import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/git';
import { removeTemp } from './temp';

/**
 * Разреженный рабочий каталог (sparse checkout) на настоящем репозитории: режим
 * спрашивает и меняет сам git, поэтому проверяем на живом репозитории в temp — как
 * остальные проверки git. Чистые правила разбора ответов — в `tests/git-sparse.test.ts`.
 */

const roots: string[] = [];

afterEach(async () => {
  await removeTemp(roots);
});

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

let gitAvailable = true;

beforeAll(async () => {
  const probe = await git(os.tmpdir(), ['--version']);
  gitAvailable = probe.code === 0;
});

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

/** Рабочий репозиторий с каталогом `src`, файлом в корне и одним коммитом. */
async function makeRepo(): Promise<string> {
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-sparse-')));
  roots.push(work);
  await git(work, ['init', '-q']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  // Windows по умолчанию держит autocrlf=true: без этой строки файлы из
  // рабочей папки приходят с \r\n, и тест сравнивает их с чистым \n.
  await git(work, ['config', 'core.autocrlf', 'false']);
  await fs.mkdir(path.join(work, 'src'));
  await fs.mkdir(path.join(work, 'docs'));
  await fs.writeFile(path.join(work, 'src', 'index.ts'), 'export {};\n');
  await fs.writeFile(path.join(work, 'docs', 'note.md'), '# note\n');
  await fs.writeFile(path.join(work, 'root.txt'), 'one\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'init']);
  return work;
}

describe('GitService: разреженный рабочий каталог', () => {
  it('по умолчанию режим выключен', async () => {
    if (!gitAvailable) return;
    const work = await makeRepo();
    expect(await serviceFor(work).sparseInfo()).toEqual({ enabled: false, cone: false, patterns: [] });
  });

  it('sparseSet выкладывает каталог, а файлы вне него исчезают с диска', async () => {
    if (!gitAvailable) return;
    const work = await makeRepo();

    const info = await serviceFor(work).sparseSet(['src']);

    expect(info.enabled).toBe(true);
    expect(info.cone).toBe(true);
    // Выбранный каталог выложен, файлы в корне остаются (это свойство cone-режима),
    // а вот другой каталог с диска уходит.
    expect(await exists(path.join(work, 'src', 'index.ts'))).toBe(true);
    expect(await exists(path.join(work, 'root.txt'))).toBe(true);
    expect(await exists(path.join(work, 'docs', 'note.md'))).toBe(false);
  });

  it('sparseAdd добавляет каталог к уже выбранным', async () => {
    if (!gitAvailable) return;
    const work = await makeRepo();
    await fs.mkdir(path.join(work, 'tests'));
    await fs.writeFile(path.join(work, 'tests', 'a.test.ts'), 'it();\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'add tests']);
    const service = serviceFor(work);

    await service.sparseSet(['src']);
    const info = await service.sparseAdd('tests');

    expect(info.enabled).toBe(true);
    expect(await exists(path.join(work, 'tests', 'a.test.ts'))).toBe(true);
  });

  it('sparseDisable возвращает на диск весь репозиторий', async () => {
    if (!gitAvailable) return;
    const work = await makeRepo();
    const service = serviceFor(work);

    await service.sparseSet(['src']);
    expect(await exists(path.join(work, 'docs', 'note.md'))).toBe(false);

    const info = await service.sparseDisable();
    expect(info.enabled).toBe(false);
    expect(await exists(path.join(work, 'docs', 'note.md'))).toBe(true);
  });

  it('sparseSet с пустым или мусорным набором — ошибка', async () => {
    if (!gitAvailable) return;
    const work = await makeRepo();
    const service = serviceFor(work);
    await expect(service.sparseSet([])).rejects.toThrow();
    await expect(service.sparseSet(['../etc'])).rejects.toThrow();
    await expect(service.sparseAdd('  ')).rejects.toThrow();
  });

  it('вне репозитория — ошибка, а не пустой ответ', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-nosparse-')));
    roots.push(base);
    await expect(serviceFor(base).sparseInfo()).rejects.toThrow();
  });
});
