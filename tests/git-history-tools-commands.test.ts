import { describe, expect, it } from 'vitest';
import { registerGitHistoryCommands, type GitHistoryDeps } from '../src/renderer/core/git-history-commands';
import { registerGitToolsCommands, type GitToolsDeps } from '../src/renderer/core/git-tools-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

type Run = (...args: unknown[]) => unknown;

function collect() {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const log: string[] = [];
  const showToast = (message: string, kind = 'info') => toasts.push(`${kind}:${message}`);
  return { commands, define, toasts, log, showToast };
}

function history(depsOver: Record<string, unknown> = {}, gitOver: Record<string, unknown> = {}) {
  const base = collect();
  const git = {
    isRepository: true,
    repository: { head: 'abc123', branch: 'main' },
    branch: 'main',
    log: async () => [{ hash: 'abc123', summary: 'тема' }],
    rebaseContinue: async () => ({ ok: true, message: '' }),
    rebaseSkip: async () => ({ ok: true, message: '' }),
    rebaseAbort: async () => {
      base.log.push('abort');
      return { ok: true, message: '' };
    },
    createTag: async (name: string) => base.log.push(`tag:${name}`),
    deleteBranch: async (name: string, force = false) => base.log.push(`delete:${name}:${force}`),
    renameBranch: async (_from: string, to: string) => base.log.push(`rename:${to}`),
    // Остальные методы идут через log, а не через общий счётчик: тесты
    // проверяют, что команда зовёт нужный метод с нужными аргументами.
    tags: async () => [] as { name: string; commit: string }[],
    deleteTag: async (name: string) => base.log.push(`deleteTag:${name}`),
    pushTag: async (name: string) => {
      base.log.push(`pushTag:${name}`);
      return { ok: true, message: `Тег ${name} отправлен` };
    },
    checkout: async (ref: string) => base.log.push(`checkout:${ref}`),
    reset: async (mode: string, target: string) => base.log.push(`reset:${mode}:${target}`),
    reflog: async () => [] as { ref: string; hash: string; action: string }[],
    cherryPick: async (hash: string) => base.log.push(`cherry-pick:${hash}`),
    ignore: async (paths: string[]) => base.log.push(`ignore:${paths.join(',')}`),
    ...gitOver,
  };
  const deps = {
    git,
    showToast: base.showToast,
    confirm: async () => true,
    ask: async () => 'v1.0.0',
    popup: (items: unknown[]) => base.log.push(`popup:${items.length}`),
    execute: (id: string) => base.log.push(`exec:${id}`),
    openRebase: async () => base.log.push('rebase'),
    openDiff: async (path: string, commit: string) => base.log.push(`diff:${path}:${commit}`),
    currentPath: () => '/p/a.ts',
    ...depsOver,
  } as unknown as GitHistoryDeps;
  registerGitHistoryCommands(base.define, deps);
  return base;
}

function tools(depsOver: Record<string, unknown> = {}) {
  const base = collect();
  const panels = new Proxy(
    {},
    {
      get: (_target, name) => async () => base.log.push(`panel:${String(name)}`),
    },
  );
  const deps = {
    isRepository: () => true,
    showToast: base.showToast,
    panels,
    submoduleUpdate: async () => base.log.push('submodule'),
    ...depsOver,
  } as unknown as GitToolsDeps;
  registerGitToolsCommands(base.define, deps);
  return base;
}

