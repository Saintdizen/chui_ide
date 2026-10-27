import { describe, expect, it } from 'vitest';
import { runTool, type SandboxRunner, type TerminalAgent, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Запуск команд ассистентом — три пути в одну дверь: `terminal` (он же с
 * `background: true`), `terminalOpen` и `terminalWrite`. Проверяем
 * то, что у них общее и что раньше расходилось: где именно выполняется команда (проект, подпапка или
 * песочница) и каким словом отказывают — отказ обязан быть один, иначе модель
 * считает отказы разными и пробует снова.
 */

const ROOT = '/p';

/** Рабочая папка, которая, как настоящая, не пускает за свои пределы. */
function workspace(): WorkspaceService {
  return {
    rootPath: () => ROOT,
    stat: async (target: string) => {
      if (!target.startsWith(`${ROOT}/`) && target !== ROOT) throw new Error(`Путь вне проекта: ${target}`);
      return { path: target, kind: target.endsWith('.ts') ? 'file' : 'directory', size: 0, mtimeMs: 0 };
    },
  } as unknown as WorkspaceService;
}

/** Песочница-подставка: запоминает, что и где просили выполнить. */
function sandbox(): SandboxRunner & { calls: { command: string; cwd: string }[] } {
  const calls: { command: string; cwd: string }[] = [];
  return {
    label: 'контейнер обрезка',
    available: true,
    run: async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      return { code: 0, signal: null, output: 'ок', truncated: false, timedOut: false };
    },
    calls,
  };
}

/** Терминал-подставка: сессий не открывает, но помнит, с какой папкой просили. */
function terminals(): TerminalAgent & { created: (string | undefined)[] } {
  const created: (string | undefined)[] = [];
  return {
    list: () => [],
    create: async (options) => {
      created.push(options.cwd);
      return { id: 't1', title: 'терминал', shell: 'sh', cwd: options.cwd ?? ROOT, pid: 1 };
    },
    write: () => {},
    read: () => ({ data: '', offset: 0, alive: true }),
    kill: () => {},
    created,
  };
}

