import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { removeTemp } from './temp';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitService, repositoryMetaDir } from '../src/main/git/git';
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
  await removeTemp(roots);
});

/** Запустить git и дождаться выхода. Ошибку возвращаем, а не бросаем: так виднее тест. */
function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // `-c safe.directory=*` перед каждой подкомандой — не про безопасность, а про время.
      // Без него git при каждом опознании репозитория сверяет владельца со списком из
      // системного и глобального конфигов машины. В этом файле ~750 запусков git за прогон,
      // и на Windows чтение наследства машины стоит заметно дорого: замер на раннере 24.10 —
      // 72.5 / 76.0с без флага против 51.9 / 52.3с с ним (разброс внутри пары ~3%).
      ['-c', 'safe.directory=*', ...args],
      { cwd, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Положить в начало PATH свою исполняемую команду — заглушку клиента (`gh`, `git-lfs`).
 *
 * Наличие этих инструментов на машине от теста не зависит: на CI они обычно есть, на
 * рабочей машине — не обязательно. А сверять свой замер («есть ли команда») с ответом
 * сервиса нельзя: это ДВА разных запуска одного и того же, и на загруженной машине они
 * вправе разойтись (один не уложился в таймаут). Своя заглушка делает ответ известным
 * заранее — и одинаковым на любой машине. Скрипт молчит и отдаёт нужный код: так
 * проверяются оба случая, «клиент есть» и «клиента нет».
 *
 * Возвращает функцию, возвращающую PATH как было.
 */
async function withStubCommand(name: string, ok: boolean): Promise<() => void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-cli-stub-'));
  roots.push(dir);
  const code = ok ? 0 : 1;
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(dir, `${name}.cmd`), `@echo off\r\nexit /b ${code}\r\n`, 'utf8');
  } else {
    const file = path.join(dir, name);
    await fs.writeFile(file, `#!/bin/sh\nexit ${code}\n`, 'utf8');
    await fs.chmod(file, 0o755);
  }
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  return () => {
    process.env.PATH = previous;
  };
}

/**
 * Работает ли заглушка из PATH: на Windows `.cmd`/`.bat` через `execFile` не
 * запускается (нужен cmd.exe), поэтому там остаётся терпимая проверка «как получится».
 */
const stubSupported = process.platform !== 'win32';

let gitAvailable = true;

beforeAll(async () => {
  const probe = await git(os.tmpdir(), ['--version']);
  gitAvailable = probe.code === 0;
});

/**
 * Рабочий репозиторий с одним коммитом и bare-репозиторий как «origin».
 * `branch` — имя текущей ветки (зависит от настроек git: master или main).
 */
