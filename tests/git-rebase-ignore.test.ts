import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git/git';
import type { RebaseTodoItem } from '../src/shared/git-rebase';

/**
 * Обрывки, которые остаются, когда что-то пошло не так.
 *
 * Rebase, остановленный на конфликте, — состояние, а не ошибка: `ok` ложно, но
 * `inProgress` и `conflict` говорят правду, и именно по ним экран предлагает
 * кнопки «продолжить», «пропустить», «прервать». Если бы все три поля были
 * одним «не вышло», человек не знал бы, что делать дальше.
 *
 * Здесь же: `prune` рабочих каталогов (убирает записи об исчезнувших папках)
 * и `checkIgnore` — пути идут на stdin через NUL, код 1 от git — законный
 * ответ «ничего не игнорируется», а не сбой.
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
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-git3-')));
  roots.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await makeDir();
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
}

/** Короткий хеш верхушки ветки — rebase принимает и короткий. */
function revParse(cwd: string, rev: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['rev-parse', '--short', rev], { cwd, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function serviceFor(root: string): GitService {
  return new GitService(
    () => root,
    () => undefined,
  );
}

async function write(dir: string, relative: string, text: string): Promise<void> {
  const full = path.join(dir, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, 'utf8');
}

describe('rebase: конфликт, continue, abort', () => {
  /**
   * Готовит ветку `feature`, чей единственный коммит конфликтует с `main`
   * по одной и той же строке файла.
   */
  /**
   * Репозиторий, где перестройка гарантированно встаёт на конфликте.
   *
   * `rebase -i HEAD~n` берёт коммиты из `HEAD~n..HEAD` и заменяет их тем, что
   * лежит в todo-файле. Значит поимённо в плане должны быть `main` и `feature`:
   * оба начинаются от одной базы и правят одну строку. Если в плане только
   * один из них, git применит его к базе молча — конфликта не будет вовсе.
   */
  async function conflictingRepo(): Promise<{ dir: string; items: RebaseTodoItem[] }> {
    const dir = await makeRepo();
    await write(dir, 'a.txt', 'общая\n');
    await commitAll(dir, 'base');
    // Ветка-сосед: её коммит переживёт все переключения.
    await git(dir, ['checkout', '-q', '-b', 'side']);
    await write(dir, 'a.txt', 'ветка\n');
    await commitAll(dir, 'feature');
    const feature = await revParse(dir, 'side');
    // main растёт от той же базы, по-своему правя ту же строку.
    await git(dir, ['checkout', '-q', 'main']);
    await write(dir, 'a.txt', 'мастер\n');
    await commitAll(dir, 'main');
    const main = await revParse(dir, 'main');
    // Второй коммит даёт HEAD~2 — глубину, на которой todo из трёх шагов.
    await write(dir, 'b.txt', 'побоку\n');
    await commitAll(dir, 'extra');
    const extra = await revParse(dir, 'HEAD');

    return {
      dir,
      items: [
        { action: 'pick', commit: main, subject: 'main' },
        { action: 'pick', commit: feature, subject: 'feature' },
        { action: 'pick', commit: extra, subject: 'extra' },
      ],
    };
  }

  it('остановка на конфликте — это состояние, а не только «не вышло»', async () => {
    if (!gitAvailable) return;
    const { dir, items } = await conflictingRepo();
    const service = serviceFor(dir);

    const result = await service.rebase(2, items);
    expect(result.ok).toBe(false);
    // Главное: видно, что rebase ИДЁТ и что мешает конфликт.
    expect(result.inProgress).toBe(true);
    expect(result.conflict).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('continue без разрешения конфликта ничего не значит — и не врёт про успех', async () => {
    if (!gitAvailable) return;
    const { dir, items } = await conflictingRepo();
    const service = serviceFor(dir);
    await service.rebase(2, items);

    const result = await service.rebaseContinue();
    // Не разрешили — rebase так и стоит.
    expect(result.ok).toBe(false);
    expect(result.inProgress).toBe(true);
  });

  it('continue после разрешения доводит rebase до конца', async () => {
    if (!gitAvailable) return;
    const { dir, items } = await conflictingRepo();
    const service = serviceFor(dir);
    await service.rebase(2, items);

    await write(dir, 'a.txt', 'разрешено\n');
    await git(dir, ['add', 'a.txt']);
    const result = await service.rebaseContinue();
    expect(result.ok).toBe(true);
    expect(result.inProgress).toBe(false);
    expect(result.conflict).toBe(false);
    // В рабочем дереве остался разрешённый вариант.
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('разрешено\n');
  });

  it('abort возвращает ветку туда, где она была до запуска', async () => {
    if (!gitAvailable) return;
    const { dir, items } = await conflictingRepo();
    const service = serviceFor(dir);
    const before = await service.status();
    await service.rebase(2, items);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).not.toBe('мастер\n');

    const after = await service.rebaseAbort();
    // rebaseAbort отдаёт статус, а не итог rebase: смотрим на сам репозиторий.
    expect(after.repository?.root).toBeTruthy();
    // Ни одного шага вперёд: файл вернулся к состоянию main.
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('мастер\n');
    expect(after.branch).toBe(before.branch);
  });
});

describe('LFS без установленного git-lfs', () => {
  /**
   * В этом окружении самого `git lfs` нет — редкий случай, когда «инструмент
   * не найден» проверяется по-настоящему, а не заглушкой. Отсутствие LFS не
   * ошибка: окно должно честно сказать «нет» и показать уже заданные шаблоны,
   * иначе человек не поймёт, что настраивал.
   *
   * Если git-lfs всё-таки стоит, ветка «не найден» недостижима — тесты это
   * учитывают и проверяют оставшееся (шаблоны всё равно читаются с диска).
   */
  async function lfsInstalled(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      execFile('git', ['lfs', 'version'], { cwd: os.tmpdir(), windowsHide: true }, (error) => resolve(!error));
    });
  }

  async function repoWithAttributes(): Promise<string> {
    const dir = await makeRepo();
    await write(
      dir,
      '.gitattributes',
      ['*.psd filter=lfs diff=lfs merge=lfs -text', '# комментарий', '*.txt text'].join('\n'),
    );
    await commitAll(dir, 'init');
    return dir;
  }

  it('без git-lfs info честно говорит «нет», но шаблоны показывает', async () => {
    if (!gitAvailable) return;
    const dir = await repoWithAttributes();
    const info = await serviceFor(dir).lfsInfo();
    const installed = await lfsInstalled();

    expect(info.available).toBe(installed);
    // Шаблоны читаются с диска в любом случае — они нужны и без git-lfs.
    expect(info.patterns.map((item) => item.pattern)).toEqual(['*.psd']);
    expect(info.configured).toBe(true);
    if (!installed) expect(info.version).toBeNull();
  });

  it('не репозиторий — lfsInfo отказывает, а не отдаёт пустоту', async () => {
    const dir = await makeDir();
    await expect(serviceFor(dir).lfsInfo()).rejects.toThrow(/не репозиторий/i);
  });

  it('пустой шаблон и шаблон с пробелом — InvalidParams', async () => {
    if (!gitAvailable) return;
    const dir = await repoWithAttributes();
    const service = serviceFor(dir);

    await expect(service.lfsTrack('   ')).rejects.toThrow(/пустым/i);
    // Пробел развалил бы строку .gitattributes на два правила — тоже отказ.
    await expect(service.lfsTrack('a b')).rejects.toThrow(/пробел/i);
    await expect(service.lfsUntrack('  ')).rejects.toThrow(/пустой/i);
  });

  it('без git-lfs track/pull/install падают, а не делают вид, что сработало', async () => {
    if (!gitAvailable) return;
    if (await lfsInstalled()) return; // ветка «не найден» недостижима
    const dir = await repoWithAttributes();
    const service = serviceFor(dir);

    await expect(service.lfsTrack('*.bin')).rejects.toThrow();
    await expect(service.lfsPull()).rejects.toThrow();
    await expect(service.lfsInstall()).rejects.toThrow();
  });
});

describe('worktreePrune и checkIgnore', () => {
  it('prune убирает записи о каталогах, которых уже нет на диске', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await write(dir, 'a.txt', 'x\n');
    await commitAll(dir, 'init');
    const target = path.join(await makeDir(), 'wt');
    await git(dir, ['worktree', 'add', '-q', target, '-b', 'wt-branch']);

    const service = serviceFor(dir);
    // Список включает САМ репозиторий: main + добавленный каталог.
    expect((await service.worktrees()).length).toBe(2);

    // Сносим каталог руками — git о нём ещё помнит.
    await fs.rm(target, { recursive: true, force: true });
    expect((await service.worktrees()).length).toBe(2);

    const after = await service.worktreePrune();
    // prune забыл про исчезнувшую папку: остался только сам репозиторий.
    expect(after.map((wt) => path.normalize(wt.path))).toEqual([path.normalize(dir)]);
  });

  it('игнорируемое по .gitignore — возвращается, обычное — нет', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await write(dir, '.gitignore', 'ignored.txt\nbuild/\n');
    await write(dir, 'kept.txt', 'x\n');
    await write(dir, 'ignored.txt', 'y\n');
    await write(dir, 'build/out.js', 'z\n');
    await commitAll(dir, 'init');

    const result = await serviceFor(dir).checkIgnore([
      path.join(dir, 'ignored.txt'),
      path.join(dir, 'kept.txt'),
      path.join(dir, 'build/out.js'),
    ]);
    expect(result.map((item) => path.relative(dir, item)).sort()).toEqual(['build/out.js', 'ignored.txt']);
  });

  it('ничего не игнорируется — пустой ответ, а не ошибка (код 1 от git)', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await write(dir, 'kept.txt', 'x\n');
    await commitAll(dir, 'init');

    expect(await serviceFor(dir).checkIgnore([path.join(dir, 'kept.txt')])).toEqual([]);
  });

  it('пустой список путей — без вызова git', async () => {
    if (!gitAvailable) return;
    const dir = await makeRepo();
    await write(dir, 'a.txt', 'x\n');
    await commitAll(dir, 'init');
    expect(await serviceFor(dir).checkIgnore([])).toEqual([]);
  });

  it('не репозиторий — пустой ответ, а не падение', async () => {
    const dir = await makeDir();
    expect(await serviceFor(dir).checkIgnore([path.join(dir, 'a.txt')])).toEqual([]);
  });
});
