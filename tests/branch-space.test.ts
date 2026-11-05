import { describe, expect, it } from 'vitest';
import {
  describeBranchSpace,
  isForeignSpace,
  taskBranchName,
  uniqueBranchName,
  worktreePathFor,
} from '../src/shared/branch-space';

describe('имя ветки из заголовка задачи', () => {
  it('латиница становится слагом', () => {
    expect(taskBranchName('Fix completion cache')).toBe('chui/fix-completion-cache');
  });

  it('кириллица не тащится в ветку — остаётся chui/task', () => {
    expect(taskBranchName('Почини это')).toBe('chui/task');
  });

  it('знаки и лишние дефисы схлопываются', () => {
    expect(taskBranchName('  Fix: the (cache)!!  ')).toBe('chui/fix-the-cache');
  });

  it('длинный заголовок режется по границе слова', () => {
    const name = taskBranchName('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(name.length).toBeLessThanOrEqual('chui/'.length + 40);
    expect(name).not.toMatch(/-$/);
  });
});

describe('ветка не повторяется', () => {
  it('свободное имя остаётся собой', () => {
    expect(uniqueBranchName('chui/x', ['chui/y'])).toBe('chui/x');
  });

  it('занятое получает номер, первый свободный', () => {
    expect(uniqueBranchName('chui/x', ['chui/x', 'chui/x-2'])).toBe('chui/x-3');
  });
});

describe('каталог рабочей копии', () => {
  it('внутри проекта, слэш ветки разворачивается в дефис', () => {
    expect(worktreePathFor('/repo', 'chui/fix-cache')).toBe('/repo/.chui/worktrees/chui-fix-cache');
  });

  it('хвостовой разделитель не даёт двойного', () => {
    expect(worktreePathFor('/repo/', 'chui/x')).toBe('/repo/.chui/worktrees/chui-x');
  });
});

describe('подпись в шапке', () => {
  it('главное дерево называет ветку', () => {
    expect(describeBranchSpace({ root: '/repo', branch: 'main', worktree: false })).toBe('ветка main');
  });

  it('отдельный каталог говорит и о каталоге', () => {
    const text = describeBranchSpace(
      { root: '/repo/.chui/worktrees/chui-x', branch: 'chui/x', worktree: true },
      '/repo',
    );
    expect(text).toContain('ветка chui/x');
    expect(text).toContain('отдельный каталог');
    expect(text).toContain('.chui/worktrees/chui-x');
  });

  it('без ветки не врёт, а говорит «неизвестна»', () => {
    expect(describeBranchSpace({ root: '/repo', branch: null, worktree: false })).toBe('ветка неизвестна');
  });
});

describe('чужое место', () => {
  it('другой корень — чужое, свой — нет', () => {
    const space = { root: '/repo/.chui/worktrees/x', branch: 'chui/x', worktree: true };
    expect(isForeignSpace(space, '/repo')).toBe(true);
    expect(isForeignSpace(space, '/repo/.chui/worktrees/x/')).toBe(false);
    expect(isForeignSpace(space, null)).toBe(false);
  });
});