async function makeRepos(
  afterClone?: (work: string) => Promise<void>,
): Promise<{ work: string; bare: string; branch: string }> {
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

  // `--template=` — пустой каталог шаблонов: без него git пишет хук `pre-commit` и
  // примеры из `/usr/share/git-core`, а они не нужны ни одному тесту (замер:
  // 20 init с шаблоном — 62мс, без — 52мс). Сервис настроек не читает, так что
  // пропажа папки `info` (в ней `exclude`) тестам не мешает.
  // Два `init` одним процессом НЕ сделать: `git init` принимает ровно один каталог
  // (проверено: `git init a b` — usage, код 129). Путь — `git init --bare <каталог>`
  // в иерархии каталогов того же вызова не спасает: bare-разметка иная, чем у рабочего.
  await git(base, ['init', '-q', '--bare', '--template=', bare]);
  await git(work, ['init', '-q', '--template=']);
  // Четыре настройки дописываем в `.git/config` ОДНОЙ записью файла, а не четырьмя
  // `git config`: на Windows каждый запуск процесса стоит ~150–300 мс, и это были
  // 4 из 15 процессов на репозиторий, повторяемые 74 раза за прогон. `makeRepos`
  // зовётся либо один раз (снимок), либо тестом, которому нужен свой bare, — файл
  // пишется там же, где раньше садились команды.
  //
  // Почему не `-c key=val` у `init`/`commit`: проверено — `-c` действует только на
  // свой процесс и в `.git/config` НЕ попадает (после `commit` с `-c user.name`
  // в конфиге остаются одни `core.*`, автор теряется).
  //
  // Подпись коммитов — локально: у сборочной машины её может не быть в конфиге.
  // `core.autocrlf=false` — Windows по умолчанию держит `true` и отдаёт файлы из
  // рабочей папки с `\r\n` там, где в коммите лежит `\n` (проверки сравнивают
  // содержимое посимвольно). Второй раздел `[core]` дописывается перед домолчанием
  // git — так и делает сам git, дубли ключей в конфиге законны.
  const configPath = path.join(work, '.git', 'config');
  await fs.appendFile(
    configPath,
    '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n',
  );
  await fs.writeFile(path.join(work, 'a.txt'), 'one\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'init']);
  const branch = (await git(work, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  // `remote add` + `push` в один процесс НЕ сводятся: проверил — `git push -u
  // <адрес> <ветка>` адрес принимает, но `remote.origin.fetch/pushurl` НЕ создаёт
  // (в конфиге только `branch.<имя>.remote = <адрес>`), а тесты `remotes()` и `push()`
  // ждут именно именованный origin. Ветку берём у git: master или main решает
  // настройка машины, угадывать нельзя.
  await git(work, ['remote', 'add', 'origin', bare]);
  // `push -u` сам заводит ветку на сервере и ставит upstream — одно действие вместо
  // `push` + ручного `update-ref`.
  await git(work, ['push', '-q', '-u', 'origin', branch]);
  // Поверх клона: сценам, которым нужна ПРОДВИНУТАЯ история, не надо заводить свой
  // репозиторий — коммит дешевле нового `init` с `config`, `push` и `remote add`.

  if (afterClone) await afterClone(work);

  return { work, bare, branch };
}

/** Коммит одного файла: три сцены про `pull` делают ровно это. */
async function commitFile(work: string, name: string, body: string, message: string): Promise<void> {
  await fs.writeFile(path.join(work, name), body);
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', message]);
}

/** Клон «коллеги»: своя личность на каждый клон, иначе коммит не встанет на чужой машине. */
async function peerCommit(peer: string, name: string, body: string, message: string, branch: string): Promise<void> {
  await git(peer, ['config', 'user.email', 'peer@example.com']);
  await git(peer, ['config', 'user.name', 'Peer']);
  await commitFile(peer, name, body, message);
  await git(peer, ['push', '-q', 'origin', branch]);
}

/**
 * Готовый репозиторий, который тестам нужно только ЧИТАТЬ.
 *
 * Создание с нуля стоит дорого, и почти целиком — не наши файлы, а служебное:
 * `git init` (5 мс) пишет хук и примеры, первый `commit` вместе с `add` (ещё ~9 мс)
 * кладёт сжатые словари подсказок, которыми пакетный менеджер набивает
 * `/usr/share/git-core` в кеш. Клон этого же репозитория — около 10 мс, и он
 * сразу имеет историю, ветку и remote. Поэтому основной репозиторий делается один
 * раз лениво, а каждый тест получает СВОЮ копию — общего состояния у тестов нет.
 *
 * Кто меняет историю (коммиты, ветки, bisect, rebase) — тот продолжает звать `makeRepos()`:
 * копия не должна оказаться в чужих руках.
 */
let snapshot: Promise<{ work: string; bare: string; branch: string }> | null = null;

async function readOnlyRepo(): Promise<{ work: string; bare: string; branch: string }> {
  let made: { work: string; bare: string; branch: string } | null = null;
  try {
    made = await snapshot;
  } catch {
    // Прошлая попытка не удалась (git не встал, каталог недоступен) — пробуем заново.
  }
  // Снимок ленивый — значит живёт дольше одного теста, а `roots` чистит всё после
  // каждого теста: второй получил бы «репозитория не существует». Потому готовый
  // снимок проверяем наличием `.git` и при нужде делаем заново.
  if (
    made === null ||
    !(await fs.stat(path.join(made.work, '.git')).then(
      () => true,
      () => false,
    ))
  ) {
    snapshot = makeRepos();
    made = await snapshot;
  }
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-copy-')));
  roots.push(dir);
  const work = path.join(dir, 'work');
  const copy = await git(dir, ['clone', '-q', '--no-hardlinks', made.work, work]);
  if (copy.code !== 0) throw new Error(copy.stderr);
  // `clone` переносит `.git/config` только частично — личность в копию не приходит,
  // а машина может никакой не иметь (сборочная уж точно). Ставим свою: иначе
  // сцена без явного автора пройдёт только там, где git умеет угадать имя
  // по входу в систему.
  await git(work, ['config', 'user.name', 'Test']);
  await git(work, ['config', 'user.email', 'test@example.com']);
  return { work, bare: made.bare, branch: made.branch };
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
    const { work } = await readOnlyRepo();

    const remotes = await serviceFor(work).remotes();

    // Копия — клон снимка, поэтому `origin` ведёт на снимок, а не на `bare`, который
    // завёл этот вызов `readOnlyRepo`. Проверяем то, что не зависит от того, кто
    // владеет снимком: один remote по имени `origin`, адреса fetch и push совпадают.
    expect(remotes).toHaveLength(1);
    expect(remotes[0]).toMatchObject({ name: 'origin' });
    expect(remotes[0]!.fetchUrl).toBe(remotes[0]!.pushUrl);
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
    const { work } = await readOnlyRepo();
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
    await peerCommit(peer, 'b.txt', 'from peer\n', 'peer commit', branch);

    const result = await serviceFor(work).pull();

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(work, 'b.txt'), 'utf8')).toBe('from peer\n');
  });

  it('pull() без режима не подсказывает git флагов (поведение как настроено)', async () => {
    if (!gitAvailable) return;
    const { work, bare, branch } = await makeRepos();
    const peer = path.join(path.dirname(work), 'peer');
    await git(path.dirname(work), ['clone', '-q', bare, peer]);
    await peerCommit(peer, 'c.txt', 'peer\n', 'peer', branch);

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
    await peerCommit(peer, 'peer.txt', 'peer\n', 'peer', branch);
    // А мы сделали свой коммит поверх старого — история разошлась.
    await commitFile(work, 'mine.txt', 'mine\n', 'mine');

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
    const { work } = await readOnlyRepo();
    const state = await serviceFor(work).bisectState();
    expect(state.active).toBe(false);
    expect(state.current).toBeNull();
  });

  it('checkIgnore() отвечает только про игнорируемые пути', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
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
    await git(inner, ['init', '-q', '--template=']);
    await git(inner, ['config', 'user.email', 'inner@example.com']);
    await git(inner, ['config', 'user.name', 'Inner']);
    await fs.writeFile(path.join(inner, 'a.txt'), 'a\n');
    await git(inner, ['add', '-A']);
    await git(inner, ['commit', '-q', '-m', 'inner']);

    await fs.mkdir(work);
    await git(work, ['init', '-q', '--template=']);
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
    await git(work, ['init', '-q', '--template=']);
    await git(work, ['config', 'user.email', 'test@example.com']);
    await git(work, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(work, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'init']);

    const service = serviceFor(work);
    if (!stubSupported) {
      // Windows: заглушку в PATH не запустить. Проверяем ответ машине как есть —
      // шаблоны видны всегда, а про git-lfs ответ должен соответствовать наличию.
      const info = await service.lfsInfo();
      expect(info.patterns.map((item) => item.pattern)).toEqual(['*.bin']);
      if (!info.available) expect(info.files).toEqual([]);
      return;
    }

    // Наличие git-lfs на машине от теста не зависит, а сверять свой замер с ответом
    // сервиса нельзя: это два разных запуска, и под нагрузкой они вправе разойтись.
    // Подставляем свою заглушку `git-lfs` — так оба случая видны одинаково везде.
    const ok = await withStubCommand('git-lfs', true);
    try {
      const info = await service.lfsInfo();
      // Шаблоны лежат в .gitattributes: их видно и без установленного git-lfs.
      expect(info.patterns.map((item) => item.pattern)).toEqual(['*.bin']);
      expect(info.configured).toBe(true);
      expect(info.available).toBe(true);
    } finally {
      ok();
    }

    // Заглушка со сбоем — как будто git-lfs не установлен: ответ честный, а не пустой.
    const broken = await withStubCommand('git-lfs', false);
    try {
      const info = await service.lfsInfo();
      expect(info.available).toBe(false);
      expect(info.files).toEqual([]);
      // И операция, которой нечего делать без git-lfs, объясняет причину.
      await expect(service.lfsTrack('*.psd')).rejects.toThrow(/lfs/i);
    } finally {
      broken();
    }
  });

  it('forgeInfo(): узнаёт площадку по адресу и честно говорит про клиента', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    // Ставим адрес GitHub: сеть для этого не нужна — только разбор адреса.
    await git(work, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);

    const service = serviceFor(work);
    if (!stubSupported) {
      // Windows: заглушку в PATH не запустить — проверяем разбор адреса и ответ машине.
      const info = await service.forgeInfo();
      expect(info.repo).toMatchObject({ platform: 'github', host: 'github.com', owner: 'acme', repo: 'web' });
      expect(info.remote).toBe('origin');
      expect(info.cli).toBe('gh');
      if (!info.cliAvailable) expect(info.note).toContain('gh');
      return;
    }

    // Клиента `gh` на машине может не быть, а сверять свой замер с ответом сервиса
    // нельзя (это два разных запуска — под нагрузкой расходятся). Подставляем свою
    // заглушку: тогда «клиент есть» и «клиента нет» видны одинаково на любой машине.
    const ok = await withStubCommand('gh', true);
    try {
      const info = await service.forgeInfo();
      expect(info.repo).toMatchObject({ platform: 'github', host: 'github.com', owner: 'acme', repo: 'web' });
      expect(info.remote).toBe('origin');
      expect(info.cli).toBe('gh');
      expect(info.cliAvailable).toBe(true);
    } finally {
      ok();
    }

    // Заглушка со сбоем — как будто клиента нет: причина названа, а не показана пустота.
    const broken = await withStubCommand('gh', false);
    try {
      const info = await service.forgeInfo();
      expect(info.cliAvailable).toBe(false);
      expect(info.note).toContain('gh');
    } finally {
      broken();
    }
  });

  it('forgeInfo(): свой GitLab узнаётся и без клиента', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    await git(work, ['remote', 'set-url', 'origin', 'https://gitlab.example.com/team/sub/api.git']);
    const info = await serviceFor(work).forgeInfo();
    expect(info.repo).toMatchObject({ platform: 'gitlab', host: 'gitlab.example.com', owner: 'team/sub', repo: 'api' });
    expect(info.cli).toBe('glab');
  });

  it('forgeCheckout() без клиента объясняет причину', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    await git(work, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);
    const service = serviceFor(work);
    if (!stubSupported) {
      const info = await service.forgeInfo();
      if (info.cliAvailable) return;
      await expect(service.forgeCheckout(1)).rejects.toThrow(/gh/);
      return;
    }

    // Клиента нет — заглушкой со сбоем: так ветвь проверяется на любой машине,
    // а не только там, где `gh` не установлен.
    const broken = await withStubCommand('gh', false);
    try {
      await expect(service.forgeCheckout(1)).rejects.toThrow(/gh/);
    } finally {
      broken();
    }
  });

  it('forgeIssues() без клиента объясняет причину', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    await git(work, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);
    const service = serviceFor(work);
    if (!stubSupported) {
      const info = await service.forgeInfo();
      if (info.cliAvailable) return;
      await expect(service.forgeIssues()).rejects.toThrow(/gh/);
      return;
    }

    // Клиента нет — заглушкой со сбоем: так ветвь проверяется на любой машине.
    const broken = await withStubCommand('gh', false);
    try {
      await expect(service.forgeIssues()).rejects.toThrow(/gh/);
      await expect(service.forgeIssueClose(1)).rejects.toThrow(/gh/);
    } finally {
      broken();
    }
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

    // Пустое значение — снять настройку. Затем же сверяем, что снятие не оставляет
    // в конфиге пустого ключа, который читал бы `identity()` как заданное значение.
    const cleared = await service.setIdentity({ signingKey: '' });
    expect(cleared.signingKey).toBe('');
    const dropped = await git(work, ['config', '--local', '--get', 'user.signingkey']);
    expect(dropped.code).not.toBe(0);
  });

  it('sshKeys(): отдаёт открытые ключи из ~/.ssh (список может быть пустым)', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();

    const lines = await serviceFor(work).blame(path.join(work, 'a.txt'));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('one');
    expect(lines[0]!.author).toBe('Test');
    expect(lines[0]!.summary).toBe('init');
    expect(lines[0]!.hash).toHaveLength(7);
  });

  it('blame() неотслеживаемого файла — пустой список, а не сбой', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    await fs.writeFile(path.join(work, 'new.txt'), 'x\n');

    expect(await serviceFor(work).blame(path.join(work, 'new.txt'))).toEqual([]);
  });

  it('headText() отдаёт версию файла в HEAD; новый файл — пустая строка', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
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
    await git(base, ['init', '-q', '--template=']);
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
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
    const entries = await serviceFor(work).reflog(10);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.ref).toBe('HEAD@{0}');
    expect(entries[0]!.hash).toHaveLength(7);
  });

  it('logGraph отдаёт граф веток текстом', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    const text = await serviceFor(work).logGraph(10);
    expect(text).toContain('*');
    expect(text).toContain('init');
  });

  it('push() без удалённого возвращает сбой текстом, а не бросает', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
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
    const { work } = await readOnlyRepo();
    // Файл чист: между щелчком и запросом его могли сохранить или закоммитить.
    const hunks = await serviceFor(work).fileHunks(path.join(work, 'a.txt'));
    expect(hunks).toEqual({ unstaged: [], staged: [] });
  });
});

