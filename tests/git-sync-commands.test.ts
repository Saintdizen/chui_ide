import { describe, expect, it } from 'vitest';
import { firstLine, registerGitSyncCommands, type GitSyncDeps } from '../src/renderer/core/git-sync-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

type Run = (...args: unknown[]) => unknown;

function setup(depsOver: Record<string, unknown> = {}, gitOver: Record<string, unknown> = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const log: string[] = [];
  const git = {
    isRepository: true,
    repository: { ahead: 1, behind: 0 },
    unstaged: [{ path: '/p/a.ts' }, { path: '/p/b.ts' }],
    staged: [{ path: '/p/a.ts' }],
    checkout: async (name: string, create = false) => log.push(`checkout:${name}:${create}`),
    fetch: async () => ({ ok: true, message: 'From origin\n   a1b2..c3d4  main' }),
    fetchRoots: async () => [{ ok: true, message: 'ok', name: 'папка' }],
    pull: async (mode: string) => {
      log.push(`pull:${mode}`);
      return { ok: true, message: 'Fast-forward' };
    },
    push: async () => {
      log.push('push');
      return { ok: false, message: '! [rejected] main -> main' };
    },
    stage: async (paths: string[]) => log.push(`stage:${paths.join(',')}`),
    unstage: async (paths: string[]) => log.push(`unstage:${paths.join(',')}`),
    discard: async (paths: string[]) => log.push(`discard:${paths.join(',')}`),
    ...gitOver,
  };
  const deps = {
    git,
    showToast: (message: string, kind = 'info') => toasts.push(`${kind}:${message}`),
    prepareCheckout: async () => true,
    openConflict: async () => true,
    currentPath: () => '/p/a.ts',
    pullMode: () => 'merge',
    isMultiRoot: () => true,
    confirm: async () => true,
    activePath: () => '/p/a.ts',
    hasTab: () => true,
    closeTab: (path: string) => log.push(`close:${path}`),
    openPath: async (path: string) => log.push(`open:${path}`),
    ...depsOver,
  } as unknown as GitSyncDeps;
  registerGitSyncCommands(define, deps);
  return { commands, toasts, log };
}

describe('firstLine', () => {
  it('берёт первую непустую строку', () => {
    expect(firstLine('\n\n  From origin \nsecond')).toBe('From origin');
    expect(firstLine('')).toBe('');
  });
});

describe('registerGitSyncCommands', () => {
  it('регистрирует 11 команд', () => {
    expect(setup().commands.size).toBe(11);
  });

  it('конфликт открывается по аргументу, иначе по текущему файлу', async () => {
    const asked: string[] = [];
    const { commands } = setup({ openConflict: async (path: string) => (asked.push(path), true) });
    await commands.get('git.resolveConflicts')!('/p/x.ts');
    await commands.get('git.resolveConflicts')!();
    expect(asked).toEqual(['/p/x.ts', '/p/a.ts']);
  });

  it('без файла и без конфликтов говорит, чего не хватает', async () => {
    const silent = setup({ currentPath: () => null });
    await silent.commands.get('git.resolveConflicts')!();
    expect(silent.toasts).toEqual(['error:Откройте файл с конфликтом']);

    const clean = setup({ openConflict: async () => false });
    await clean.commands.get('git.resolveConflicts')!();
    expect(clean.toasts).toEqual(['info:В этом файле нет конфликтов слияния']);
  });

  it('переключение ветки не идёт без prepareCheckout', async () => {
    const { commands, log } = setup({ prepareCheckout: async () => false });
    await commands.get('git.checkout')!('dev');
    expect(log).toEqual([]);

    const ok = setup();
    await ok.commands.get('git.checkout')!('dev');
    expect(ok.log).toEqual(['checkout:dev:false']);
    expect(ok.toasts).toEqual(['info:Ветка: dev']);
  });

  it('создание ветки обрезает имя и создаёт её', async () => {
    const { commands, log, toasts } = setup();
    await commands.get('git.createBranch')!('  feature/x  ');
    await commands.get('git.createBranch')!('   ');
    expect(log).toEqual(['checkout:feature/x:true']);
    expect(toasts).toEqual(['info:Ветка создана: feature/x']);
  });

  it('fetch и pull показывают первую строку ответа git', async () => {
    const { commands, toasts, log } = setup();
    await commands.get('git.fetch')!();
    await commands.get('git.pull')!();
    expect(log).toEqual(['pull:merge']);
    expect(toasts).toEqual(['info:fetch: From origin', 'info:pull: Fast-forward']);
  });

  it('pull --rebase берёт rebase поверх настройки', async () => {
    const { commands, log } = setup();
    await commands.get('git.pullRebase')!();
    expect(log).toEqual(['pull:rebase']);
  });

  it('push без коммитов впереди не зовёт git', async () => {
    const { commands, log, toasts } = setup({}, { repository: { ahead: 0, behind: 0 } });
    await commands.get('git.push')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['info:Отправлять нечего: коммитов впереди нет']);
  });

  it('push при чужих коммитах советует pull вместо отказа git', async () => {
    const { commands, log, toasts } = setup({}, { repository: { ahead: 2, behind: 3 } });
    await commands.get('git.push')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:На удалённой ветке есть чужие коммиты: сначала влейте их (pull)']);
  });

  it('ошибка push приходит текстом git', async () => {
    const { commands, log, toasts } = setup();
    await commands.get('git.push')!();
    expect(log).toEqual(['push']);
    expect(toasts).toEqual(['error:push: ! [rejected] main -> main']);
  });

  it('массовые действия берут пути из модели', async () => {
    const { commands, log } = setup();
    await commands.get('git.stageAll')!();
    await commands.get('git.unstageAll')!();
    expect(log).toEqual(['stage:/p/a.ts,/p/b.ts', 'unstage:/p/a.ts']);
  });

  it('пустой список — тост, а не вызов git', async () => {
    const { commands, log, toasts } = setup({}, { unstaged: [], staged: [] });
    await commands.get('git.stageAll')!();
    await commands.get('git.unstageAll')!();
    await commands.get('git.discardAll')!();
    expect(log).toEqual([]);
    expect(toasts).toEqual([
      'error:Нет изменений для индексации',
      'error:Индекс уже пуст',
      'error:Нет правок для отката',
    ]);
  });

  it('откат всего: вкладки закрываются до git, активный файл перечитывается', async () => {
    const { commands, log, toasts } = setup();
    await commands.get('git.discardAll')!();
    expect(log).toEqual(['close:/p/a.ts', 'close:/p/b.ts', 'discard:/p/a.ts,/p/b.ts', 'open:/p/a.ts']);
    expect(toasts).toEqual(['info:Правки откатаны']);
  });

  it('отказ в диалоге отката оставляет всё как было', async () => {
    const { commands, log } = setup({ confirm: async () => false });
    await commands.get('git.discardAll')!();
    expect(log).toEqual([]);
  });
});
