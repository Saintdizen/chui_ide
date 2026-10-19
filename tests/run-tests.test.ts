import { describe, expect, it, vi } from 'vitest';
import { runTool, type TestRunner, type ToolContext } from '../src/main/ai/agent-tools';
import type { WorkspaceService } from '../src/main/workspace/workspace';

/**
 * Инструмент `run_tests` глазами агента: подтверждение, отсутствие тестов и
 * исход прогона. Команду подставляет резолвер, поэтому здесь его заглушка —
 * запускаем настоящей оболочкой, но безобидную команду.
 */

function context(tests: TestRunner | undefined, options: Partial<ToolContext> = {}): ToolContext {
  const workspace = { rootPath: () => process.cwd() } as unknown as WorkspaceService;
  const confirmCommand = options.confirmCommand ?? vi.fn(async () => true);
  return { workspace, tests, confirmCommand, ...options };
}

describe('run_tests', () => {
  it('спрашивает подтверждение и запускает разрешённую команду', async () => {
    const confirmCommand = vi.fn(async () => true);
    const tests: TestRunner = { command: async () => ({ command: 'echo tests-ok', label: 'vitest' }) };

    const outcome = await runTool(context(tests, { confirmCommand }), 'run_tests', '{}');

    expect(confirmCommand).toHaveBeenCalledOnce();
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('vitest');
    expect(outcome.detail).toContain('tests-ok');
  });

  it('отказ пользователя — запуск не идёт', async () => {
    const tests: TestRunner = { command: async () => ({ command: 'echo nope', label: 'pytest' }) };
    const outcome = await runTool(context(tests, { confirmCommand: vi.fn(async () => false) }), 'run_tests', '{}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('запретил');
    expect(outcome.detail).not.toContain('nope');
  });

  it('тестов нет — понятный ответ, а не пустой прогон', async () => {
    const tests: TestRunner = { command: async () => null };
    const outcome = await runTool(context(tests), 'run_tests', '{}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('не найдены');
  });

  it('без резолвера инструмент недоступен', async () => {
    const outcome = await runTool(context(undefined), 'run_tests', '{}');
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('недоступен');
  });

  it('ненулевой код — упавшие тесты: ответ ok=false с кодом в сводке', async () => {
    const tests: TestRunner = { command: async () => ({ command: 'exit 3', label: 'pytest' }) };
    const outcome = await runTool(context(tests), 'run_tests', '{}');

    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('код выхода 3');
  });

  it('цель доходит до резолвера: гоняется часть, а не весь набор', async () => {
    // Весь набор на большом проекте — десятки тысяч строк вывода. Агент обычно
    // правил одну функцию, поэтому цель называется прямо в вызове.
    const seen: Array<string | undefined> = [];
    const tests: TestRunner = {
      command: async (target) => {
        seen.push(target);
        return { command: 'echo x', label: 'vitest' };
      },
    };
    await runTool(context(tests, { allowAll: true }), 'run_tests', JSON.stringify({ target: 'src/app.test.ts' }));
    expect(seen).toEqual(['src/app.test.ts']);
  });

  it('без цели резолвер зовётся без неё — весь набор, как раньше', async () => {
    const seen: Array<string | undefined> = [];
    const tests: TestRunner = {
      command: async (target) => {
        seen.push(target);
        return { command: 'echo x', label: 'vitest' };
      },
    };
    await runTool(context(tests, { allowAll: true }), 'run_tests', '{}');
    expect(seen).toEqual([undefined]);
  });

  it('кривая цель — отказ до запуска, а не команда в оболочке', async () => {
    const confirmCommand = vi.fn(async () => true);
    const tests: TestRunner = { command: async () => ({ command: 'echo x', label: 'vitest' }) };
    const outcome = await runTool(
      context(tests, { confirmCommand }),
      'run_tests',
      JSON.stringify({ target: 'src/a.ts\nrm -rf /' }),
    );
    expect(outcome.ok).toBe(false);
    // До подтверждения и запуска дело не дошло.
    expect(confirmCommand).not.toHaveBeenCalled();
  });

  it('при полном доступе запуск не спрашивает разрешения', async () => {
    const confirmCommand = vi.fn(async () => true);
    const tests: TestRunner = { command: async () => ({ command: 'echo x', label: 'pytest' }) };
    await runTool(context(tests, { confirmCommand, allowAll: true, confirmDangerous: true }), 'run_tests', '{}');

    expect(confirmCommand).not.toHaveBeenCalled();
  });
});