describe('GitService: наблюдение за метаданными репозитория', () => {
  /**
   * Чужая git-операция (терминал, агент) переписывает `.git`, но НЕ файлы дерева:
   * события рабочей папки её не выдают, а пометки git в проводнике застывают.
   * Поэтому сервис следит за самим `.git` и сообщает об изменении наружу.
   */
  it('чужой коммит поднимает уведомление об изменении репозитория', async () => {
    if (!gitAvailable) return;
    const { work } = await makeRepos();
    let changes = 0;
    const service = new GitService(
      () => work,
      () => undefined,
      () => {
        changes += 1;
      },
    );
    // Первый статус заводит наблюдение за метаданными активного корня.
    await service.status();

    // Коммит «мимо IDE»: сработать может только наблюдение за `.git`.
    await fs.writeFile(path.join(work, 'a.txt'), 'two\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-q', '-m', 'second']);

    const started = Date.now();
    while (changes === 0 && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    service.dispose();
    expect(changes).toBeGreaterThan(0);
  });

  it('без обработчика наблюдение не заводится', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    // Обработчика нет: следить незачем, и это не ошибка.
    const service = serviceFor(work);
    await service.status();
    service.dispose();
  });

  it('repositoryMetaDir: у обычного репозитория - каталог .git', async () => {
    if (!gitAvailable) return;
    const { work } = await readOnlyRepo();
    expect(repositoryMetaDir(work)).toBe(path.join(work, '.git'));
  });

  it('repositoryMetaDir: не репозиторий - null', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git-nometa-')));
    roots.push(base);
    expect(repositoryMetaDir(base)).toBeNull();
  });
});
