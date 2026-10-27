import { describe, expect, it, vi } from 'vitest';
import type { LspDiagnostic } from '../src/shared/api';
import type { ProjectAnalysis, ProjectProblem } from '../src/shared/project-analysis';
import { PROJECT_CHECK_OWNER, ProjectCheck } from '../src/renderer/core/project-check';

/**
 * Служба проверки проекта: превратить ответ main в пометки редактора.
 *
 * Порты узкие (корень, запрос, запись пометок), поэтому проверяется без Electron:
 * важно, что пометки ложатся под своим владельцем, старые снимаются, а ответ
 * от прошлого корня не приписывается новому.
 */

function problem(path: string, line: number, severity: ProjectProblem['severity'] = 'error'): ProjectProblem {
  return { path, line, column: 1, severity, message: `msg ${path}`, source: 'lint' };
}

function analysis(problems: ProjectProblem[]): ProjectAnalysis {
  return { tool: 'biome', problems, timedOut: false, note: null };
}

interface Written {
  path: string;
  owner: string;
  diagnostics: readonly LspDiagnostic[];
}

function setup(options: { root?: string | null; answer?: ProjectAnalysis | (() => Promise<ProjectAnalysis>) } = {}) {
  const written: Written[] = [];
  const states: string[] = [];
  const check = new ProjectCheck({
    root: () => (options.root === undefined ? '/proj' : options.root),
    analyze: async () => (typeof options.answer === 'function' ? options.answer() : (options.answer ?? analysis([]))),
    setMarkers: (path, owner, diagnostics) => {
      written.push({ path, owner, diagnostics: [...diagnostics] });
    },
    onState: (state) => states.push(state.phase),
  });
  return { check, written, states };
}

describe('ProjectCheck', () => {
  it('кладёт пометки по файлам под своим владельцем', async () => {
    const { check, written } = setup({
      answer: analysis([problem('/proj/a.ts', 3), problem('/proj/b.ts', 7, 'warning')]),
    });

    await check.run();

    expect(written.map((item) => [item.path, item.diagnostics.length])).toEqual([
      ['/proj/a.ts', 1],
      ['/proj/b.ts', 1],
    ]);
    expect(written.every((item) => item.owner === PROJECT_CHECK_OWNER)).toBe(true);
    expect(check.state()).toMatchObject({ phase: 'done', files: 2, problems: 2, tool: 'biome' });
  });

  it('следующий проход снимает свои старые пометки', async () => {
    const answers: ProjectAnalysis[] = [analysis([problem('/proj/a.ts', 1)]), analysis([])];
    const { check, written } = setup({ answer: async () => answers.shift() ?? analysis([]) });

    await check.run();
    await check.run();

    // Первый проход: пометка. Второй: сначала пустой список по старому пути, потом ничего.
    expect(written.map((item) => [item.path, item.diagnostics.length])).toEqual([
      ['/proj/a.ts', 1],
      ['/proj/a.ts', 0],
    ]);
  });
});

describe('ProjectCheck: отмены и отказы', () => {
  it('ответ, пришедший после смены проекта, не приписывается новому', async () => {
    let release: (value: ProjectAnalysis) => void = () => {};
    const { check, written } = setup({
      answer: () =>
        new Promise<ProjectAnalysis>((resolve) => {
          release = resolve;
        }),
    });

    const running = check.run();
    check.reset();
    release(analysis([problem('/old/a.ts', 1)]));
    await running;

    expect(written.every((item) => item.diagnostics.length === 0)).toBe(true);
    expect(check.state().phase).toBe('idle');
  });

  it('без корня ничего не запускает', async () => {
    const analyze = vi.fn(async () => analysis([]));
    const { check } = setup({ root: null, answer: analyze });

    await check.run();

    expect(analyze).not.toHaveBeenCalled();
    expect(check.state().phase).toBe('idle');
  });

  it('отказ связи — фаза failed с причиной, а не тишина', async () => {
    const { check } = setup({
      answer: () => Promise.reject(new Error('канал закрыт')),
    });

    await check.run();

    expect(check.state().phase).toBe('failed');
    expect(check.state().note).toContain('канал закрыт');
    expect(check.checking()).toBe(false);
  });

  it('пока идёт проход, повторный запуск ничего не делает', async () => {
    let release: (value: ProjectAnalysis) => void = () => {};
    const analyze = vi.fn(
      () =>
        new Promise<ProjectAnalysis>((resolve) => {
          release = resolve;
        }),
    );
    const { check } = setup({ answer: analyze });

    const first = check.run();
    const second = check.run();
    release(analysis([]));
    await Promise.all([first, second]);

    expect(analyze).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectCheck: когда нолю верить нельзя', () => {
  it('линтера нет — unchecked объясняет, а не молчит', async () => {
    const { check } = setup({ answer: { tool: null, problems: [], timedOut: false, note: null } });

    await check.run();

    expect(check.state().phase).toBe('done');
    expect(check.unchecked()).toContain('нет линтера');
    expect(check.partial()).toBe(false);
  });

  it('своя причина от main важнее общей формулировки', async () => {
    const { check } = setup({
      answer: { tool: null, problems: [], timedOut: false, note: 'ruff не найден в окружении' },
    });

    await check.run();

    expect(check.unchecked()).toBe('ruff не найден в окружении');
  });

  it('отказ связи — unchecked берёт причину из note', async () => {
    const { check } = setup({ answer: () => Promise.reject(new Error('канал закрыт')) });

    await check.run();

    expect(check.unchecked()).toContain('канал закрыт');
  });

  it('не уложились во время — partial, но проверка считается сделанной', async () => {
    const { check } = setup({
      answer: { tool: 'biome', problems: [problem('/proj/a.ts', 1)], timedOut: true, note: null },
    });

    await check.run();

    expect(check.partial()).toBe(true);
    expect(check.unchecked()).toBeNull();
    expect(check.state().timedOut).toBe(true);
  });

  it('успешный проход не подставляет причин', async () => {
    const { check } = setup();

    await check.run();

    expect(check.unchecked()).toBeNull();
    expect(check.partial()).toBe(false);
  });

  it('холодный старт с проектом — «ещё не проверялся», без проекта — молчание', () => {
    expect(setup().check.unchecked()).toBe('Проект ещё не проверялся');
    expect(setup({ root: null }).check.unchecked()).toBeNull();
  });
});
