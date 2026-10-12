import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/git';
import type { RebaseTodoItem } from '../src/shared/git-rebase';

/**
 * Интерактивный rebase на настоящем репозитории: список шагов уходит git через
 * свой редактор последовательности, поэтому проверять это иначе как живьём нельзя.
 * Репозиторий — в temp-каталоге, подпись и автотексты коммитов заданы локально.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

let gitAvailable = true;

beforeAll(async () => {
  gitAvailable = (await git(os.tmpdir(), ['--version'])).code === 0;
});

/** Репозиторий с базовым коммитом и тремя поверх него: их и перестраиваем. */
async function makeRepo(): Promise<{ work: string; base: string; commits: string[] }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rebase-')));
  roots.push(base);
  const work = path.join(base, 'work');
  await fs.mkdir(work);

  await git(work, ['init', '-q']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  await git(work, ['config', 'core.autocrlf', 'false']);

  const commit = async (file: string, text: string, message: string): Promise<string> => {
    await fs.writeFile(path.join(work, file), text);
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', message]);
    return (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
  };

  // База отдельно: `rebase -i HEAD~3` требует, чтобы перед тремя коммитами был ещё один.
  await commit('base.txt', 'base\n', 'base');
  const commits = [
    await commit('one.txt', 'one\n', 'one'),
    await commit('two.txt', 'two\n', 'two'),
    await commit('three.txt', 'three\n', 'three'),
  ];
  return { work, base, commits };
}

/** Тема коммитов от старых к новым. */
async function summaries(work: string): Promise<string[]> {
  const result = await git(work, ['log', '--format=%s', '--reverse']);
  return result.stdout.split('\n').filter(Boolean);
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

const todo = (action: RebaseTodoItem['action'], commit: string, message?: string): RebaseTodoItem => ({
  action,
  commit,
  subject: '',
  ...(message ? { message } : {}),
});

describe('GitService: интерактивный rebase', () => {
  it('drop выбрасывает коммит из истории', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();

    const result = await serviceFor(work).rebase(3, [
      todo('pick', commits[0]!),
      todo('drop', commits[1]!),
      todo('pick', commits[2]!),
    ]);

    expect(result.ok).toBe(true);
    expect(result.inProgress).toBe(false);
    expect(await summaries(work)).toEqual(['base', 'one', 'three']);
    // Файл выброшенного коммита исчез вместе с ним.
    await expect(fs.access(path.join(work, 'two.txt'))).rejects.toBeTruthy();
  });

  it('squash склеивает коммиты и соединяет сообщения', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();

    const result = await serviceFor(work).rebase(3, [
      todo('pick', commits[0]!),
      todo('pick', commits[1]!),
      todo('squash', commits[2]!),
    ]);

    expect(result.ok).toBe(true);
    const log = (await git(work, ['log', '--format=%B'])).stdout;
    expect(log).toContain('two');
    expect(log).toContain('three');
    expect((await summaries(work))[0]).toBe('base');
  });

  it('fixup склеивает, оставляя сообщение первого', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();

    const result = await serviceFor(work).rebase(3, [
      todo('pick', commits[0]!),
      todo('pick', commits[1]!),
      todo('fixup', commits[2]!),
    ]);

    expect(result.ok).toBe(true);
    // Сообщений 'three' в истории больше нет: коммит вошёл в предыдущий.
    expect(await summaries(work)).toEqual(['base', 'one', 'two']);
    expect(await summaries(work)).not.toContain('three');
  });

  it('reword переписывает сообщение коммита', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();

    const result = await serviceFor(work).rebase(3, [
      todo('pick', commits[0]!),
      todo('reword', commits[1]!, 'второй коммит переписан'),
      todo('pick', commits[2]!),
    ]);

    expect(result.ok).toBe(true);
    expect(await summaries(work)).toEqual(['base', 'one', 'второй коммит переписан', 'three']);
  });

  it('перестановка меняет порядок коммитов', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();

    const result = await serviceFor(work).rebase(3, [
      todo('pick', commits[0]!),
      todo('pick', commits[2]!),
      todo('pick', commits[1]!),
    ]);

    expect(result.ok).toBe(true);
    expect(await summaries(work)).toEqual(['base', 'one', 'three', 'two']);
  });

  it('конфликт останавливает rebase, а abort возвращает ветку', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();
    // Два коммита правят одну строку: перестановка даёт конфликт.
    await fs.writeFile(path.join(work, 'f.txt'), 'a\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'f base']);
    await fs.writeFile(path.join(work, 'f.txt'), 'b\n');
    await git(work, ['commit', '-aqm', 'f b']);
    const second = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    await fs.writeFile(path.join(work, 'f.txt'), 'c\n');
    await git(work, ['commit', '-aqm', 'f c']);
    const third = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    const head = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();

    const service = serviceFor(work);
    // Меняем порядок двух последних: 'c' применяется поверх 'a', затем 'b' — конфликт.
    const result = await service.rebase(2, [todo('pick', third), todo('pick', second)]);

    expect(result.conflict).toBe(true);
    expect(result.inProgress).toBe(true);
    expect(result.ok).toBe(false);

    await service.rebaseAbort();
    expect((await git(work, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
    expect(await summaries(work)).toEqual(['base', 'one', 'two', 'three', 'f base', 'f b', 'f c']);
    expect(commits).toHaveLength(3);
  });

  it('меньше коммитов, чем выбрано — понятная ошибка, а не ругань git', async () => {
    if (!gitAvailable) return;
    const { work, commits } = await makeRepo();
    await expect(serviceFor(work).rebase(99, [todo('pick', commits[0]!)])).rejects.toThrow(/меньше коммитов/);
  });
});
