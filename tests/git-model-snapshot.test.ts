import { describe, expect, it, vi } from 'vitest';
import { GitModel } from '../src/renderer/core/git-model';
import { PushTopic } from '../src/shared/api/channels';

type PushHandler = (message: { topic: string; payload: unknown }) => void;

function fakeRpc(replies: Record<string, unknown> = {}) {
  const handlers: PushHandler[] = [];
  const calls: { method: string; params?: unknown }[] = [];
  return {
    handlers,
    calls,
    onPush: (handler: PushHandler) => handlers.push(handler),
    request: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return replies[method] ?? { repository: null, files: [] };
    }),
    push(topic: string, payload: unknown) {
      for (const handler of handlers) handler({ topic, payload });
    },
  };
}

function fakeWorkspace() {
  const listeners: (() => void)[] = [];
  return {
    listeners,
    onDidChange: (listener: () => void) => listeners.push(listener),
    change() {
      for (const listener of listeners) listener();
    },
  };
}

function file(
  path: string,
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' = 'modified',
  staged = false,
) {
  return { path, relative: path, change, staged, unstaged: !staged };
}

const repo = { root: '/repo', branch: 'main', detached: false, head: 'abc', ahead: 0, behind: 0 };

describe('GitModel: снимок и подписки', () => {
  it('push от main сразу меняет снимок, без запроса', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    const seen: number[] = [];
    model.onDidChange((status) => seen.push(status.files.length));
    rpc.push(PushTopic.GitChanged, { repository: repo, files: [file('/repo/a.ts'), file('/repo/b.ts')] });
    expect(model.isRepository).toBe(true);
    expect(model.branch).toBe('main');
    expect(model.changeCount).toBe(2);
    expect(seen).toEqual([2]);
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it('чужое событие не трогает модель', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    rpc.push(PushTopic.GitChanged, { repository: repo, files: [file('/repo/a.ts')] });
    rpc.push(PushTopic.SettingsChanged, { theme: 'dark' });
    expect(model.changeCount).toBe(1);
  });

  it('статус без списка файлов не затирает прежний снимок', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    rpc.push(PushTopic.GitChanged, { repository: repo, files: [file('/repo/a.ts')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.push(PushTopic.GitChanged, { repository: repo });
    expect(model.changeCount).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('индексированные и нет — разные списки', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    rpc.push(PushTopic.GitChanged, {
      repository: repo,
      files: [file('/repo/a.ts', 'modified', true), file('/repo/b.ts', 'modified', false)],
    });
    expect(model.staged.map((entry) => entry.path)).toEqual(['/repo/a.ts']);
    expect(model.unstaged.map((entry) => entry.path)).toEqual(['/repo/b.ts']);
  });

  it('statusOf ищет по абсолютному пути, а незнакомый даёт undefined', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    rpc.push(PushTopic.GitChanged, { repository: repo, files: [file('/repo/src/a.ts')] });
    expect(model.statusOf('/repo/src/a.ts')?.change).toBe('modified');
    expect(model.statusOf('/repo/src/нет.ts')).toBeUndefined();
  });

  it('вне репозитория модель пуста, но не падает', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    rpc.push(PushTopic.GitChanged, { repository: null, files: [] });
    expect(model.isRepository).toBe(false);
    expect(model.branch).toBeNull();
    expect(model.changeCount).toBe(0);
    expect(model.staged).toEqual([]);
  });
});

describe('GitModel: сводка и операции', () => {
  it('сводка по корням приходит отдельным событием', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    const seen: number[] = [];
    model.onDidChangeSummary((summary) => seen.push(summary.length));
    rpc.push(PushTopic.GitSummary, [
      { root: '/repo', count: 2 },
      { root: '/other', count: 1 },
    ]);
    expect(model.rootSummaries).toHaveLength(2);
    expect(seen).toEqual([2]);
  });

  it('сводка не массивом не ломает модель', () => {
    const rpc = fakeRpc();
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    rpc.push(PushTopic.GitSummary, null);
    expect(model.rootSummaries).toEqual([]);
  });

  it('смена рабочей папки перезапрашивает статус и сводку', async () => {
    const rpc = fakeRpc({ 'git.status': { repository: repo, files: [file('/repo/a.ts')] }, 'git.summary': [] });
    const workspace = fakeWorkspace();
    const model = new GitModel(rpc as never, workspace as never);
    workspace.change();
    await vi.waitFor(() => expect(model.changeCount).toBe(1));
    const methods = rpc.calls.map((call) => call.method);
    expect(methods).toContain('git.status');
    expect(methods).toContain('git.summary');
  });

  it('операции шлют свежий статус подписчикам', async () => {
    const status = { repository: repo, files: [file('/repo/a.ts', 'added', true)] };
    const rpc = fakeRpc({ 'git.stage': status, 'git.unstage': status, 'git.discard': status, 'git.init': status });
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    await model.stage(['/repo/a.ts']);
    expect(model.changeCount).toBe(1);
    expect(rpc.calls[0]).toEqual({ method: 'git.stage', params: { paths: ['/repo/a.ts'] } });
    await model.unstage(['/repo/a.ts']);
    await model.discard(['/repo/a.ts']);
    await model.init();
    expect(rpc.calls.map((call) => call.method)).toEqual(['git.stage', 'git.unstage', 'git.discard', 'git.init']);
  });

  it('коммит и откат блока перечитывают состояние', async () => {
    const rpc = fakeRpc({
      'git.commit': { hash: 'abc', message: 'м' },
      'git.discardHunk': { repository: repo, files: [] },
    });
    const model = new GitModel(rpc as never, fakeWorkspace() as never);
    const info = await model.commit('сообщение', ['/repo/a.ts'], true);
    expect(info).toEqual({ hash: 'abc', message: 'м' });
    expect(rpc.calls[0]?.params).toEqual({ message: 'сообщение', paths: ['/repo/a.ts'], amend: true });
    await model.discardHunk('/repo/a.ts', 2);
    expect(rpc.calls.at(-1)).toEqual({ method: 'git.discardHunk', params: { path: '/repo/a.ts', index: 2 } });
  });
});
