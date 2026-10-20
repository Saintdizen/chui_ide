import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { AGENT_TOOLS } from '../src/shared/tools';

/**
 * Слитые инструменты: `browser`, `terminal`, `edit`, `schedule` с полем `action`.
 *
 * Семь схем браузера и пять терминала стоили дороже, чем их различие по смыслу:
 * описания едут в каждом запросе. Проверяем то, что могло сломаться при слиянии:
 * схема обещает те действия, которые разбирает код, промах по действию называет
 * допустимые, а недостающий аргумент возвращается отказом с именем поля, а не
 * «не задан аргумент» из глубины обработчика.
 */

const spec = (name: string) => AGENT_TOOLS.find((tool) => tool.name === name)!;

describe('слитые инструменты: схема', () => {
  it('объявленные действия совпадают с разобранными', () => {
    const actions = (name: string): string[] => {
      const property = spec(name).inputSchema.properties.action as { enum?: string[] };
      return property.enum ?? [];
    };
    expect(actions('browser')).toEqual(['open', 'snapshot', 'click', 'type', 'evaluate', 'zoom', 'close']);
    expect(actions('terminal')).toEqual(['list', 'start', 'read', 'write', 'stop', 'run', 'output', 'cancel']);
    expect(actions('schedule')).toEqual(['create', 'update', 'delete']);
    expect(actions('git_read')).toEqual(['status', 'diff', 'log', 'blame']);
    expect(actions('git_write')).toEqual([
      'stage',
      'unstage',
      'commit',
      'checkout',
      'discard',
      'fetch',
      'pull',
      'push',
    ]);
    // Старых имён в наборе больше нет: иначе схема и обработчик разъехались бы.
    const gone = ['browser_open', 'terminal_start', 'schedule_create', 'git_status', 'run_terminal', 'apply_patch'];
    for (const old of gone) {
      expect(AGENT_TOOLS.some((tool) => tool.name === old)).toBe(false);
    }
  });

  it('обязателен только action: остальные поля зависят от действия', () => {
    for (const name of ['browser', 'terminal', 'schedule', 'git_read', 'git_write']) {
      expect(spec(name).inputSchema.required).toEqual(['action']);
    }
  });

  it('schedule_list остался отдельным: его видно в режиме плана', () => {
    expect(spec('schedule_list').inputSchema.required).toBeUndefined();
    expect(spec('schedule').name).toBe('schedule');
  });
});

describe('слитые инструменты: разбор', () => {
  const ctx = { workspace: {} } as unknown as ToolContext;

  it('незнакомое действие называет допустимые', async () => {
    const outcome = await runTool(ctx, 'terminal', JSON.stringify({ action: 'взмахнуть' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('взмахнуть');
    expect(outcome.detail).toContain('list, start, read, write, stop');
  });

  it('terminal: команда и задание живут под общими действиями', async () => {
    // `run` без команды и `cancel` без номера отказывают до обработчика — там
    // контекста нет, и «не задан аргумент» из глубины читалось бы как поломка.
    const run = await runTool(ctx, 'terminal', JSON.stringify({ action: 'run' }));
    expect(run.summary).toContain('command');
    const cancel = await runTool(ctx, 'terminal', JSON.stringify({ action: 'cancel' }));
    expect(cancel.summary).toContain('id');
    // `output` без id — список заданий, а не ошибка: реестр заданий есть всегда.
    const jobs = await runTool(
      { ...ctx, jobs: { list: () => [], get: () => undefined } } as ToolContext,
      'terminal',
      JSON.stringify({ action: 'output' }),
    );
    expect(jobs.ok).toBe(true);
    expect(jobs.summary).toContain('заданий');
  });

  it('edit: форму выбирает сама правка, а не отдельное поле', async () => {
    // Адрес — якорь или четыре позиции. Промахи называются словами: «не хватает
    // адреса», «позиций не все», «в одном файле обе формы» — по ним и чинят.
    const neither = await runTool(
      ctx,
      'edit',
      JSON.stringify({ edits: [{ path: '/p/a.ts', edits: [{ newText: 'x' }] }] }),
    );
    expect(neither.ok).toBe(false);
    expect(neither.summary).toContain('oldText');

    const partial = await runTool(
      ctx,
      'edit',
      JSON.stringify({ edits: [{ path: '/p/a.ts', edits: [{ startLine: 1, newText: 'x' }] }] }),
    );
    expect(partial.summary).toContain('не все');

    const mixed = await runTool(
      ctx,
      'edit',
      JSON.stringify({
        edits: [
          {
            path: '/p/a.ts',
            edits: [
              { oldText: 'a', newText: 'b' },
              { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'c' },
            ],
          },
        ],
      }),
    );
    expect(mixed.summary).toContain('два вызова');
  });

  it('недостающий аргумент назван по имени поля', async () => {
    const outcome = await runTool(ctx, 'browser', JSON.stringify({ action: 'click' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('ref');
  });

  it('git_write: аргумент спрашивается по действию', async () => {
    const stage = await runTool(ctx, 'git_write', JSON.stringify({ action: 'stage' }));
    expect(stage.summary).toContain('paths');
    const commit = await runTool(ctx, 'git_write', JSON.stringify({ action: 'commit' }));
    expect(commit.summary).toContain('message');
    const checkout = await runTool(ctx, 'git_write', JSON.stringify({ action: 'checkout' }));
    expect(checkout.summary).toContain('name');
  });

  it('git_read: незнакомое действие называет допустимые', async () => {
    const outcome = await runTool(ctx, 'git_read', JSON.stringify({ action: 'stage' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('status, diff, log, blame');
  });

  it('без действия вызов тоже объясняется', async () => {
    // Расписание подключено: иначе отказ был бы «инструмент недоступен», а не про форму.
    const withSchedule = { workspace: {}, schedules: { list: async () => [] } } as unknown as ToolContext;
    const outcome = await runTool(withSchedule, 'schedule', JSON.stringify({}));
    expect(outcome.ok).toBe(false);
    // Отказ приходит до обработчика: схема требует action, и это названо прямо.
    expect(outcome.summary).toContain('action');
  });
});
