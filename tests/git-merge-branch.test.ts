import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/git';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, () => resolve());
  });
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-merge-')));
  roots.push(dir);
  await git(dir, ['init', '-q', '-b', 'main', '--template=']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

async function commit(dir: string, file: string, text: string, message: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), text);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
}

describe('mergeBranch: вернуть задачу из отдельной ветки', () => {
  it('сливает ветку задачи в текущую и оставляет коммит слияния', async () => {
    const root = await makeRepo();
    await git(root, ['checkout', '-q', '-b', 'chui/task']);
    await commit(root, 'a.txt', 'два\n', 'правка задачи');
    await git(root, ['checkout', '-q', 'main']);

    const result = await serviceFor(root).mergeBranch('chui/task');

    expect(result.ok).toBe(true);
    expect(result.conflict).toBe(false);
    // git на Windows по умолчанию переводит файл в CRLF при checkout — это
    // настройка core.autocrlf, а не ошибка слияния. Сравниваем по строкам.
    expect((await fs.readFile(path.join(root, 'a.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('два\n');
    const log = await new Promise<string>((resolve) => {
      execFile('git', ['log', '--format=%s'], { cwd: root, windowsHide: true }, (_e, stdout) =>
        resolve(String(stdout)),
      );
    });
    expect(log).toContain('правка задачи');
  });

  it('конфликт не разрешает сама и говорит, что он конфликт', async () => {
    const root = await makeRepo();
    await git(root, ['checkout', '-q', '-b', 'chui/task']);
    await commit(root, 'a.txt', 'задача\n', 'правка задачи');
    await git(root, ['checkout', '-q', 'main']);
    await commit(root, 'a.txt', 'главная\n', 'правка главной');

    const result = await serviceFor(root).mergeBranch('chui/task');

    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.message).not.toBe('');
  });

  it('несуществующая ветка — отказ без падения', async () => {
    const root = await makeRepo();
    const result = await serviceFor(root).mergeBranch('chui/нет-такой');
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(false);
  });
});
