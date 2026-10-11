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
  // Каталог сразу разворачиваем: на macOS `tmpdir()` — это `/var/folders/…`, за
  // которым стоит симлинк на `/private/var/…`. А `git rev-parse --show-toplevel`
  // возвращает канонический путь, и относительный путь от него к цели, названной
  // через симлинк, обрастал бы `../../..` — blame не находил бы файл. Приём тот
  // же, что в `debug.test.ts`: посторонний фактор (симлинк) убираем из проверки.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-net-')));
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
  // Содержимое сверяем посимвольно, а на Windows `core.autocrlf` по умолчанию
  // переводит строки в CRLF при выдаче файла на диск — тогда `pull` давал бы
  // `from peer\r\n` там, где в коммите лежит `from peer\n`.
  await git(work, ['config', 'core.autocrlf', 'false']);
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

  it('blame() называет автора строки и её коммит', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();

    const lines = await serviceFor(work).blame(path.join(work, 'a.txt'));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('one');
    expect(lines[0]!.author).toBe('Test');
    expect(lines[0]!.summary).toBe('init');
    expect(lines[0]!.hash).toHaveLength(7);
  });

  it('blame() неотслеживаемого файла — пустой список, а не сбой', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await fs.writeFile(path.join(work, 'new.txt'), 'x\n');

    expect(await serviceFor(work).blame(path.join(work, 'new.txt'))).toEqual([]);
  });

  it('headText() отдаёт версию файла в HEAD; новый файл — пустая строка', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);

    expect(await service.headText(path.join(work, 'a.txt'))).toBe('one\n');
    // Правка в рабочем дереве на версию в HEAD не влияет — это и есть база полосок.
    await fs.writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');
    expect(await service.headText(path.join(work, 'a.txt'))).toBe('one\n');

    await fs.writeFile(path.join(work, 'new.txt'), 'x\n');
    expect(await service.headText(path.join(work, 'new.txt'))).toBe('');
  });

  it('headText() вне репозитория — null (полосок быть не должно)', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-plain-')));
    roots.push(base);
    // Если сам temp-каталог лежит внутри репозитория, проверка «вне репозитория» бессмысленна.
    if ((await git(base, ['rev-parse', '--show-toplevel'])).code === 0) return;
    expect(await serviceFor(base).headText(path.join(base, 'x.txt'))).toBeNull();
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

describe('GitService: индексирование по блокам', () => {
  /**
   * Файл из двадцати строк с двумя правками врозь: между ними больше шести
   * строк контекста, поэтому git покажет их двумя разными блоками.
   */
  async function makeTwoHunks(): Promise<{ work: string; file: string }> {
    const { work } = await makeRepos();
    const file = path.join(work, 'a.txt');
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'base']);

    lines[0] = 'line 1 changed';
    lines[19] = 'line 20 changed';
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    return { work, file };
  }

  it('в индекс уходит только выбранный блок, остальные правки остаются', async () => {
    if (!gitAvailable) return;
    const { work, file } = await makeTwoHunks();
    const service = serviceFor(work);

    // Правки далеки друг от друга — git видит два блока.
    expect((await service.diff(file)).hunks).toHaveLength(2);

    const status = await service.stageHunk(file, 0);

    // Первый блок в индексе, второй — пока нет.
    const staged = await service.diff(file, true);
    expect(staged.modified).toContain('line 1 changed');
    expect(staged.modified).not.toContain('line 20 changed');

    // Второй блок остался правкой в рабочем дереве (и виден как один блок).
    const remaining = await service.diff(file, false);
    expect(remaining.hunks).toHaveLength(1);
    expect(remaining.modified).toContain('line 20 changed');

    // Файл и проиндексирован, и правится далее — как в настоящем частичном индексе.
    const entry = status.files.find((item) => item.path === file);
    expect(entry?.staged).toBe(true);
    expect(entry?.unstaged).toBe(true);
  });

  it('unstageHunk() убирает из индекса только выбранный блок', async () => {
    if (!gitAvailable) return;
    const { work, file } = await makeTwoHunks();
    const service = serviceFor(work);
    await service.stage([file]);

    expect((await service.diff(file, true)).hunks).toHaveLength(2);

    await service.unstageHunk(file, 0);

    const after = await service.diff(file, true);
    expect(after.hunks).toHaveLength(1);
    expect(after.modified).not.toContain('line 1 changed');
    expect(after.modified).toContain('line 20 changed');
  });
});

