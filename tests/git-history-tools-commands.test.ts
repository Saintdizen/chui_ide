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
    deleteBranch: async (name: string, force: boolean) => base.log.push(`delete:${name}:${force}`),
    renameBranch: async (name: string) => base.log.push(`rename:${name}`),
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
