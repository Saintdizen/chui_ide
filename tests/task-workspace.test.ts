import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskWorkspace } from '../src/main/ai/task-workspace';

/** Общий сервис, который только и умеет, что помнить активный корень окна. */
function service(active: string) {
  const calls: string[] = [];
  return {
    calls,
    rootPath: () => active,
    readFile: (p: string) => {
      calls.push(`readFile:${p}`);
      return Promise.resolve({ path: p, text: '' });
    },
    // Списки сервис отдаёт по активному корню — фасад обязан это починить.
    findFiles: (_glob?: string, _limit?: number, area?: string) => {
      calls.push(`findFiles:${area ?? active}`);
      return Promise.resolve([`${area ?? active}/a.ts`, `${active}/чужой.ts`]);
    },
    replace: (_options: unknown, area?: string) => {
      calls.push(`replace:${area ?? active}`);
      return Promise.resolve({ files: [], replaced: 0 });
    },
    searchDocs: (_options: unknown, area?: string) => {
      calls.push(`searchDocs:${area ?? active}`);
      return Promise.resolve({ query: '', hits: [], files: 0, chunks: 0 });
    },
  };
}

describe('каталог задачи поверх общего сервиса', () => {
  it('корень — каталог беседы, а не активный корень окна', () => {
    const task = new TaskWorkspace(service('/main') as never, '/main/.worktrees/task');
    expect(task.rootPath()).toBe('/main/.worktrees/task');
  });

  it('относительный путь разрешается в дерево беседы', async () => {
    const svc = service('/main');
    const task = new TaskWorkspace(svc as never, '/main/.worktrees/task');
    await task.readFile('src/a.ts');
    expect(svc.calls).toEqual([`readFile:${path.join('/main/.worktrees/task', 'src/a.ts')}`]);
  });

  it('абсолютный путь остаётся собой', async () => {
    const svc = service('/main');
    const task = new TaskWorkspace(svc as never, '/main/.worktrees/task');
    await task.readFile('/main/.worktrees/task/b.ts');
    // Корень на Windows получает диск и обратные слэши: сравниваем с тем же
    // путём, собранным платформенным join, а не литералом POSIX.
    expect(svc.calls).toEqual([`readFile:${path.resolve('/main/.worktrees/task/b.ts')}`]);
  });

  it('выход за свой каталог — не путь этой задачи', () => {
    const task = new TaskWorkspace(service('/main') as never, '/main/.worktrees/task');
    // Соседний worktree — чужое дерево, и «..» туда не должно вести.
    expect(() => (task as unknown as { full(p: string): string }).full('../other/x.ts')).toThrow();
  });

  it('замена и справка ищут в своём каталоге, а не в активном корне', async () => {
    const svc = service('/main');
    const task = new TaskWorkspace(svc as never, '/main/.worktrees/task');
    await task.replace({ query: 'a', replacement: 'b' });
    await task.searchDocs({ query: 'a' });
    await task.findFiles('*.ts', 10);
    expect(svc.calls).toEqual([
      'replace:/main/.worktrees/task',
      'searchDocs:/main/.worktrees/task',
      'findFiles:/main/.worktrees/task',
    ]);
  });

  it('список файлов не отдаёт чужие имена', async () => {
    const task = new TaskWorkspace(service('/main') as never, '/main/.worktrees/task');
    const names = await task.findFiles('*.ts', 10);
    // Общий сервис вернул бы и файл активного корня — фасад обрезает по своему.
    expect(names).toEqual(['/main/.worktrees/task/a.ts']);
  });
});