describe('GitService: история и просмотр против коммита', () => {
  it('log() отдаёт записи с хешем, автором, датой и заголовком', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await fs.writeFile(path.join(work, 'b.txt'), 'new file\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'add b']);

    const commits = await serviceFor(work).log();

    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits[0]).toMatchObject({ author: 'Test', summary: 'add b' });
    expect(commits[0]!.hash).toHaveLength(7);
    expect(commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('log() с путём оставляет только коммиты этого файла', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    // Второй коммит трогает только b.txt — в истории a.txt его быть не должно.
    await fs.writeFile(path.join(work, 'b.txt'), 'bee\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'only b']);

    const commits = await serviceFor(work).log(50, path.join(work, 'a.txt'));

    expect(commits).toHaveLength(1);
    expect(commits[0]!.summary).toBe('init');
  });

  it('diff() против коммита показывает правки, сделанные после него', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const file = path.join(work, 'a.txt');
    const [first] = await serviceFor(work).log(50, file);
    await fs.writeFile(file, 'one\ntwo\n');

    const diff = await serviceFor(work).diff(file, false, first!.hash);

    // original — состояние в коммите, modified — текущее дерево.
    expect(diff.original).toBe('one\n');
    expect(diff.modified).toBe('one\ntwo\n');
    expect(diff.hunks).toHaveLength(1);
  });

  it('diff() против коммита работает и когда файл сейчас без правок', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const file = path.join(work, 'a.txt');
    const [first] = await serviceFor(work).log(50, file);

    // Файл не менялся — обычное сравнение сказало бы «нет изменений», а просмотр
    // против коммита должен работать.
    const diff = await serviceFor(work).diff(file, false, first!.hash);
    expect(diff.original).toBe(diff.modified);
    expect(diff.hunks).toEqual([]);
  });
});

describe('GitService: конфликты слияния', () => {
  /**
   * Репозиторий с настоящим конфликтом: обе ветки правят одну строку.
   * Возвращает имя файла и ожидаемые стороны.
   */
  async function makeConflict(): Promise<{ work: string; file: string }> {
    const { work, branch } = await makeRepos();
    const file = path.join(work, 'conflict.txt');
    await fs.writeFile(file, 'base\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'base']);

    // Ветка со своей правкой той же строки.
    await git(work, ['checkout', '-q', '-b', 'feature']);
    await fs.writeFile(file, 'feature\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'feature edit']);

    // Возвращаемся на основную ветку и правим ту же строку иначе — слияние конфликтует.
    await git(work, ['checkout', '-q', branch]);
    await fs.writeFile(file, 'main\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'main edit']);
    await git(work, ['merge', 'feature']);
    return { work, file };
  }

  it('статус показывает конфликтный файл', async () => {
    if (!gitAvailable) return;
    const { work, file } = await makeConflict();

    const status = await serviceFor(work).status();

    expect(status.files.find((item) => item.path === file)?.change).toBe('conflicted');
  });

  it('conflictParts() отдаёт общий предок и обе стороны', async () => {
    if (!gitAvailable) return;
    const { work, file } = await makeConflict();

    const parts = await serviceFor(work).conflictParts(file);

    expect(parts.base).toBe('base\n');
    expect(parts.ours).toBe('main\n');
    expect(parts.theirs).toBe('feature\n');
  });

  it('markResolved() убирает конфликт, забрав текущий текст в индекс', async () => {
    if (!gitAvailable) return;
    const { work, file } = await makeConflict();
    const service = serviceFor(work);

    // «Разрешаем» вручную: пишем выбранный текст без маркеров.
    await fs.writeFile(file, 'resolved\n');
    const status = await service.markResolved(file);

    const entry = status.files.find((item) => item.path === file);
    expect(entry?.change).not.toBe('conflicted');
    expect(entry?.staged).toBe(true);
  });
});
