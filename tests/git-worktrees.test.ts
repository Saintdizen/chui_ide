import { describe, expect, it } from 'vitest';
import { parseWorktrees, worktreeLabel } from '../src/shared/git-worktrees';

/**
 * Разбор `git worktree list --porcelain`: блоки разделены пустой строкой, поля —
 * построчно. Строки взяты в том виде, в каком их печатает git.
 */
const MAIN = `${['worktree /home/u/proj', 'HEAD 548cbfa', 'branch refs/heads/master', ''].join('\n')}\n`;
const FEATURE = `${['worktree /home/u/proj-feature', 'HEAD 548cbfa', 'branch refs/heads/feature', ''].join('\n')}\n`;
const DETACHED = `${['worktree /home/u/proj-detached', 'HEAD 548cbfa', 'detached', ''].join('\n')}\n`;
const LOCKED = `${['worktree /home/u/proj-locked', 'HEAD 548cbfa', 'branch refs/heads/wip', 'locked on usb', ''].join('\n')}\n`;

describe('parseWorktrees', () => {
  it('несколько блоков читаются как отдельные каталоги', () => {
    expect(parseWorktrees(MAIN + FEATURE)).toEqual([
      { path: '/home/u/proj', head: '548cbfa', branch: 'master', bare: false, locked: null, prunable: null },
      { path: '/home/u/proj-feature', head: '548cbfa', branch: 'feature', bare: false, locked: null, prunable: null },
    ]);
  });

  it('detached — ветки нет', () => {
    expect(parseWorktrees(DETACHED)[0]).toMatchObject({ branch: null, head: '548cbfa' });
  });

  it('заблокированный каталог несёт причину', () => {
    expect(parseWorktrees(LOCKED)[0]?.locked).toBe('on usb');
  });

  it('lock без причины читается как «заблокирован»', () => {
    const out = ['worktree /x', 'HEAD abc', 'detached', 'locked', ''].join('\n');
    expect(parseWorktrees(out)[0]?.locked).toBe('заблокирован');
  });

  it('bare и prunable отмечаются', () => {
    const out = ['worktree /x', 'HEAD abc', 'bare', 'prunable gitdir file points to non-existent location', ''].join(
      '\n',
    );
    const worktree = parseWorktrees(out)[0]!;
    expect(worktree.bare).toBe(true);
    expect(worktree.prunable).toContain('non-existent');
  });

  it('короткая ветка без префикса refs/heads остаётся как есть', () => {
    const out = ['worktree /x', 'HEAD abc', 'branch feature', ''].join('\n');
    expect(parseWorktrees(out)[0]?.branch).toBe('feature');
  });

  it('пустой вывод — пустой список', () => {
    expect(parseWorktrees('')).toEqual([]);
  });

  it('последний блок без пустой строки в конце не теряется', () => {
    expect(parseWorktrees(['worktree /x', 'HEAD abc', 'branch refs/heads/main'].join('\n'))).toHaveLength(1);
  });
});

describe('worktreeLabel', () => {
  it('называет каталог по ветке, отделённый — словами', () => {
    expect(worktreeLabel(parseWorktrees(MAIN)[0]!)).toBe('master');
    expect(worktreeLabel(parseWorktrees(DETACHED)[0]!)).toBe('отделённый указатель');
  });
});
