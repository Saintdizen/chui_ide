import { describe, expect, it } from 'vitest';
import { registerGitAiCommands, type GitAiDeps } from '../src/renderer/core/git-ai-commands';
import { registerGitPanelCommands, type GitPanelDeps } from '../src/renderer/core/git-panel-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

type Run = (...args: unknown[]) => unknown;

function collect() {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const showToast = (message: string, kind = 'info') => toasts.push(`${kind}:${message}`);
  return { commands, define, toasts, showToast };
}

function ai(gitOver: Record<string, unknown> = {}, depsOver: Record<string, unknown> = {}) {
  const base = collect();
  const log: string[] = [];
  const git = {
    isRepository: true,
    branch: 'main',
    commitDiff: async () => ({ diff: 'diff --git a a', staged: false, truncated: false, untracked: [] }),
    ...gitOver,
  };
  const deps = {
    git,
    showToast: base.showToast,
    isAiEnabled: () => true,
    warnAiDisabled: () => log.push('warn'),
    commitMessage: async () => ({ message: 'feat: тема' }),
    setMessage: (message: string) => log.push(`set:${message}`),
    revealComposer: () => log.push('reveal'),
    ...depsOver,
  } as unknown as GitAiDeps;
  registerGitAiCommands(base.define, deps);
  return { ...base, log };
}

function panel(gitOver: Record<string, unknown> = {}, depsOver: Record<string, unknown> = {}) {
  const base = collect();
  const log: string[] = [];
  const git = {
    isRepository: true,
    logGraph: async () => '* a1b2c3d тема',
    ...gitOver,
  };
  const deps = {
    git,
    showToast: base.showToast,
    openText: (title: string, text: string) => log.push(`text:${title}:${text}`),
    openStash: async () => log.push('stash'),
    ...depsOver,
  } as unknown as GitPanelDeps;
  registerGitPanelCommands(base.define, deps);
  return { ...base, log };
}

describe('git.generateCommitMessage', () => {
  const run = (commands: Map<string, Run>) => commands.get('git.generateCommitMessage')!();

  it('кладёт готовое сообщение в поле и показывает панель', async () => {
    const { commands, log, toasts } = ai();
    await run(commands);
    expect(log).toEqual(['set:feat: тема', 'reveal']);
    expect(toasts).toEqual(['info:Сообщение готово']);
  });

  it('без репозитория не спрашивает модель', async () => {
    const { commands, log, toasts } = ai({ isRepository: false }, { commitMessage: async () => log.push('model') });
    await run(commands);
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Проект не в репозитории git']);
  });

  it('выключенный AI объясняет причину и молчит', async () => {
    const { commands, log, toasts } = ai({}, { isAiEnabled: () => false });
    await run(commands);
    expect(log).toEqual(['warn']);
    expect(toasts).toEqual([]);
  });

  it('пустые правки — не повод спрашивать модель', async () => {
    const { commands, log, toasts } = ai(
      { commitDiff: async () => ({ diff: '   ', staged: false, truncated: false, untracked: [] }) },
      { commitMessage: async () => log.push('model') },
    );
    await run(commands);
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Правок нет — сообщение писать не по чему']);
  });

  it('неотслеживаемые файлы тоже считаются правками', async () => {
    const { commands, log } = ai(
      { commitDiff: async () => ({ diff: '', staged: false, truncated: false, untracked: ['a.ts'] }) },
      { commitMessage: async () => ({ message: 'chore: файл' }) },
    );
    await run(commands);
    expect(log).toEqual(['set:chore: файл', 'reveal']);
  });

  it('пустой ответ модели — тост-ошибка и поле не трогаем', async () => {
    const { commands, log, toasts } = ai({}, { commitMessage: async () => ({ message: '\n  \n' }) });
    await run(commands);
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Модель вернула пустое сообщение — попробуйте ещё раз']);
  });

  it('обрезанный diff предупреждает, что тему стоит проверить', async () => {
    const { commands, toasts } = ai({
      commitDiff: async () => ({ diff: 'd', staged: true, truncated: true, untracked: [] }),
    });
    await run(commands);
    expect(toasts).toEqual(['info:Сообщение готово (diff был обрезан — проверьте)']);
  });

  it('ошибка модели доходит до человека тостом', async () => {
    const { commands, toasts } = ai(
      {},
      {
        commitMessage: async () => {
          throw new Error('нет ключа');
        },
      },
    );
    await run(commands);
    expect(toasts).toEqual(['error:нет ключа']);
  });
});

describe('панели git', () => {
  it('история открывается текстом, пустая — тостом', async () => {
    const { commands, log } = panel();
    await commands.get('git.logGraph')!();
    expect(log).toEqual(['text:История (граф веток):* a1b2c3d тема']);
    const empty = panel({ logGraph: async () => '\n' });
    await empty.commands.get('git.logGraph')!();
    expect(empty.log).toEqual([]);
    expect(empty.toasts).toEqual(['info:Истории ещё нет']);
  });

  it('без репозитория ни история, ни stash не открываются', async () => {
    const { commands, log, toasts } = panel({ isRepository: false });
    await commands.get('git.logGraph')!();
    await commands.get('git.openStash')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:Проект не в репозитории git', 'error:Проект не в репозитории git']);
  });

  it('список stash открывается поверх панели', async () => {
    const { commands, log } = panel();
    await commands.get('git.openStash')!();
    expect(log).toEqual(['stash']);
  });
});
