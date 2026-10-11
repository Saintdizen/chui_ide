import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/git';

/**
 * Сетевые операции git (fetch/pull/push) и список удалённых — это процессы и
 * файловая система, поэтому проверяем на настоящих репозиториях в temp-каталоге:
 * рабочий и пустой «сервер» (bare). Так проверяется вся связка целиком — запуск
 * git, постановка upstream при первой отправке и разбор итога.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Запустить git и дождаться выхода. Ошибку возвращаем, а не бросаем: так виднее тест. */
function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

let gitAvailable = true;

beforeAll(async () => {
  const probe = await git(os.tmpdir(), ['--version']);
  gitAvailable = probe.code === 0;
});

/**
 * Рабочий репозиторий с одним коммитом и bare-репозиторий как «origin».
 * `branch` — имя текущей ветки (зависит от настроек git: master или main).
 */
async function makeRepos(): Promise<{ work: string; bare: string; branch: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-net-'));
  roots.push(base);
  const work = path.join(base, 'work');
  const bare = path.join(base, 'origin.git');
  await fs.mkdir(work);

  await git(base, ['init', '-q', '--bare', bare]);
  await git(work, ['init', '-q']);
  // Подпись коммитов задаём локально: у сборочной машины её может не быть в конфиге.
  await git(work, ['config', 'user.email', 'test@example.com']);
  await git(work, ['config', 'user.name', 'Test']);
  await git(work, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(work, 'a.txt'), 'one\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'init']);
  await git(work, ['remote', 'add', 'origin', bare]);
  const branch = (await git(work, ['branch', '--show-current'])).stdout.trim();
  await git(work, ['push', '-q', '-u', 'origin', branch]);

  return { work, bare, branch };
}

/** Сервис над рабочей папкой: публикация статуса в тесте не нужна. */
function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

describe('GitService: удалённые и сеть', () => {
  it('remotes() перечисляет origin с адресами fetch и push', async () => {
    if (!gitAvailable) return;
    const { work, bare } = await makeRepos();

    const remotes = await serviceFor(work).remotes();

    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({ name: 'origin', fetchUrl: bare, pushUrl: bare });
  });

  it('push() первой отправки ветки ставит upstream у origin', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    // Ветка, которой ещё нет на удалённом и у которой не задан upstream.
    await git(work, ['checkout', '-q', '-b', 'feature']);

    const result = await serviceFor(work).push();

    expect(result.ok).toBe(true);
    const upstream = await git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    expect(upstream.stdout.trim()).toBe('origin/feature');
  });

  it('fetch() завершается успешно и не трогает рабочее дерево', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await fs.writeFile(path.join(work, 'a.txt'), 'local edit\n');

    const result = await serviceFor(work).fetch();

    expect(result.ok).toBe(true);
    // Локальная правка на месте: fetch только обновляет ссылки, не файлы.
    expect(await fs.readFile(path.join(work, 'a.txt'), 'utf8')).toBe('local edit\n');
  });

  it('pull() подтягивает коммит, сделанный в удалённом репозитории', async () => {
    if (!gitAvailable) return;
    const { work, bare, branch } = await makeRepos();

    // Второй клон кладёт коммит в origin — как это сделал бы коллега.
    const peer = path.join(path.dirname(work), 'peer');
    await git(path.dirname(work), ['clone', '-q', bare, peer]);
    await git(peer, ['config', 'user.email', 'peer@example.com']);
    await git(peer, ['config', 'user.name', 'Peer']);
    await fs.writeFile(path.join(peer, 'b.txt'), 'from peer\n');
    await git(peer, ['add', '-A']);
    await git(peer, ['commit', '-q', '-m', 'peer commit']);
    await git(peer, ['push', '-q', 'origin', branch]);

    const result = await serviceFor(work).pull();

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(work, 'b.txt'), 'utf8')).toBe('from peer\n');
  });

  it('push() без удалённого возвращает сбой текстом, а не бросает', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await git(work, ['remote', 'remove', 'origin']);

    const result = await serviceFor(work).push();

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
