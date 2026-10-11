import { describe, expect, it, vi } from 'vitest';
import type { GitStatus } from '../src/shared/api';
import { runTool, type GitTools, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Записи в репозиторий глазами агента: подтверждение и граница рабочей папки.
 *
 * Проверяем без настоящего git: важно поведение обёртки — когда агент спрашивает
 * разрешение, что делает при отказе и не даёт ли трогать файлы вне проекта.
 * Сам git-сервис проверяется отдельно (`git-service.test.ts`).
 */

const ROOT = '/proj';

const STATUS: GitStatus = { repository: null, files: [] };

/** Заглушка git: каждый метод считает вызовы, чтобы видеть, дошло ли до него действие. */
function makeGit() {
  return {
    status: vi.fn(async () => STATUS),
    diffText: vi.fn(async () => ''),
    logText: vi.fn(async () => ''),
    stage: vi.fn(async () => STATUS),
    unstage: vi.fn(async () => STATUS),
    commit: vi.fn(async () => ({ hash: 'abc1234', summary: 'done' })),
    checkout: vi.fn(async () => STATUS),
    discard: vi.fn(async () => STATUS),
    fetch: vi.fn(async () => ({ ok: true, message: 'fetched', status: STATUS })),
    pull: vi.fn(async () => ({ ok: true, message: 'pulled', status: STATUS })),
    push: vi.fn(async () => ({ ok: true, message: 'pushed', status: STATUS })),
  };
}

function context(git: ReturnType<typeof makeGit>, options: Partial<ToolContext> = {}): ToolContext {
  const workspace = { rootPath: () => ROOT } as unknown as WorkspaceService;
  return { workspace, git: git as unknown as GitTools, ...options };
}

/** Всегда разрешающий/запрещающий мост подтверждений; считает вопросы. */
function approver(allowed: boolean) {
  return vi.fn(async () => allowed);
}

describe('подтверждение git-действий', () => {
  it('в обычном режиме коммит спрашивает и без разрешения не выполняется', async () => {
    const git = makeGit();
    const confirmGit = approver(false);
    const outcome = await runTool(context(git, { confirmGit }), 'git_commit', '{"message":"fix"}');

    expect(outcome.ok).toBe(false);
    expect(confirmGit).toHaveBeenCalledOnce();
    expect(git.commit).not.toHaveBeenCalled();
  });

  it('с разрешением коммит выполняется и отдаёт хеш', async () => {
    const git = makeGit();
    const outcome = await runTool(context(git, { confirmGit: approver(true) }), 'git_commit', '{"message":"fix"}');

    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('abc1234');
    expect(git.commit).toHaveBeenCalledWith('fix', undefined);
  });

  it('нет моста подтверждений — действие недоступно', async () => {
    const git = makeGit();
    const outcome = await runTool(context(git), 'git_push', '{}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('недоступн');
    expect(git.push).not.toHaveBeenCalled();
  });

  it('при полном доступе коммит не спрашивает, а откат — спрашивает', async () => {
    const git = makeGit();
    const confirmGit = approver(true);
    const ctx = context(git, { confirmGit, allowAll: true, confirmDangerous: true });

    await runTool(ctx, 'git_commit', '{"message":"fix"}');
    expect(confirmGit).not.toHaveBeenCalled();

    await runTool(ctx, 'git_discard', `{"paths":["${ROOT}/a.ts"]}`);
    expect(confirmGit).toHaveBeenCalledOnce();
  });

  it('при полном доступе без страховки опасные действия не спрашивают', async () => {
    const git = makeGit();
    const confirmGit = approver(true);
    const ctx = context(git, { confirmGit, allowAll: true, confirmDangerous: false });

    await runTool(ctx, 'git_discard', `{"paths":["${ROOT}/a.ts"]}`);
    expect(confirmGit).not.toHaveBeenCalled();
    expect(git.discard).toHaveBeenCalledOnce();
  });
});

describe('граница рабочей папки', () => {
  it('путь вне проекта отвергается, git не вызывается', async () => {
    const git = makeGit();
    const ctx = context(git, { confirmGit: approver(true) });
    const outcome = await runTool(ctx, 'git_stage', '{"paths":["/etc/passwd"]}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('вне рабочей папки');
    expect(git.stage).not.toHaveBeenCalled();
  });

  it('относительный путь считается от корня проекта и доходит до git', async () => {
    const git = makeGit();
    const outcome = await runTool(context(git, { confirmGit: approver(true) }), 'git_stage', '{"paths":["src/a.ts"]}');

    expect(outcome.ok).toBe(true);
    expect(git.stage).toHaveBeenCalledWith([`${ROOT}/src/a.ts`]);
  });

  it('пустой список путей — ошибка, а не «всё проиндексировано»', async () => {
    const git = makeGit();
    const outcome = await runTool(context(git, { confirmGit: approver(true) }), 'git_stage', '{"paths":[]}');

    expect(outcome.ok).toBe(false);
    expect(git.stage).not.toHaveBeenCalled();
  });
});

describe('сетевые действия', () => {
  it('git_fetch отдаёт текст от git и не трогает рабочее дерево', async () => {
    const git = makeGit();
    const outcome = await runTool(context(git, { confirmGit: approver(true) }), 'git_fetch', '{}');

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe('fetched');
  });

  it('git_push передаёт флаги в сервис', async () => {
    const git = makeGit();
    const outcome = await runTool(
      context(git, { confirmGit: approver(true) }),
      'git_push',
      '{"force":true,"setUpstream":true}',
    );

    expect(outcome.ok).toBe(true);
    expect(git.push).toHaveBeenCalledWith({ setUpstream: true, force: true });
  });
});
