import { describe, expect, it, vi } from 'vitest';
import { debugAction } from '../src/main/ai/agent-debug';
import type { DebugFrame, DebugScope, DebugVariable } from '../src/shared/api';
import type { DebugPointInput, DebugTools, ToolContext } from '../src/main/ai/tool-context';

/**
 * `debug` — единственный инструмент, который видит живую сессию отладчика.
 * `DebugService` к этому моменту уже умел всё (стек, значения, шаги), но из
 * агента был недоступен вовсе: правки проверяются на двух вещах — что ответ
 * честен, когда останова нет, и что значения и адреса приходят словами, а не
 * объектами, которые модель всё равно не разберёт.
 */

function frame(over: Partial<DebugFrame> = {}): DebugFrame {
  return { id: 1, name: 'main', path: '/проект/src/a.ts', line: 12, column: 3, ...over };
}

function variable(over: Partial<DebugVariable> = {}): DebugVariable {
  return { name: 'x', value: '42', type: 'int', variablesReference: 0, ...over };
}

function scope(over: Partial<DebugScope> = {}): DebugScope {
  return { name: 'Локальные', variablesReference: 7, expensive: false, ...over };
}

interface Parts {
  phase?: 'idle' | 'starting' | 'running' | 'stopped';
  frames?: DebugFrame[];
  scopes?: DebugScope[];
  variables?: DebugVariable[];
  evaluate?: DebugVariable;
  startResult?: { ok: boolean; message: string };
  noDebug?: boolean;
  setBreakpoints?: (path: string, points: readonly DebugPointInput[]) => Promise<unknown>;
}

function ctx(parts: Parts = {}): { ctx: ToolContext; debug: DebugTools & Record<string, ReturnType<typeof vi.fn>> } {
  const phase = parts.phase ?? 'stopped';
  const frames = parts.frames ?? [frame()];
  const debug = {
    status: vi.fn(() => ({ phase })),
    start: vi.fn(async () => parts.startResult ?? { ok: true, message: 'сессия запущена' }),
    attach: vi.fn(async () => ({ ok: true, message: '' })),
    setBreakpoints: vi.fn(
      parts.setBreakpoints ??
        (async (_path: string, points: readonly DebugPointInput[]) =>
          points.map((point) => ({ line: point.line, verified: true }))),
    ),
    stack: vi.fn(() => frames),
    scopes: vi.fn(async () => parts.scopes ?? [scope()]),
    variables: vi.fn(async () => parts.variables ?? [variable()]),
    setVariable: vi.fn(async (_ref: number, name: string, value: string) => variable({ name, value })),
    evaluate: vi.fn(async () => parts.evaluate ?? variable({ name: 'x + 1', value: '43' })),
    resume: vi.fn(async () => undefined),
    step: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
  };
  const context = {
    workspace: { rootPath: () => '/проект', stat: async () => ({}) },
    debug: parts.noDebug ? undefined : debug,
  } as unknown as ToolContext;
  return { ctx: context, debug: debug as unknown as DebugTools & Record<string, ReturnType<typeof vi.fn>> };
}

describe('debug', () => {
  it('без отладчика отвечает отказом, а не падает', async () => {
    const { ctx: context } = ctx({ noDebug: true });
    const result = await debugAction(context, { action: 'status' });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('недоступен');
  });

  it('status в покое подсказывает, с чего начать', async () => {
    const { ctx: context } = ctx({ phase: 'idle' });
    const result = await debugAction(context, { action: 'status' });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('start');
  });

  it('стек показывает путь относительно корня, а не абсолютный', async () => {
    const { ctx: context } = ctx({ frames: [frame(), frame({ id: 2, name: 'inner', line: 40 })] });
    const result = await debugAction(context, { action: 'stack' });
    expect(result.summary).toContain('2');
    expect(result.detail).toContain('src/a.ts:12');
    expect(result.detail).toContain('inner');
    expect(result.detail).not.toContain('/проект/src/a.ts');
  });

  it('без останова стек честно говорит, а значения отказывают', async () => {
    const { ctx: context } = ctx({ phase: 'running', frames: [] });

    // Стек — чтение: пустой ответ полезнее отказа, он называет фазу.
    const stack = await debugAction(context, { action: 'stack' });
    expect(stack.ok).toBe(true);
    expect(stack.summary).toContain('кадров нет');

    // А значения и выражение без стоянки — отказ с причиной.
    for (const action of ['variables', 'evaluate']) {
      const result = await debugAction(context, { action, expression: 'x' });
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('running');
    }
  });

  it('значения приходят строками с типом', async () => {
    const { ctx: context } = ctx({
      variables: [variable({ name: 'count', value: '3', type: 'int' })],
    });
    const result = await debugAction(context, { action: 'variables' });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('count = 3');
    expect(result.detail).toContain('int');
  });

  it('точки останова ставятся пачкой и перечисляются с подтверждением', async () => {
    const { ctx: context, debug } = ctx();
    const result = await debugAction(context, { action: 'breakpoints', path: '/проект/src/a.ts', lines: [3, 7] });
    expect(debug.setBreakpoints).toHaveBeenCalledOnce();
    expect(debug.setBreakpoints).toHaveBeenCalledWith('/проект/src/a.ts', [{ line: 3 }, { line: 7 }]);
    expect(result.summary).toContain('2');
    expect(result.detail).toContain('src/a.ts:3');
  });

  it('точка без строки — отказ, а не пустой вызов адаптера', async () => {
    const { ctx: context, debug } = ctx();
    const result = await debugAction(context, { action: 'breakpoints', path: '/проект/src/a.ts' });
    expect(result.ok).toBe(false);
    expect(debug.setBreakpoints).not.toHaveBeenCalled();
  });

  // Опечатка в действии раньше попадала в `default`, который останавливает
  // отладчик — и отвечала `ok: true`. Модель просила шаг, теряла сессию и
  // читала, что всё хорошо. Тест на `restart` это не ловил: там фазы `idle`, и
  // отказ приходил до разбора действия.
  it('неизвестное действие в живой сессии — отказ, сессия жива', async () => {
    const { ctx: context, debug } = ctx({ phase: 'stopped' });
    const result = await debugAction(context, { action: 'step_over' });
    expect(result.ok).toBe(false);
    expect(debug.stop).not.toHaveBeenCalled();
    // Подсказка обязана называть верное имя: по ней модель исправляется.
    // Список лежит в `detail`, а `summary` — только «Неизвестное действие: …».
    expect(result.detail).toContain('stepOver');
  });

  it('повторный start при живой сессии не поднимает второй адаптер', async () => {
    const { ctx: context, debug } = ctx({ phase: 'stopped' });
    const result = await debugAction(context, { action: 'start', program: 'src/a.ts' });
    expect(result.ok).toBe(false);
    expect(debug.start).not.toHaveBeenCalled();
  });

  it('шаг возвращает новое место остановки', async () => {
    const { ctx: context, debug } = ctx({ frames: [frame({ line: 13 })] });
    const result = await debugAction(context, { action: 'stepOver' });
    expect(debug.step).toHaveBeenCalledWith('over');
    expect(result.summary).toContain('src/a.ts:13');
  });

  it('неизвестное действие называет известные', async () => {
    const { ctx: context } = ctx();
    const result = await debugAction(context, { action: 'restart' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('status');
  });
});
