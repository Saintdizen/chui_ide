import { describe, expect, it } from 'vitest';
import { registerGitViewCommands, type GitViewDeps } from '../src/renderer/core/git-view-commands';
import type { DefineCommand } from '../src/renderer/core/command-args';

type Run = (...args: unknown[]) => unknown;

function setup(viewOver: Record<string, unknown> = {}, gitOver: Record<string, unknown> = {}) {
  const commands = new Map<string, Run>();
  const define: DefineCommand = (descriptor, handler) => commands.set(descriptor.id, handler);
  const toasts: string[] = [];
  const log: string[] = [];
  const git = {
    statusOf: () => ({ staged: false, stagedChange: 'M', unstagedChange: 'M' }),
    blame: async () => [{ hash: 'a1b2c3d', author: 'Аня', line: 1 }],
    ...gitOver,
  };
  const deps = {
    git,
    showToast: (message: string, kind = 'info') => toasts.push(`${kind}:${message}`),
    openDiff: async (path: string, staged: boolean, commit?: string) =>
      log.push(`diff:${path}:${staged ? 'staged' : 'work'}:${commit ?? '-'}`),
    diffIsOpen: () => false,
    showDiffComments: () => log.push('comments'),
    currentPath: () => '/p/a.ts',
    cursorLine: () => 7,
    toggleBlame: () => true,
    toggleFileBlame: () => false,
    toggleChangeGutter: () => true,
    ...viewOver,
  } as unknown as GitViewDeps;
  registerGitViewCommands(define, deps);
  return { commands, toasts, log };
}

const run = (commands: Map<string, Run>, id: string, ...args: unknown[]) => commands.get(id)!(...args);

describe('registerGitViewCommands', () => {
  it('регистрирует показ — шесть команд', () => {
    expect([...setup().commands.keys()].sort()).toEqual([
      'git.reviewComments',
      'git.showDiff',
      'git.showLineCommit',
      'git.toggleBlame',
      'git.toggleChangeGutter',
      'git.toggleFileBlame',
    ]);
  });

  it('сравнение открывается только по настоящему пути', async () => {
    const { commands, log } = setup();
    await run(commands, 'git.showDiff', '/p/a.ts', true);
    await run(commands, 'git.showDiff', undefined);
    expect(log).toEqual(['diff:/p/a.ts:staged:-']);
  });

  it('замечания к ревью берут состояние файла из индекса', async () => {
    const { commands, log } = setup({}, { statusOf: () => ({ staged: true }) });
    await run(commands, 'git.reviewComments');
    expect(log).toEqual(['diff:/p/a.ts:staged:-', 'comments']);
  });

  it('замечания не открывают сравнение заново, если оно уже открыто', async () => {
    const { commands, log } = setup({ diffIsOpen: () => true });
    await run(commands, 'git.reviewComments');
    expect(log).toEqual(['comments']);
  });

  it('без открытого файла замечания объясняют, чего не хватает', async () => {
    const { commands, log, toasts } = setup({ currentPath: () => null });
    await run(commands, 'git.reviewComments');
    await run(commands, 'git.showLineCommit');
    expect(log).toEqual([]);
    expect(toasts).toEqual([
      'error:Откройте файл, чтобы оставить замечание',
      'error:Откройте файл, строку которого смотрите',
    ]);
  });

  it('коммит строки ищется по строке курсора', async () => {
    const asked: unknown[] = [];
    const { commands, log } = setup(
      {},
      {
        blame: async (_path: string, range: unknown) => {
          asked.push(range);
          return [{ hash: 'f00dbee', author: 'Илья', line: 7 }];
        },
      },
    );
    await run(commands, 'git.showLineCommit');
    expect(asked).toEqual([{ startLine: 7, endLine: 7 }]);
    expect(log).toEqual(['diff:/p/a.ts:work:f00dbee']);
  });

  it('строка без истории — тост, а не пустое сравнение', async () => {
    const { commands, log, toasts } = setup({}, { blame: async () => [] });
    await run(commands, 'git.showLineCommit');
    expect(log).toEqual([]);
    expect(toasts).toEqual(['error:У этой строки нет истории: файл не в git или строка не менялась']);
  });

  it('ошибка git при поиске строки не роняет команду', async () => {
    const { commands, log, toasts } = setup(
      {},
      {
        blame: async () => {
          throw new Error('not a git repository');
        },
      },
    );
    await run(commands, 'git.showLineCommit');
    expect(log).toEqual([]);
    expect(toasts).toHaveLength(1);
  });

  it('переключатели сообщают, в каком они состоянии', async () => {
    const { commands, toasts } = setup();
    await run(commands, 'git.toggleBlame');
    await run(commands, 'git.toggleFileBlame');
    await run(commands, 'git.toggleChangeGutter');
    expect(toasts).toEqual([
      'info:Blame включён: у строки под курсором видно автора',
      'info:Подписи у всех строк файла выключены',
      'info:Полоски изменений включены',
    ]);
  });
});