describe('git-history-commands', () => {
  it('регистрирует 13 команд истории', () => {
    expect([...history().commands.keys()].sort()).toEqual([
      'git.createTag',
      'git.deleteBranch',
      'git.fileHistory',
      'git.ignore',
      'git.rebase',
      'git.rebaseAbort',
      'git.rebaseContinue',
      'git.rebaseSkip',
      'git.reflog',
      'git.renameBranch',
      'git.showLog',
      'git.tags',
      'git.undoCommit',
    ]);
  });

  it('rebaseContinue и rebaseSkip зовут модель, rebaseAbort — откат', async () => {
    const { commands, log } = history();
    await commands.get('git.rebaseContinue')!();
    await commands.get('git.rebaseSkip')!();
    await commands.get('git.rebaseAbort')!();
    expect(log).toEqual(['abort']);
  });

  it('ошибка rebase приходит тостом, а не исключением', async () => {
    const { commands, toasts } = history(
      {},
      {
        rebaseContinue: async () => {
          throw new Error('CONFLICT');
        },
      },
    );
    await expect(commands.get('git.rebaseContinue')!()).resolves.toBeUndefined();
    expect(toasts).toEqual(['error:CONFLICT']);
  });

  it('тег создаётся только по введённому имени', async () => {
    const ok = history();
    await ok.commands.get('git.createTag')!();
    expect(ok.log).toEqual(['tag:v1.0.0']);

    const cancelled = history({ ask: async () => null });
    await cancelled.commands.get('git.createTag')!();
    expect(cancelled.log).toEqual([]);
  });

  it('вне репозитория тег не создаётся', async () => {
    const { commands, log, toasts } = history({}, { isRepository: false });
    await commands.get('git.createTag')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Проект не в репозитории git']);
  });

  it('история файла без открытого файла просит его открыть', async () => {
    const { commands, toasts } = history({ currentPath: () => null });
    await commands.get('git.fileHistory')!();
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toContain('error:');
  });

  it('история файла открывает сравнение выбранного коммита', async () => {
    const requested: string[] = [];
    const { commands } = history({
      popup: (items: unknown[]) => requested.push(`popup:${items.length}`),
    });
    await commands.get('git.fileHistory')!('/p/a.ts');
    expect(requested).toHaveLength(1);
  });

  it('история файла без коммитов говорит об этом, попап не открывается', async () => {
    const { commands, toasts, log } = history({}, { log: async () => [] });
    await commands.get('git.fileHistory')!('/p/a.ts');
    expect(toasts).toEqual(['info:Истории нет: файл не в git или коммитов ещё нет']);
    expect(log.filter((e) => e.startsWith('popup:'))).toEqual([]);
  });

  it('отмена коммита без коммитов говорит «нечего отменять»', async () => {
    const { commands, toasts, log } = history({}, { repository: { head: null, branch: 'main' } });
    await commands.get('git.undoCommit')!();
    expect(toasts).toEqual(['error:Коммитов ещё нет']);
    expect(log).toEqual([]);
  });

  it('отмена коммита: отказ в подтверждении не трогает git', async () => {
    const { commands, log } = history({ confirm: async () => false });
    await commands.get('git.undoCommit')!();
    expect(log).toEqual([]);
  });

  it('отмена коммита делает soft-reset на HEAD~1', async () => {
    const { commands, log, toasts } = history();
    await commands.get('git.undoCommit')!();
    expect(log).toEqual(['reset:soft:HEAD~1']);
    expect(toasts).toEqual(['info:Последний коммит отменён, правки в индексе']);
  });

  it('ошибка soft-reset приходит тостом, а не исключением', async () => {
    const { commands, toasts } = history(
      {},
      {
        reset: async () => {
          throw new Error('reset упал');
        },
      },
    );
    await expect(commands.get('git.undoCommit')!()).resolves.toBeUndefined();
    expect(toasts).toEqual(['error:reset упал']);
  });

  it('reflog вне репозитория и с пустым журналом — только тост', async () => {
    const outside = history({}, { isRepository: false });
    await outside.commands.get('git.reflog')!();
    expect(outside.toasts).toEqual(['error:Проект не в репозитории git']);

    const empty = history();
    await empty.commands.get('git.reflog')!();
    expect(empty.toasts).toEqual(['info:Журнал ссылок пуст']);
    expect(empty.log).toEqual([]);
  });

  it('reflog: пункт меню — подменю на запись', async () => {
    let items: unknown[] = [];
    const { commands } = history(
      {
        popup: (list: unknown[]) => {
          items = list;
        },
      },
      // Журнал должен быть непустым: на пустом команда только говорит, что
      // он пуст, и подменю не строит совсем.
      { reflog: async () => [{ ref: 'HEAD@{1}', hash: 'def456', action: 'commit' }] },
    );
    await commands.get('git.reflog')!();
    expect(items).toHaveLength(1);
    const entry = items[0] as { submenu: { label: string }[] };
    // Один разделитель отделяет cherry-pick от трёх reset — потомок сразу
    // видит, что сброс это группа опасных действий, а не ещё одна копия.
    expect(entry.submenu).toHaveLength(5);
  });

  it('удаление ветки именем аргумента не спрашивает и не форсит', async () => {
    const { commands, log, toasts } = history();
    await commands.get('git.deleteBranch')!('feature');
    expect(log).toEqual(['delete:feature:false']);
    expect(toasts).toEqual(['info:Ветка feature удалена']);
  });

  it('отказ в вопросе об имени ветки ничего не удаляет', async () => {
    const { commands, log } = history({ ask: async () => null });
    await commands.get('git.deleteBranch')!();
    expect(log).toEqual([]);
  });

  it('не влитая ветка удаляется только после подтверждения', async () => {
    const log: string[] = [];
    const strict = history(
      { confirm: async () => true },
      {
        deleteBranch: async (name: string, force: boolean) => {
          if (!force) throw new Error('не влита');
          log.push(`${name}:force`);
        },
      },
    );
    await strict.commands.get('git.deleteBranch')!('old');
    expect(log).toEqual(['old:force']);
  });

  it('не влитая ветка без подтверждения остаётся на месте', async () => {
    const { commands, log } = history(
      { confirm: async () => false },
      {
        deleteBranch: async () => {
          throw new Error('не влита');
        },
      },
    );
    await commands.get('git.deleteBranch')!('old');
    expect(log).toEqual([]);
  });

  it('провал силу удаления тоже приходит тостом', async () => {
    const { commands, toasts } = history(
      {},
      {
        deleteBranch: async (_name: string, force?: boolean) => {
          throw new Error(force ? 'нет прав' : 'не влита');
        },
      },
    );
    await commands.get('git.deleteBranch')!('old');
    expect(toasts).toEqual(['error:нет прав']);
  });

  it('удаление ветки вне репозитория ничего не делает', async () => {
    const { commands, log, toasts } = history({}, { isRepository: false });
    await commands.get('git.deleteBranch')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Проект не в репозитории git']);
  });

  it('переименование: не на ветке — тост, на ветке — зовёт модель', async () => {
    const detached = history({}, { branch: null });
    await detached.commands.get('git.renameBranch')!();
    expect(detached.toasts).toEqual(['error:Мы не на ветке — переименовывать нечего']);

    const ok = history({ ask: async () => 'main-new' });
    await ok.commands.get('git.renameBranch')!();
    expect(ok.log).toEqual(['rename:main-new']);
  });

  it('переименование в то же имя — лишний вызов git не нужен', async () => {
    const { commands, log } = history({ ask: async () => 'main' });
    await commands.get('git.renameBranch')!();
    expect(log).toEqual([]);
  });

  it('ошибка переименования приходит тостом', async () => {
    const { commands, toasts } = history(
      {},
      {
        renameBranch: async () => {
          throw new Error('name exists');
        },
      },
    );
    await commands.get('git.renameBranch')!();
    expect(toasts).toEqual(['error:name exists']);
  });

  it('git.ignore принимает и строку, и массив, и чистит чужие типы', async () => {
    const one = history();
    await one.commands.get('git.ignore')!('a.ts');
    expect(one.log).toEqual(['ignore:a.ts']);
    expect(one.toasts).toEqual(['info:Добавлено в .gitignore']);

    // Мусор из аргумента отбрасывается: нечисловые/чужие типы не должны
    // превращаться в строку «[object Object]» в файле .gitignore.
    const many = history();
    await many.commands.get('git.ignore')!(['a.ts', 42, 'b.ts']);
    expect(many.log).toEqual(['ignore:a.ts,b.ts']);
    expect(many.toasts).toEqual(['info:В .gitignore добавлено файлов: 2']);
  });

  it('git.ignore без пути говорит, что добавлять нечего', async () => {
    const { commands, log, toasts } = history();
    await commands.get('git.ignore')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Нечего добавлять: файл не выбран']);
  });

  it('ошибка записи .gitignore приходит тостом', async () => {
    const { commands, toasts } = history(
      {},
      {
        ignore: async () => {
          throw new Error('read-only');
        },
      },
    );
    await commands.get('git.ignore')!('a.ts');
    expect(toasts).toEqual(['error:read-only']);
  });

  it('tags: каждый тег — подменю перехода, отправки и удаления', async () => {
    let items: { label: string; submenu?: { label: string }[] }[] = [];
    const { commands } = history(
      {
        popup: (list: unknown[]) => {
          items = list as typeof items;
        },
      },
      { tags: async () => [{ name: 'v1.0.0', commit: 'abc123' }] },
    );
    await commands.get('git.tags')!();
    // Первые два пункта постоянные: создание тега и разделитель. Тег
    // добавляется третьим, а не заменяет меню.
    expect(items).toHaveLength(3);
    const tagItem = items[2];
    expect(tagItem?.label).toBe('v1.0.0');
    // Переход, отправка, разделитель и удаление. Без отправки тег виден только
    // локально, а без удаления на нём нельзя ошибиться и исправиться.
    expect(tagItem?.submenu).toHaveLength(4);
  });

  it('tags: пустой список оставляет пункт «Тегов нет», но не тост', async () => {
    let items: { label: string }[] = [];
    const { commands, toasts } = history(
      {
        popup: (list: unknown[]) => {
          items = list as typeof items;
        },
      },
      { tags: async () => [] },
    );
    await commands.get('git.tags')!();
    // Меню открывается в обоих случаях: пустота — состояние меню, а не
    // ошибка, поэтому тоста нет, есть пункт-объяснение.
    expect(toasts).toEqual([]);
    expect(items.map((item) => item.label)).toContain('Тегов нет');
  });

  it('tags: ошибка чтения тегов уходит наверх, а не глотается', async () => {
    // У самих команд истории нет тоста: их зовут из палитры и меню, и
    // сообщение должно быть одно на всех. Ловит `onCommandError` палитры.
    const { commands } = history(
      {},
      {
        tags: async () => {
          throw new Error('not a git repository');
        },
      },
    );
    await expect(commands.get('git.tags')!()).rejects.toThrow('not a git repository');
  });

  it('createTag: спрашивает имя, подставляет текущий коммит, сообщает успех', async () => {
    const { commands, log, toasts } = history({ ask: async () => 'v2.0.0' });
    await commands.get('git.createTag')!();
    // Коммит не передаётся: тег на голову — типичный случай, а лишний
    // вопрос заставляет о нём думать, когда он не нужен.
    expect(log).toEqual(['tag:v2.0.0']);
    expect(toasts).toEqual(['info:Тег v2.0.0 создан']);
  });

  it('createTag: отменённый ввод ничего не создаёт', async () => {
    const { commands, log, toasts } = history({ ask: async () => null });
    await commands.get('git.createTag')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('createTag: ошибка git приходит тостом', async () => {
    const { commands, toasts } = history(
      { ask: async () => 'v2.0.0' },
      {
        createTag: async () => {
          throw new Error('tag already exists');
        },
      },
    );
    await commands.get('git.createTag')!();
    expect(toasts).toEqual(['error:tag already exists']);
  });

  it('reflog: непустой список даёт пункты с действием и ссылкой', async () => {
    let items: { label: string; hint?: string }[] = [];
    const { commands } = history(
      {
        popup: (list: unknown[]) => {
          items = list as typeof items;
        },
      },
      {
        reflog: async () => [
          { ref: 'HEAD@{0}', hash: 'aaa', action: 'commit: добавил' },
          { ref: 'HEAD@{1}', hash: 'bbb', action: 'checkout: main' },
        ],
      },
    );
    await commands.get('git.reflog')!();
    expect(items).toHaveLength(2);
    // В строке — ссылка и хеш: по ним находят место, а действие в подсказке
    // справа: его читают вторым, когда место уже опознано.
    expect(items[0]?.label).toBe('HEAD@{0} → aaa');
    expect(items[0]?.hint).toBe('commit: добавил');
  });

  it('reflog: ошибка уходит наверх, меню не открывается', async () => {
    let opened = false;
    const { commands } = history(
      {
        popup: () => {
          opened = true;
        },
      },
      {
        reflog: async () => {
          throw new Error('no HEAD');
        },
      },
    );
    await expect(commands.get('git.reflog')!()).rejects.toThrow('no HEAD');
    expect(opened).toBe(false);
  });
});

describe('git-tools-commands', () => {
  it('регистрирует 11 окон', () => {
    expect([...tools().commands.keys()].sort()).toEqual([
      'git.bisect',
      'git.compareBranches',
      'git.identity',
      'git.issues',
      'git.lfs',
      'git.notifications',
      'git.pipelines',
      'git.pullRequests',
      'git.sparse',
      'git.submoduleUpdate',
      'git.worktrees',
    ]);
  });

  it('каждое окно открывается', async () => {
    const { commands, log } = tools();
    for (const id of commands.keys()) {
      if (id === 'git.submoduleUpdate') continue;
      await commands.get(id)!();
    }
    expect(log.filter((line) => line.startsWith('panel:'))).toHaveLength(10);
  });

  it('подмодули обновляются, а не открывают окно', async () => {
    const { commands, log } = tools();
    await commands.get('git.submoduleUpdate')!();
    expect(log).toEqual(['submodule']);
  });

  it('вне репозитория ничего не открывается', async () => {
    const { commands, log, toasts } = tools({ isRepository: () => false });
    await commands.get('git.bisect')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Проект не в репозитории git']);
  });
});
