import { describe, expect, it } from 'vitest';
import type { GitRepository, GitStatus } from '../src/shared/api';
import {
  changesLabel,
  repositoryCount,
  rootSummaryLabel,
  summarizeRoot,
  totalChanges,
  type GitRootSummary,
} from '../src/shared/git-multiroot';

/**
 * Сводка git по всем корням области. Функции чистые: считают по уже готовому
 * статусу корня, без ФС и git. Поэтому проверяются на простых снимках — важно
 * только, как раскладываются правки и что видно про репозиторий.
 */

function repository(over: Partial<GitRepository> = {}): GitRepository {
  return { root: '/work/api', branch: 'dev', detached: false, head: 'abc1234', ahead: 0, behind: 0, ...over };
}

function status(repository_: GitRepository | null, files: GitStatus['files']): GitStatus {
  return { repository: repository_, files };
}

describe('summarizeRoot', () => {
  it('считает правки в индексе, вне индекса и конфликты', () => {
    const summary = summarizeRoot(
      status(repository(), [
        { path: '/work/api/a.ts', relative: 'a.ts', change: 'modified', staged: true, unstaged: false },
        { path: '/work/api/b.ts', relative: 'b.ts', change: 'modified', staged: false, unstaged: true },
        { path: '/work/api/c.ts', relative: 'c.ts', change: 'conflicted', staged: true, unstaged: true },
      ]),
      '/work/api',
      'api',
    );

    expect(summary).toMatchObject({
      root: '/work/api',
      name: 'api',
      files: 3,
      staged: 2,
      unstaged: 2,
      conflicted: 1,
    });
    expect(summary.repository).toEqual(repository());
  });

  it('папка без репозитория: правок нет, repository — null', () => {
    const summary = summarizeRoot(status(null, []), '/work/docs', 'docs');
    expect(summary.repository).toBeNull();
    expect(summary.files).toBe(0);
    expect(summary.staged).toBe(0);
  });
});

describe('rootSummaryLabel', () => {
  const base: GitRootSummary = {
    root: '/work/api',
    name: 'api',
    repository: null,
    files: 0,
    staged: 0,
    unstaged: 0,
    conflicted: 0,
  };

  it('без репозитория — так и пишем', () => {
    expect(rootSummaryLabel(base)).toBe('не репозиторий');
  });

  it('ветка без расхождения', () => {
    expect(rootSummaryLabel({ ...base, repository: repository() })).toBe('dev');
  });

  it('расхождение с удалённой показывает вперёд и назад', () => {
    expect(rootSummaryLabel({ ...base, repository: repository({ ahead: 2, behind: 3 }) })).toBe('dev ↑2 ↓3');
  });

  it('оторванный HEAD — короткий хеш, без коммитов — своя подпись', () => {
    expect(rootSummaryLabel({ ...base, repository: repository({ branch: null, detached: true }) })).toBe(
      'HEAD abc1234',
    );
    expect(rootSummaryLabel({ ...base, repository: repository({ branch: null, head: null }) })).toBe('без коммитов');
  });
});

describe('changesLabel', () => {
  it('склоняет по числу правок', () => {
    expect(changesLabel(0)).toBe('нет правок');
    expect(changesLabel(1)).toBe('1 правка');
    expect(changesLabel(2)).toBe('2 правки');
    expect(changesLabel(5)).toBe('5 правок');
    expect(changesLabel(11)).toBe('11 правок');
    expect(changesLabel(21)).toBe('21 правка');
  });
});

describe('итоги по области', () => {
  const make = (files: number, repo: boolean): GitRootSummary => ({
    root: `/work/${files}`,
    name: String(files),
    repository: repo ? repository() : null,
    files,
    staged: 0,
    unstaged: 0,
    conflicted: 0,
  });

  it('суммирует правки по всем корням', () => {
    expect(totalChanges([make(2, true), make(3, true), make(0, false)])).toBe(5);
    expect(totalChanges([])).toBe(0);
  });

  it('считает только корни-репозитории', () => {
    expect(repositoryCount([make(2, true), make(3, false), make(1, true)])).toBe(2);
  });
});