describe('где выполняется команда', () => {
  it('по умолчанию — корень проекта', async () => {
    const box = sandbox();
    const ctx = { workspace: workspace(), sandbox: box, confirmCommand: async () => true } as ToolContext;
    const outcome = await runTool(ctx, 'terminal', JSON.stringify({ command: 'npm test' }));

    expect(outcome.ok).toBe(true);
    expect(box.calls).toEqual([{ command: 'npm test', cwd: ROOT }]);
  });

  it('cwd запускает в подпапке, а в контейнере — через cd', async () => {
    // В контейнер монтируется только корень: второй том не отдаём, поэтому
    // подпапка выражается `cd` внутри уже смонтированного проекта.
    const box = sandbox();
    const ctx = { workspace: workspace(), sandbox: box, confirmCommand: async () => true } as ToolContext;
    await runTool(ctx, 'terminal', JSON.stringify({ command: 'npm test', cwd: `${ROOT}/packages/core` }));

    expect(box.calls).toEqual([{ command: "cd 'packages/core' && npm test", cwd: ROOT }]);
  });

  it('cd внутри проекта поднимается в cwd', async () => {
    // Перепись: 76 из 93 вызовов terminal начинались с `cd <папка> && `.
    // Префикс — привычка, а не нужда: у run есть cwd. Панель ревью и история
    // должны показывать саму команду.
    const box = sandbox();
    const ctx = { workspace: workspace(), sandbox: box, confirmCommand: async () => true } as ToolContext;
    await runTool(ctx, 'terminal', JSON.stringify({ command: `cd ${ROOT}/packages/core && npm test` }));

    expect(box.calls).toEqual([{ command: "cd 'packages/core' && npm test", cwd: ROOT }]);
  });

  it('cd вне проекта остаётся в команде', async () => {
    const box = sandbox();
    const ctx = { workspace: workspace(), sandbox: box, confirmCommand: async () => true } as ToolContext;
    await runTool(ctx, 'terminal', JSON.stringify({ command: 'cd /tmp && npm test' }));

    expect(box.calls).toEqual([{ command: 'cd /tmp && npm test', cwd: ROOT }]);
  });

  it('cwd за пределами проекта — отказ, команда не выполняется', async () => {
    const box = sandbox();
    const ctx = { workspace: workspace(), sandbox: box, confirmCommand: async () => true } as ToolContext;
    const outcome = await runTool(ctx, 'terminal', JSON.stringify({ command: 'ls', cwd: '/etc' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('/etc');
    expect(box.calls).toEqual([]);
  });

  it('cwd файла, а не папки — отказ словами', async () => {
    const ctx = { workspace: workspace(), jobs: {}, confirmCommand: async () => true } as unknown as ToolContext;
    const outcome = await runTool(
      ctx,
      'terminal',
      JSON.stringify({ command: 'npm test', cwd: `${ROOT}/a.ts`, background: true }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('не папка');
  });
});

// Пустой вызов — ошибка вызова, а не «сервер не подключён». Раньше порядок проверок
// был обратный, и модель шла чинить сервер вместо аргументов.
describe('переход к определению', () => {
  it('без аргументов говорит про аргументы, а не про языковой сервер', async () => {
    const ctx = { workspace: workspace() } as ToolContext;
    const empty = await runTool(ctx, 'go_to_definition', '{}');
    expect(empty.ok).toBe(false);
    expect(empty.summary).toContain('symbol');
    expect(empty.summary).not.toContain('сервер');

    // Половина формы — тоже ошибка вызова: путь без строки не «позиция».
    const half = await runTool(ctx, 'go_to_definition', JSON.stringify({ path: `${ROOT}/a.ts` }));
    expect(half.summary).toBe(empty.summary);
  });

  it('с именем символа идёт к серверу, а без него честно отказывает', async () => {
    const ctx = { workspace: workspace() } as ToolContext;
    const outcome = await runTool(ctx, 'go_to_definition', JSON.stringify({ symbol: 'runTool' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('сервер');
  });
});

describe('песочница', () => {
  it('терминальная сессия при включённой песочнице не открывается', async () => {
    // Сессия — процесс на хосте, а контейнер живёт ровно на время команды.
    // Раньше terminal_start этого не знал и выполнял команду мимо песочницы.
    const term = terminals();
    const box = sandbox();
    const ctx = { workspace: workspace(), terminals: term, sandbox: box } as ToolContext;
    const outcome = await runTool(ctx, 'terminalOpen', JSON.stringify({ command: 'npm test' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('контейнер обрезка');
    expect(term.created).toEqual([]);
  });

  it('и ввод в сессию при песочнице тоже не проходит', async () => {
    const term = terminals();
    const box = sandbox();
    const ctx = { workspace: workspace(), terminals: term, sandbox: box } as ToolContext;
    const outcome = await runTool(ctx, 'terminalWrite', JSON.stringify({ id: 't1', data: 'rm -rf /' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('песочниц');
  });
});

describe('отказ — одним словом', () => {
  /** Мост подтверждений, который на всё отвечает «нет». */
  const deny = async () => false;

  it('запрет человека одинаков у всех путей запуска', async () => {
    const term = terminals();
    const base = { workspace: workspace(), terminals: term, confirmCommand: deny } as ToolContext;

    const viaRun = await runTool(base, 'terminal', JSON.stringify({ command: 'npm test' }));
    const viaSession = await runTool(base, 'terminalOpen', JSON.stringify({ command: 'npm test' }));
    const viaTyping = await runTool(base, 'terminalWrite', JSON.stringify({ id: 't1', data: 'npm test' }));

    expect(viaRun.summary).toBe(viaSession.summary);
    expect(viaSession.summary).toBe(viaTyping.summary);
    expect(viaRun.detail).toBe(viaTyping.detail);
    // Запрещённая команда не выполняется и сессию не открывает.
    expect(term.created).toEqual([]);
  });

  it('без моста подтверждений — один и тот же отказ', async () => {
    const base = { workspace: workspace() } as ToolContext;
    const withJobs = { workspace: workspace(), jobs: {} } as unknown as ToolContext;
    const viaRun = await runTool(base, 'terminal', JSON.stringify({ command: 'npm test' }));
    const viaBackground = await runTool(
      withJobs,
      'terminal',
      JSON.stringify({ command: 'npm test', background: true }),
    );

    expect(viaRun.ok).toBe(false);
    expect(viaRun.summary).toBe(viaBackground.summary);
    expect(viaRun.detail).toContain('подтверждений нет');
  });

  it('полный доступ без страховки вопросов не задаёт', async () => {
    let asked = 0;
    const box = sandbox();
    const ctx = {
      workspace: workspace(),
      sandbox: box,
      allowAll: true,
      confirmDangerous: false,
      confirmCommand: async () => {
        asked += 1;
        return true;
      },
    } as unknown as ToolContext;

    const outcome = await runTool(ctx, 'terminal', JSON.stringify({ command: 'npm test' }));

    expect(outcome.ok).toBe(true);
    expect(asked).toBe(0);
  });

  it('в непесочной папке папка запуска берётся из cwd', async () => {
    const term = terminals();
    const ctx = { workspace: workspace(), terminals: term, confirmCommand: async () => true } as ToolContext;
    await runTool(ctx, 'terminalOpen', JSON.stringify({ cwd: `${ROOT}/packages/core` }));

    expect(term.created).toEqual([`${ROOT}/packages/core`]);
  });
});
