import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitService } from '../src/main/git/git';
import { hunkAtLine } from '../src/shared/hunk-lines';
import { lineChanges } from '../src/shared/git-line-changes';

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

/** Есть ли команда в PATH (для проверок клиентов площадки). */
function shellHas(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', `command -v ${command}`], { windowsHide: true }, (error) => resolve(error === null));
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

  it('pull() без режима не подсказывает git флагов (поведение как настроено)', async () => {
    if (!gitAvailable) return;
    const { work, bare, branch } = await makeRepos();
    const peer = path.join(path.dirname(work), 'peer');
    await git(path.dirname(work), ['clone', '-q', bare, peer]);
    await git(peer, ['config', 'user.email', 'peer@example.com']);
    await git(peer, ['config', 'user.name', 'Peer']);
    await fs.writeFile(path.join(peer, 'c.txt'), 'peer\n');
    await git(peer, ['add', '-A']);
    await git(peer, ['commit', '-q', '-m', 'peer']);
    await git(peer, ['push', '-q', 'origin', branch]);

    // Локально чисто и позади — слияние перемоткой проходит в любом режиме.
    const result = await serviceFor(work).pull('default');
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(work, 'c.txt'), 'utf8')).toBe('peer\n');
  });

  it('pull(ff-only) отказывается вливать разошедшиеся ветки', async () => {
    if (!gitAvailable) return;
    const { work, bare, branch } = await makeRepos();
    // Коллега ушёл вперёд в origin.
    const peer = path.join(path.dirname(work), 'peer');
    await git(path.dirname(work), ['clone', '-q', bare, peer]);
    await git(peer, ['config', 'user.email', 'peer@example.com']);
    await git(peer, ['config', 'user.name', 'Peer']);
    await fs.writeFile(path.join(peer, 'peer.txt'), 'peer\n');
    await git(peer, ['add', '-A']);
    await git(peer, ['commit', '-q', '-m', 'peer']);
    await git(peer, ['push', '-q', 'origin', branch]);
    // А мы сделали свой коммит поверх старого — история разошлась.
    await fs.writeFile(path.join(work, 'mine.txt'), 'mine\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'mine']);

    const result = await serviceFor(work).pull('ff-only');
    // Отказ — не исключение: git говорит текстом, что перемотка невозможна, а правки целы.
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('fast-forward');
    expect(await fs.readFile(path.join(work, 'mine.txt'), 'utf8')).toBe('mine\n');
  });

  it('compareRefs() перечисляет различия между ветками, diffRefs() — текст файла', async () => {
    if (!gitAvailable) return;
    const { work, branch } = await makeRepos();
    // В отдельной ветке меняем файл, добавляем новый и переименовываем прежний.
    await git(work, ['checkout', '-q', '-b', 'feature']);
    await fs.writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(work, 'b.txt'), 'new\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'feature work']);

    const service = serviceFor(work);
    const diff = await service.compareRefs(branch, 'feature');

    expect(diff.base).toBe(branch);
    expect(diff.head).toBe('feature');
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get('b.txt')).toMatchObject({ change: 'added', additions: 1, deletions: 0 });
    expect(byPath.get('a.txt')).toMatchObject({ change: 'modified', additions: 1, deletions: 0 });

    // Текст файла: слева версия из первой ссылки, справа — из второй.
    const fileDiff = await service.diffRefs(branch, 'feature', path.join(work, 'a.txt'));
    expect(fileDiff.original).toBe('one\n');
    expect(fileDiff.modified).toBe('one\ntwo\n');
    // Просмотр между ветками — не подготовка коммита: блоков для индекса нет.
    expect(fileDiff.hunks).toEqual([]);
  });

  it('compareRefs() не принимает ссылку, начинающуюся с дефиса', async () => {
    if (!gitAvailable) return;
    const { work, branch } = await makeRepos();
    await expect(serviceFor(work).compareRefs('--help', branch)).rejects.toThrow(/Некорректная ссылка/);
  });

  it('bisect находит первый плохой коммит и reset возвращает ветку', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    // Три коммита: в среднем «ломается» файл, третий просто продолжает историю.
    const commit = async (file: string, text: string, message: string): Promise<string> => {
      await fs.writeFile(path.join(work, file), text);
      await git(work, ['add', '-A']);
      await git(work, ['commit', '-q', '-m', message]);
      return (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    };
    const good = await commit('b.txt', 'ok\n', 'good');
    const bad = await commit('b.txt', 'broken\n', 'bad');
    await commit('c.txt', 'more\n', 'after');
    const headBefore = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();

    const service = serviceFor(work);
    let state = await service.bisectStart({ bad: 'HEAD', good });
    expect(state.active).toBe(true);
    expect(state.current).not.toBeNull();

    // Отвечаем, пока git не назовёт виновника: проверяемый коммит не старше «плохого».
    let guard = 0;
    const isBad = async (): Promise<boolean> => (await git(work, ['log', '-1', '--format=%s'])).stdout.trim() === 'bad';
    while (state.active && guard < 10) {
      state = await service.bisectMark((await isBad()) ? 'bad' : 'good');
      guard += 1;
    }

    // git печатает короткий хеш — он должен быть началом полного.
    expect(bad.startsWith(state.firstBad!)).toBe(true);
    expect(state.active).toBe(false);

    await service.bisectReset();
    expect((await git(work, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    const after = await service.bisectState();
    expect(after.active).toBe(false);
  });

  it('bisectState() без поиска говорит, что он не идёт', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const state = await serviceFor(work).bisectState();
    expect(state.active).toBe(false);
    expect(state.current).toBeNull();
  });

  it('checkIgnore() отвечает только про игнорируемые пути', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await fs.writeFile(path.join(work, '.gitignore'), 'dist/\n*.log\n');
    await fs.mkdir(path.join(work, 'dist'));
    await fs.writeFile(path.join(work, 'dist', 'bundle.js'), 'x\n');
    await fs.writeFile(path.join(work, 'debug.log'), 'log\n');
    await fs.writeFile(path.join(work, 'keep.ts'), 'ok\n');

    const asked = [
      path.join(work, 'dist'),
      path.join(work, 'dist', 'bundle.js'),
      path.join(work, 'debug.log'),
      path.join(work, 'keep.ts'),
    ];
    const ignored = await serviceFor(work).checkIgnore(asked);

    expect(ignored).toContain(path.join(work, 'dist'));
    expect(ignored).toContain(path.join(work, 'dist', 'bundle.js'));
    expect(ignored).toContain(path.join(work, 'debug.log'));
    // Обычный файл не игнорируется — его в ответе нет.
    expect(ignored).not.toContain(path.join(work, 'keep.ts'));
  });

  it('checkIgnore() вне репозитория и без путей — пустой ответ, а не сбой', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-nogit-')));
    roots.push(base);
    const service = serviceFor(base);
    expect(await service.checkIgnore([path.join(base, 'x.ts')])).toEqual([]);
    expect(await service.checkIgnore([])).toEqual([]);
  });

  it('submodules() показывает подмодуль и его состояние', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-sub-')));
    roots.push(base);
    const inner = path.join(base, 'inner');
    const work = path.join(base, 'work');
    // Отдельный репозиторий, который подключим подмодулем.
    await fs.mkdir(inner);
    await git(inner, ['init', '-q']);
    await git(inner, ['config', 'user.email', 'inner@example.com']);
    await git(inner, ['config', 'user.name', 'Inner']);
    await fs.writeFile(path.join(inner, 'a.txt'), 'a\n');
    await git(inner, ['add', '-A']);
    await git(inner, ['commit', '-q', '-m', 'inner']);

    await fs.mkdir(work);
    await git(work, ['init', '-q']);
    await git(work, ['config', 'user.email', 'test@example.com']);
    await git(work, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(work, 'm.txt'), 'm\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'main']);
    // Файловые подмодули git разрешает не всегда: включаем явно, как это делает сам git.
    await git(work, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../inner', 'mods/inner']);
    await git(work, ['commit', '-q', '-m', 'add submodule']);

    const service = serviceFor(work);
    const list = await service.submodules();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: 'mods/inner', state: 'ok' });
    expect(list[0]!.hash).toMatch(/^[0-9a-f]{7,40}$/);

    // Забранный код на месте: deinit убирает его, и состояние становится «не забран».
    await git(work, ['submodule', 'deinit', '-q', 'mods/inner']);
    const after = await service.submodules();
    expect(after[0]?.state).toBe('missing');

    await service.submoduleUpdate();
    const restored = await service.submodules();
    expect(restored[0]?.state).toBe('ok');
    await expect(fs.access(path.join(work, 'mods', 'inner', 'a.txt'))).resolves.toBeUndefined();
  });

  it('lfsInfo(): шаблоны читаются всегда, а без git-lfs честно говорит «недоступен»', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lfs-')));
    roots.push(base);
    const work = path.join(base, 'work');
    await fs.mkdir(work);
    await git(work, ['init', '-q']);
    await git(work, ['config', 'user.email', 'test@example.com']);
    await git(work, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(work, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'init']);

    const service = serviceFor(work);
    const info = await service.lfsInfo();
    // Шаблоны лежат в .gitattributes: их видно и без установленного git-lfs.
    expect(info.patterns.map((item) => item.pattern)).toEqual(['*.bin']);
    expect(info.configured).toBe(true);

    // Наличие самого git-lfs зависит от машины: проверяем, что ответ ему соответствует.
    const hasLfs = (await git(work, ['lfs', 'version'])).code === 0;
    expect(info.available).toBe(hasLfs);
    if (!hasLfs) {
      expect(info.files).toEqual([]);
      // И операция, которой нечего делать без git-lfs, объясняет причину.
      await expect(service.lfsTrack('*.psd')).rejects.toThrow(/lfs/i);
    }
  });

  it('forgeInfo(): узнаёт площадку по адресу и честно говорит про клиента', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    // Ставим адрес GitHub: сеть для этого не нужна — только разбор адреса.
    await git(work, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);

    const service = serviceFor(work);
    const info = await service.forgeInfo();
    expect(info.repo).toMatchObject({ platform: 'github', host: 'github.com', owner: 'acme', repo: 'web' });
    expect(info.remote).toBe('origin');
    expect(info.cli).toBe('gh');

    // Наличие клиента зависит от машины: ответ должен ему соответствовать.
    const hasGh = (await git(work, ['--version'])).code === 0 && (await shellHas('gh'));
    expect(info.cliAvailable).toBe(hasGh);
    if (!hasGh) expect(info.note).toContain('gh');
  });

  it('forgeInfo(): свой GitLab узнаётся и без клиента', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await git(work, ['remote', 'set-url', 'origin', 'https://gitlab.example.com/team/sub/api.git']);
    const info = await serviceFor(work).forgeInfo();
    expect(info.repo).toMatchObject({ platform: 'gitlab', host: 'gitlab.example.com', owner: 'team/sub', repo: 'api' });
    expect(info.cli).toBe('glab');
  });

  it('forgeCheckout() без клиента объясняет причину', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await git(work, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);
    const service = serviceFor(work);
    const info = await service.forgeInfo();
    // Кейс верен только там, где клиента нет (в CI его тоже не будет).
    if (info.cliAvailable) return;
    await expect(service.forgeCheckout(1)).rejects.toThrow(/gh/);
  });

  it('identity(): читает настройки, setIdentity() пишет их в ЛОКАЛЬНЫЙ конфиг', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);

    const before = await service.identity();
    expect(before.name).toBe('Test');
    expect(before.email).toBe('test@example.com');
    expect(before.signCommits).toBe(false);

    const next = await service.setIdentity({
      name: 'Новый Автор',
      signCommits: true,
      signingKey: '/нет/такого/ключа.gpg',
    });
    expect(next.name).toBe('Новый Автор');
    expect(next.signCommits).toBe(true);
    // Ключа на диске нет — окно должно это знать, а не узнавать на коммите.
    expect(next.keyFound).toBe(false);

    // Настройка легла в конфиг репозитория, а не в глобальные настройки человека.
    const local = await git(work, ['config', '--local', '--get', 'commit.gpgsign']);
    expect(local.stdout.trim()).toBe('true');
    const global = await git(work, ['config', '--global', '--get', 'user.name']);
    expect(global.stdout.trim()).not.toBe('Новый Автор');
  });

  it('sshKeys(): отдаёт открытые ключи из ~/.ssh (список может быть пустым)', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const keys = await serviceFor(work).sshKeys();
    expect(Array.isArray(keys)).toBe(true);
    for (const key of keys) {
      expect(key.path.endsWith('.pub')).toBe(true);
      expect(key.publicKey.length).toBeGreaterThan(0);
      expect(key.type.length).toBeGreaterThan(0);
    }
  });

  it('worktrees(): добавить, увидеть и удалить рабочий каталог', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);

    const before = await service.worktrees();
    expect(before).toHaveLength(1);
    expect(before[0]?.path).toBe(await fs.realpath(work));

    // Отдельный каталог на новой ветке рядом с рабочим.
    const extra = path.join(path.dirname(work), 'extra');
    const added = await service.worktreeAdd(extra, { newBranch: 'task' });
    expect(added).toHaveLength(2);
    const created = added.find((item) => item.path === extra);
    expect(created).toMatchObject({ branch: 'task' });
    // Каталог существует и в нём лежит рабочее дерево репозитория.
    await expect(fs.access(path.join(extra, 'a.txt'))).resolves.toBeUndefined();

    // Удаляем и убеждаемся, что запись ушла и папки больше нет.
    const after = await service.worktreeRemove(extra);
    expect(after).toHaveLength(1);
    await expect(fs.access(extra)).rejects.toBeTruthy();
  });

  it('worktrees() вне репозитория — пустой список, а не сбой', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-nowt-')));
    roots.push(base);
    expect(await serviceFor(base).worktrees()).toEqual([]);
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

  it('commit с amend заменяет последний коммит, не добавляя новый', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    const count = (): Promise<string> =>
      git(work, ['rev-list', '--count', 'HEAD']).then((result) => result.stdout.trim());

    const before = await count();
    await fs.writeFile(path.join(work, 'a.txt'), 'one\nchanged\n');
    await git(work, ['add', '-A']);
    // Пустое сообщение при amend сохраняет прежнее.
    const kept = await service.commit('', undefined, true);
    expect(kept.summary).toBe('init');
    expect(await count()).toBe(before);
    // Новое сообщение — заменяет.
    const renamed = await service.commit('исправлено', undefined, true);
    expect(renamed.summary).toBe('исправлено');
    expect(await count()).toBe(before);
  });

  it('commit без amend отказывается от пустого сообщения', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await expect(serviceFor(work).commit('   ')).rejects.toThrow();
  });

  it('commit с amend в репозитории без коммитов — понятная ошибка', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-empty-')));
    roots.push(base);
    await git(base, ['init', '-q']);
    await git(base, ['config', 'user.email', 'test@example.com']);
    await git(base, ['config', 'user.name', 'Test']);
    await expect(serviceFor(base).commit('', undefined, true)).rejects.toThrow();
  });

  it('stash: сохранить, показать, всплыть', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    await fs.writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');

    await service.stashSave({ message: 'моя правка' });
    // Рабочее дерево вернулось к HEAD, правка уехала в запись.
    expect(await fs.readFile(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');

    const list = await service.stashList();
    expect(list).toHaveLength(1);
    expect(list[0]!.message).toBe('моя правка');
    expect(list[0]!.branch).toBeTruthy();

    expect(await service.stashShow(0)).toContain('two');

    await service.stashPop(0);
    expect(await fs.readFile(path.join(work, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await service.stashList()).toEqual([]);
  });

  it('stash: apply оставляет запись, drop её удаляет', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    await fs.writeFile(path.join(work, 'a.txt'), 'one\nx\n');
    await service.stashSave();

    await service.stashApply(0);
    expect(await service.stashList()).toHaveLength(1);

    await service.stashDrop(0);
    expect(await service.stashList()).toEqual([]);
  });

  it('stash: список пуст в чистом репозитории', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    expect(await serviceFor(work).stashList()).toEqual([]);
  });

  it('cherry-pick переносит коммит из другой ветки', async () => {
    if (!gitAvailable) return;
    const { work, branch } = await makeRepos();
    const service = serviceFor(work);
    await git(work, ['checkout', '-q', '-b', 'feature']);
    await fs.writeFile(path.join(work, 'c.txt'), 'c\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'feature commit']);
    const hash = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(work, ['checkout', '-q', branch]);

    await service.cherryPick(hash);

    expect(await fs.readFile(path.join(work, 'c.txt'), 'utf8')).toBe('c\n');
  });

  it('revert отменяет коммит новым коммитом', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    await fs.writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'add two']);
    const hash = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();

    await service.revert(hash);

    expect(await fs.readFile(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');
    // Отменяющий коммит — третий в репозитории.
    expect((await git(work, ['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe('3');
  });

  it('reset hard откатывает рабочее дерево к коммиту', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    const head = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    await fs.writeFile(path.join(work, 'a.txt'), 'грязная правка\n');

    await service.reset('hard', head);

    expect(await fs.readFile(path.join(work, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('tags: создать, перечислить и удалить', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    expect(await service.tags()).toEqual([]);

    await service.createTag('v1.0.0');

    const tags = await service.tags();
    expect(tags).toHaveLength(1);
    expect(tags[0]!.name).toBe('v1.0.0');
    expect(tags[0]!.commit).toHaveLength(7);

    await service.deleteTag('v1.0.0');
    expect(await service.tags()).toEqual([]);
  });

  it('ссылка на коммит не может начинаться с дефиса', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await expect(serviceFor(work).cherryPick('-x')).rejects.toThrow();
  });

  it('deleteBranch удаляет ветку, renameBranch переименовывает текущую', async () => {
    if (!gitAvailable) return;
    const { work, branch } = await makeRepos();
    const service = serviceFor(work);
    await git(work, ['branch', 'temp']);
    await service.deleteBranch('temp');
    expect((await service.branches()).map((item) => item.name)).not.toContain('temp');

    await service.renameBranch(branch, 'renamed');
    const names = (await service.branches()).map((item) => item.name);
    expect(names).toContain('renamed');
    expect(names).not.toContain(branch);
  });

  it('ignore добавляет путь в .gitignore и не дублирует его', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const service = serviceFor(work);
    await fs.writeFile(path.join(work, 'debug.log'), 'x\n');

    await service.ignore([path.join(work, 'debug.log')]);
    const content = await fs.readFile(path.join(work, '.gitignore'), 'utf8');
    expect(content).toContain('debug.log');
    // Игнорируемый файл пропадает из статуса.
    expect((await service.status()).files.some((file) => file.relative === 'debug.log')).toBe(false);

    await service.ignore([path.join(work, 'debug.log')]);
    const again = await fs.readFile(path.join(work, '.gitignore'), 'utf8');
    expect(again.match(/debug\.log/g)).toHaveLength(1);
  });

  it('reflog отдаёт записи с ссылкой и описанием', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const entries = await serviceFor(work).reflog(10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.ref).toBe('HEAD@{0}');
    expect(entries[0]!.hash).toHaveLength(7);
  });

  it('logGraph отдаёт граф веток текстом', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const text = await serviceFor(work).logGraph(10);
    expect(text).toContain('*');
    expect(text).toContain('init');
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

describe('GitService: сводка по корням рабочей области', () => {
  it('видит репозиторий в одной папке и его отсутствие в другой', async () => {
    if (!gitAvailable) return;
    const { work, branch } = await makeRepos();
    // Рядом с репозиторием — обычная папка: в области она тоже корень, но не репозиторий.
    const plain = path.join(path.dirname(work), 'plain');
    await fs.mkdir(plain);
    await fs.writeFile(path.join(work, 'a.txt'), 'two\n');

    const summaries = await serviceFor(work).summary([
      { root: work, name: 'work' },
      { root: plain, name: 'plain' },
    ]);

    expect(summaries.map((item) => item.name)).toEqual(['work', 'plain']);
    expect(summaries[0]?.repository?.branch).toBe(branch);
    expect(summaries[0]?.files).toBe(1);
    expect(summaries[1]?.repository).toBeNull();
    expect(summaries[1]?.files).toBe(0);
  });
});

describe('GitService: diff будущего коммита', () => {
  it('без индекса показывает правки рабочего дерева и новые файлы', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    await fs.writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(work, 'fresh.txt'), 'новый\n');

    const diff = await serviceFor(work).commitDiff();

    expect(diff.staged).toBe(false);
    expect(diff.diff).toContain('+two');
    // Новый файл в `git diff` не виден вовсе — его отдаём именем.
    expect(diff.untracked).toContain('fresh.txt');
    expect(diff.files).toBe(2);
    expect(diff.truncated).toBe(false);
  });

  it('с индексом — ровно содержимое будущего коммита (индекс против HEAD)', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const file = path.join(work, 'a.txt');
    await fs.writeFile(file, 'staged\n');
    await git(work, ['add', '-A']);
    // Вторая правка — уже ПОСЛЕ индексации: в коммит она не попадёт и в diff быть не должна.
    await fs.writeFile(file, 'staged\nunstaged\n');

    const diff = await serviceFor(work).commitDiff();

    expect(diff.staged).toBe(true);
    expect(diff.diff).toContain('+staged');
    expect(diff.diff).not.toContain('+unstaged');
    expect(diff.files).toBe(1);
  });

  it('вне репозитория возвращает пустой diff, а не сбой', async () => {
    if (!gitAvailable) return;
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-plain-')));
    roots.push(base);

    const diff = await serviceFor(base).commitDiff();

    expect(diff).toEqual({ diff: '', staged: false, truncated: false, files: 0, untracked: [] });
  });
});

describe('GitService: блоки файла для действий из жёлоба', () => {
  it('fileHunks разделяет правки на неиндексированные и проиндексированные', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const file = path.join(work, 'a.txt');
    const service = serviceFor(work);

    // Первая правка уходит в индекс, вторая остаётся только в рабочем дереве.
    await fs.writeFile(file, 'one\nin-index\n');
    await git(work, ['add', 'a.txt']);
    await fs.writeFile(file, 'one\nin-index\nnot-indexed\n');

    const hunks = await service.fileHunks(file);

    expect(hunks.staged).toHaveLength(1);
    expect(hunks.unstaged).toHaveLength(1);
    // Добавленная строка «not-indexed» — третья в файле; именно её и находим по строке.
    // Блок diff покрывает и строки контекста вокруг правки, но щёлкают в жёлобе лишь по
    // полоскам, а они стоят только на изменённых строках — в блок попасть не мимо.
    expect(hunkAtLine(hunks.unstaged, 3)).toBe(0);
    // Правка в индексе тоже находится: та же строка в staged-блоке.
    expect(hunkAtLine(hunks.staged, 1)).toBe(0);
  });

  it('строка полоски из жёлоба попадает в свой блок', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const file = path.join(work, 'a.txt');
    const service = serviceFor(work);

    const original = 'one\n';
    const modified = 'one\ntwo\nthree\n';
    await fs.writeFile(file, modified);

    const diff = await service.diff(file);
    const stripes = lineChanges(diff.original, diff.modified);

    // Каждая полоска обязана найти свой блок: иначе щелчок по ней не сработает.
    expect(stripes.length).toBeGreaterThan(0);
    for (const stripe of stripes) {
      expect(hunkAtLine(diff.hunks, stripe.line)).not.toBeNull();
    }
    // И наоборот: строка без полоски блок не находит — щелчок по пустому месту молчит.
    expect(hunkAtLine(diff.hunks, 99)).toBeNull();
    expect(original).toBe('one\n');
  });

  it('discardHunk возвращает один блок к состоянию индекса, не трогая соседний', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    const file = path.join(work, 'lines.txt');
    const service = serviceFor(work);

    // Две правки в разных местах файла — достаточно далеко, чтобы git дал два блока.
    const lines = Array.from({ length: 30 }, (_, index) => `строка ${index + 1}`);
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    await git(work, ['add', 'lines.txt']);
    await git(work, ['commit', '-q', '-m', 'lines']);

    const edited = [...lines];
    edited[2] = 'строка 3 ИЗМЕНЕНА';
    edited[25] = 'строка 26 ИЗМЕНЕНА';
    await fs.writeFile(file, `${edited.join('\n')}\n`);

    const hunks = await service.fileHunks(file);
    expect(hunks.unstaged).toHaveLength(2);

    // Откатываем первый блок — второй должен остаться как был.
    await service.discardHunk(file, 0);
    const text = await fs.readFile(file, 'utf8');

    expect(text).toContain('строка 3\n');
    expect(text).not.toContain('строка 3 ИЗМЕНЕНА');
    expect(text).toContain('строка 26 ИЗМЕНЕНА');
  });

  it('fileHunks у файла без правок отдаёт пустые наборы, а не ошибку', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    // Файл чист: между щелчком и запросом его могли сохранить или закоммитить.
    const hunks = await serviceFor(work).fileHunks(path.join(work, 'a.txt'));
    expect(hunks).toEqual({ unstaged: [], staged: [] });
  });
});
