import { describe, expect, it } from 'vitest';
import { registerGitWriteCommands, type GitWriteDeps } from '../src/renderer/core/git-write-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

type Run = (...args: unknown[]) => unknown;

function setup(gitOver: Record<string, unknown> = {}, depsOver: Record<string, unknown> = {}) {
  const commands = new Map<string, { enabled?: () => boolean; run: Run }>();
  const define: DefineCommand = (descriptor, handler) => {
    commands.set(descriptor.id, { enabled: descriptor.enabled, run: handler });
  };
  const toasts: string[] = [];
  const log: string[] = [];
  const git = {
    isRepository: true,
    repository: { head: 'a1b2c3d', ahead: 0, branch: 'main' },
    staged: [{ path: '/p/a.ts' }],
    unstaged: [],
    refresh: async () => log.push('refresh'),
    init: async () => log.push('init'),
    stage: async (paths: string[]) => log.push(`stage:${paths.join(',')}`),
    unstage: async (paths: string[]) => log.push(`unstage:${paths.join(',')}`),
    discard: async (paths: string[]) => log.push(`discard:${paths.join(',')}`),
    commit: async (text: string, _paths?: unknown, amend?: boolean) => {
      log.push(`commit:${text}:${amend === true ? 'amend' : 'normal'}`);
      return { hash: 'd4e5f6a', summary: text || 'prev' };
    },
    ...gitOver,
  };
  const deps = {
    git,
    showToast: (message: string, kind = 'info') => toasts.push(`${kind}:${message}`),
    confirm: async () => true,
    root: () => '/p',
    relative: (path: string) => path.replace('/p/', ''),
    saveDirtyForGit: async () => true,
    ...depsOver,
  } as unknown as GitWriteDeps;
  registerGitWriteCommands(define, deps);
  return { commands, toasts, log };
}

const ids = (commands: Map<string, unknown>) => [...commands.keys()].sort();

describe('registerGitWriteCommands', () => {
  it('регистрирует запись в репозиторий — семь команд', () => {
    const { commands } = setup();
    expect(ids(commands)).toEqual([
      'git.amendCommit',
      'git.commit',
      'git.discard',
      'git.init',
      'git.refresh',
      'git.stage',
      'git.unstage',
    ]);
  });

  it('«Создать репозиторий» доступна без репозитория и при открытой папке', () => {
    expect(setup({ isRepository: false }).commands.get('git.init')!.enabled?.()).toBe(true);
    expect(setup().commands.get('git.init')!.enabled?.()).toBe(false);
    expect(
      setup({ isRepository: false }, { root: () => null })
        .commands.get('git.init')!
        .enabled?.(),
    ).toBe(false);
  });

  it('без текста коммит не начинается', async () => {
    const { commands, toasts, log } = setup();
    await commands.get('git.commit')!.run('   ');
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Сначала напишите сообщение коммита']);
  });

  it('прежде чем коммитить, записывает буферы на диск', async () => {
    const { commands, log } = setup({}, { saveDirtyForGit: async () => false });
    await commands.get('git.commit')!.run('тема');
    expect(log).toEqual([]);
  });

  it('пустой индекс спрашивает и индексирует всё, о чём спросили', async () => {
    const { commands, log, toasts } = setup({
      staged: [],
      unstaged: [{ path: '/p/a.ts' }, { path: '/p/b.ts' }],
    });
    await commands.get('git.commit')!.run('тема');
    expect(log).toEqual(['stage:/p/a.ts,/p/b.ts', 'commit:тема:normal']);
    expect(toasts).toEqual(['info:Коммит d4e5f6a: тема']);
  });

  it('отказ в диалоге останавливает и откат, и коммит', async () => {
    const no = setup({ staged: [], unstaged: [{ path: '/p/a.ts' }] }, { confirm: async () => false });
    await no.commands.get('git.discard')!.run('/p/a.ts', 'M');
    await no.commands.get('git.commit')!.run('тема');
    expect(no.log).toEqual([]);
  });

  it('откат объясняет, что правки не вернуть', async () => {
    const seen: { detail?: string }[] = [];
    const { commands, log, toasts } = setup(
      {},
      {
        confirm: async (options: { detail?: string }) => {
          seen.push(options);
          return true;
        },
      },
    );
    await commands.get('git.discard')!.run('/p/a.ts', 'M');
    expect(seen[0]?.detail).toContain('Вернуть правки будет нельзя');
    expect(log).toEqual(['discard:/p/a.ts']);
    expect(toasts).toEqual(['info:Откатано: a.ts']);
  });

  it('пустой путь не доходит до модели git', async () => {
    const { commands, log } = setup();
    await commands.get('git.stage')!.run(null);
    await commands.get('git.unstage')!.run('');
    expect(log).toEqual([]);
  });

  it('amend без коммитов не начинается', async () => {
    const { commands, log, toasts } = setup({
      repository: { head: null, ahead: 0, branch: 'main' },
    });
    await commands.get('git.amendCommit')!.run('тема');
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Исправлять нечего: коммитов ещё нет']);
  });

  it('amend с пустым сообщением спрашивает и дописывает в последний коммит', async () => {
    const { commands, log } = setup();
    await commands.get('git.amendCommit')!.run('');
    expect(log).toEqual(['commit::amend']);
  });
});
