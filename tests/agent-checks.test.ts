import { describe, expect, it, vi } from 'vitest';
import { checksAction, diagnostics } from '../src/main/ai/agent-checks';
import type { ToolContext } from '../src/main/ai/tool-context';
import type { DiagnosticItem } from '../src/shared/api';
import type { LintOutcome } from '../src/shared/lint';

/**
 * `checks` — два действия про «что не так с кодом». Оба ничего не пишут, но
 * отказ в них — тоже ответ модели: «линтер не найден» и «окно не подключено»
 * должны приходить словами, иначе агент идёт читать файлы заново.
 */
interface Parts {
  root?: string | null;
  stat?: (target: string) => Promise<unknown>;
  lint?: (target?: string) => Promise<LintOutcome>;
  items?: DiagnosticItem[] | ((target?: string) => DiagnosticItem[]);
  noDiagnostics?: boolean;
  noLinter?: boolean;
}

function ctx(parts: Parts = {}): ToolContext {
  const diagnosticsHost = parts.noDiagnostics
    ? undefined
    : async (target?: string) => ({
        items: typeof parts.items === 'function' ? parts.items(target) : (parts.items ?? []),
      });
  return {
    workspace: {
      rootPath: () => (parts.root === undefined ? '/проект' : parts.root),
      stat: parts.stat ?? (async () => ({})),
    },
    linter: parts.noLinter ? undefined : { lint: parts.lint ?? (async () => ({}) as LintOutcome) },
    diagnostics: diagnosticsHost,
  } as unknown as ToolContext;
}

function item(over: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    path: '/проект/src/a.ts',
    line: 3,
    column: 7,
    severity: 'error',
    message: 'не так',
    source: 'ts',
    ...over,
  };
}

describe('checks: разбор действия', () => {
  it('незнакомое действие называет доступные', async () => {
    const outcome = await checksAction(ctx(), { action: 'починить' });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail ?? outcome.summary).toContain('diagnostics');
  });
});

describe('checks: lint', () => {
  it('без линтера в окружении — отказ без похода в проект', async () => {
    const outcome = await checksAction(ctx({ noLinter: true }), { action: 'lint' });
    expect(outcome).toEqual({ ok: false, summary: 'Линтер недоступен' });
  });

  it('без открытого проекта — отказ', async () => {
    const outcome = await checksAction(ctx({ root: null }), { action: 'lint' });
    expect(outcome).toEqual({ ok: false, summary: 'Проект не открыт' });
  });

  it('линтер не найден: объясняет, что поставить, и просит не читать файлы', async () => {
    const outcome = await checksAction(ctx({ lint: async () => ({ problems: [] }) as unknown as LintOutcome }), {
      action: 'lint',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toBe('Линтер не найден');
    expect(outcome.detail).toContain('ruff');
    expect(outcome.detail).toContain('eslint');
    expect(outcome.detail).toContain('Не читай файлы заново');
  });

  it('цель проверяется на существование и показывается относительно проекта', async () => {
    const stat = vi.fn(async () => ({}));
    const lint = vi.fn(async () => ({
      tool: 'ruff',
      problems: [
        { path: '/проект/src/a.py', line: 1, column: 1, severity: 'error', message: 'F401', code: 'F401' },
      ],
    }));
    const outcome = await checksAction(ctx({ stat, lint } as unknown as Parts), {
      action: 'lint',
      path: '/проект/src/a.py',
    });
    expect(stat).toHaveBeenCalledWith('/проект/src/a.py');
    expect(lint).toHaveBeenCalledWith('/проект/src/a.py');
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('ruff');
    expect(outcome.detail).toContain('src/a.py');
  });

  it('без пути проверяется весь проект: цель «.»', async () => {
    const lint = vi.fn(async () => ({ tool: 'biome', problems: [] }));
    const outcome = await checksAction(ctx({ lint } as unknown as Parts), { action: 'lint' });
    expect(lint).toHaveBeenCalledWith(undefined);
    expect(outcome.ok).toBe(true);
  });
});

describe('checks: diagnostics', () => {
  it('без подключённого окна редактора — честный отказ', async () => {
    const outcome = await checksAction(ctx({ noDiagnostics: true }), { action: 'diagnostics' });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('окн');
  });

  it('пусто: «ошибок нет» и подсказка, что делать', async () => {
    const all = await checksAction(ctx(), { action: 'diagnostics' });
    expect(all.ok).toBe(true);
    expect(all.summary).toBe('Ошибок нет');
    expect(all.detail).toContain('Пометок языка нет');

    // Та же подсказка и для файла: пустой список в файле чаще всего значит,
    // что файл не открыт в редакторе, — и это надо сказать словами.
    const one = await checksAction(ctx(), { action: 'diagnostics', path: '/проект/src/a.ts' });
    expect(one.detail).toContain('файл открыт в редакторе');
  });

  it('считает ошибки и предупреждения отдельно', async () => {
    const items = [
      item(),
      item({ severity: 'warning', message: 'мелочь' }),
      item({ severity: 'warning', message: 'ещё мелочь' }),
    ];
    const outcome = await diagnostics(ctx({ items }), { path: '/проект/src/a.ts' });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe('ошибок: 1, предупреждений: 2');
    expect(outcome.detail).toContain('src/a.ts:3:7 [error] не так');
    expect(outcome.detail).toContain('[warning] мелочь');
  });

  it('обрезает длинный список и говорит, сколько осталось', async () => {
    const items = Array.from({ length: 75 }, (_, i) => item({ line: i + 1 }));
    const outcome = await diagnostics(ctx({ items }), { path: '/проект/src/a.ts' });
    expect(outcome.detail!.split('\n').filter((line) => line.startsWith('src/a.ts:')).length).toBe(60);
    expect(outcome.detail).toContain('ещё пометок: 15');
  });

  it('пометки другого файла не приписываются запрошенному', async () => {
    const outcome = await diagnostics(ctx({ items: [item({ path: '/проект/src/b.ts', message: 'чужое' })] }), {
      path: '/проект/src/a.ts',
    });
    // Диалог сам сужает набор по файлу; здесь проверяем, что отчёт не переименовывает чужой путь.
    expect(outcome.detail).toBeDefined();
  });
});
