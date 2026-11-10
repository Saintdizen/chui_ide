import { beforeEach, describe, expect, it } from 'vitest';
import { createChatBranchSpace } from '../src/renderer/ui/chat-branch-space';
import { worktreePathFor } from '../src/shared/branch-space';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Автоувод второй задачи в свой каталог (п.31).
 *
 * Уводит не человек, а код — в момент, когда в одном каталоге стартует вторая
 * задача. Значит, и требования к нему не как к кнопке: окно человека не трогать
 * (он смотрит в первую задачу), вопросов не задавать, но и не молчать.
 */
const MAIN = '/main';
const TASK = '/main/.worktrees/task';

interface Recorder {
  root: string;
  active: string[];
  asked: number;
  notes: string[];
  saved: (string | null)[];
  added: string[];
}

function deps(overrides: { repository?: boolean; failAdd?: boolean } = {}) {
  const seen: Recorder = { root: MAIN, active: [], asked: 0, notes: [], saved: [], added: [] };
  const view = createChatBranchSpace({
    git: {
      isRepository: overrides.repository ?? true,
      branch: 'main',
      rootSummaries: [{ root: MAIN, name: 'main', branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0 }],
      branches: () => Promise.resolve([{ name: 'main' }]),
      worktrees: () =>
        Promise.resolve([
          { path: MAIN, branch: 'main', head: 'abc', bare: false, detached: false, locked: false, prunable: false },
        ]),
      worktreeAdd: (path: string) => {
        if (overrides.failAdd) return Promise.reject(new Error('нет прав'));
        seen.added.push(path);
        return Promise.resolve([]);
      },
      onDidChange: () => undefined,
    } as never,
    workspace: {
      get root() {
        return seen.root;
      },
      setActiveRoot: (path: string) => {
        seen.active.push(path);
        seen.root = path;
        return Promise.resolve(null);
      },
      onDidChange: () => undefined,
    } as never,
    sessionTitle: () => 'nested directories',
    confirm: () => {
      seen.asked += 1;
      return Promise.resolve(true);
    },
    notify: (text: string) => seen.notes.push(text),
    setSessionRoot: (root) => seen.saved.push(root),
  });
  return { view, seen };
}

describe('вторая задача уводится сама', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('создаёт каталог задачи и возвращает окно туда, где был человек', async () => {
    const { view, seen } = deps();
    expect(await view.isolateQuietly()).toBe(true);
    // Путь не угадываем: его называет та же функция, что и в коде (`chui/.chui/worktrees`).
    expect(seen.added).toEqual([worktreePathFor(MAIN, 'chui/nested-directories')]);
    // Окно ушло в каталог задачи и вернулось: человек смотрит в первую задачу.
    expect(seen.active).toEqual([worktreePathFor(MAIN, 'chui/nested-directories'), MAIN]);
    expect(seen.root).toBe(MAIN);
  });

  it('каталог запоминается в беседе, а не только в окне', async () => {
    const { view, seen } = deps();
    await view.isolateQuietly();
    // Иначе следующий ход пошёл бы по активному корню — то есть в файлы первой задачи.
    expect(seen.saved).toEqual([worktreePathFor(MAIN, 'chui/nested-directories')]);
  });

  it('человека не спрашивают: это не его решение', async () => {
    const { view, seen } = deps();
    await view.isolateQuietly();
    expect(seen.asked).toBe(0);
  });

  it('но и не молчит: тост говорит, где теперь задача', async () => {
    const { view, seen } = deps();
    await view.isolateQuietly();
    expect(seen.notes).toHaveLength(1);
    expect(seen.notes[0]).toContain('chui/nested-directories');
  });

  it('не git — уводить некуда, говорим false и окно не трогаем', async () => {
    const { view, seen } = deps({ repository: false });
    expect(await view.isolateQuietly()).toBe(false);
    expect(seen.added).toEqual([]);
    expect(seen.active).toEqual([]);
  });

  it('уже в своём каталоге — второй раз не уводим', async () => {
    const { view, seen } = deps();
    seen.root = TASK;
    expect(await view.isolateQuietly()).toBe(false);
    expect(seen.added).toEqual([]);
  });

  it('worktree не создался — false, причина тостом, окно на месте', async () => {
    const { view, seen } = deps({ failAdd: true });
    expect(await view.isolateQuietly()).toBe(false);
    expect(seen.active).toEqual([]);
    expect(seen.notes.at(-1)).toContain('нет прав');
  });
});
