import { describe, expect, it, vi } from 'vitest';
import { changeInsideFolders, GitModel } from '../src/renderer/core/git-model';
import { PushTopic, type GitFileStatus, type GitStatus } from '../src/shared/api';
import { Emitter } from '../src/renderer/core/events';
import { sep } from 'node:path';

/**
 * Состояние git в окне (`renderer/core/git-model.ts`).
 *
 * Операции — тонкая обёртка над RPC, но именно в ней живёт правило: каждая меняющая
 * операция возвращает СВЕЖИЙ статус и рассылает его подписчикам. Если это правило
 * нарушится, дерево и редактор покажут устаревшие пометки до следующего события.
 *
 * Рабочая область — заглушка: смена корня должна перезапрашивать статус, иначе в
 * другом проекте останутся правки предыдущего.
 */

const SEP = `${sep}`;

function file(path: string, change: GitFileStatus['change'] = 'modified'): GitFileStatus {
  // `staged`/`unstaged` приходят от main так же, как всё остальное: модель их только
  // читает. В тесте ставим одну из сторон — этого достаточно для индексов.
  return { path, change, staged: true, unstaged: false } as GitFileStatus;
}

function status(files: GitFileStatus[], branch = 'main'): GitStatus {
  return { repository: { root: '/p', branch }, files } as GitStatus;
}

function setup() {
  const emitter = new Emitter<unknown>();
  const workspace = {
    onDidChange: emitter.event,
    setRoot() {
      emitter.fire(null);
    },
  };
  const pushes: ((message: { topic: string; payload: unknown }) => void)[] = [];
  let answer: GitStatus = status([]);
  const rpc = {
    // Изменяющие запросы возвращают не статус, а пустой ответ: модель должна сама
    // перезапросить `git.status`, и тест это видит.
    request: vi.fn(async (_method: string) => answer),
    onPush: (listener: (message: { topic: string; payload: unknown }) => void) => {
      pushes.push(listener);
      return () => {};
    },
    emit: (topic: string, payload: unknown) => {
      for (const listener of pushes) listener({ topic, payload });
    },
  };
  return {
    rpc,
    workspace,
    setAnswer(next: GitStatus) {
      answer = next;
    },
  };
}

function model(setupResult = setup()) {
  const created = new GitModel(setupResult.rpc as never, setupResult.workspace as never);
  return { model: created, ...setupResult };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('состояние git', () => {
  it('до загрузки статуса репозитория нет', () => {
    const { model: git } = model();

    expect(git.isRepository).toBe(false);
    expect(git.branch).toBeNull();
    expect(git.changeCount).toBe(0);
  });

  it('после refresh известны ветка, файлы и счётчики', async () => {
    const { model: git, setAnswer, rpc } = model();
    setAnswer(status([{ ...file('/p/a.ts'), staged: false, unstaged: true }, file('/p/b.ts')]));

    await git.refresh();

    expect(git.isRepository).toBe(true);
    expect(git.branch).toBe('main');
    expect(git.changeCount).toBe(2);
    expect(git.staged).toHaveLength(1);
    expect(git.unstaged).toHaveLength(1);
    expect(git.statusOf('/p/a.ts')?.change).toBe('modified');
    expect(rpc.request).toHaveBeenCalledWith('git.status');
  });

  it('событие git changed из main обновляет пометки без запроса', async () => {
    // Статус приходит толчком: запрашивать его после каждого действия незачем.
    const { model: git, rpc } = model();

    rpc.emit(PushTopic.GitChanged, status([file('/p/x.ts')], 'dev'));

    expect(git.branch).toBe('dev');
    expect(git.changeCount).toBe(1);
  });

  it('смена рабочей папки перезапрашивает статус и сводку', async () => {
    // Иначе в новом проекте висели бы правки прежнего.
    const { rpc, workspace } = model();
    rpc.request.mockClear();

    workspace.setRoot();
    await settled();

    const methods = rpc.request.mock.calls.map((call) => call[0]);
    expect(methods).toContain('git.status');
  });

  it('изменяющая операция возвращает свежий статус, а не пустоту', async () => {
    const { model: git, setAnswer } = model();
    setAnswer(status([file('/p/a.ts')]));

    const after = await git.stage(['/p/a.ts']);

    expect(after.files).toHaveLength(1);
    expect(git.changeCount).toBe(1);
  });

  it('пометки внутри свёрнутой папки считаются для дерева', async () => {
    const { model: git, setAnswer } = model();
    setAnswer(status([file(`/p/src${SEP}deep${SEP}a.ts`), file(`/p/other.ts`)]));

    await git.refresh();

    expect(git.changeInside(`/p/src${SEP}deep`)).toBeDefined();
    expect(git.changeInside('/p')).toBeDefined();
  });

  it('удалённые файлы папки видны, хотя на диске их уже нет', async () => {
    const { model: git, setAnswer } = model();
    setAnswer(status([{ ...file(`/p/src${SEP}gone.ts`, 'deleted'), staged: false }]));

    await git.refresh();

    // Удалённый файл лежит прямо в папке — его и показывает `deletedIn`.
    // `parentOf` отдаёт путь без завершающего разделителя — папку передаём так же.
    expect(git.deletedIn(`/p/src`).map((item) => item.path)).toEqual([`/p/src${SEP}gone.ts`]);
  });

  it('откат одного блока возвращает обновлённый статус', async () => {
    const { model: git, setAnswer, rpc } = model();
    setAnswer(status([file('/p/a.ts')]));

    const after = await git.discardHunk('/p/a.ts', 2);

    expect(rpc.request).toHaveBeenCalledWith('git.discardHunk', { path: '/p/a.ts', index: 2 });
    // Ответ запроса — не статус, поэтому модель обязана запросить статус заново.
    expect(after.files).toHaveLength(1);
  });
});

describe('сводки по корням', () => {
  it('сводка приходит событием и отдаётся наружу', () => {
    const { model: git, rpc } = model();
    const changed = vi.fn();
    git.onDidChangeSummary(changed);
    const summary = [{ root: '/p', branch: 'main', ahead: 1, behind: 0, changes: 2 }];

    rpc.emit(PushTopic.GitSummary, summary);

    expect(git.rootSummaries).toHaveLength(1);
    expect(changed).toHaveBeenCalled();
  });

  it('правки внутри папок: пустой список даёт пустую карту', () => {
    expect(changeInsideFolders([]).size).toBe(0);
  });
});
