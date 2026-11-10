/**
 * Отладка для агента: точка останова, пуск, шаги, стек, значения, выражение.
 *
 * `DebugService` умеет всё это с самого начала — но панель отладчика живёт в
 * renderer и общается с ним по IPC. Агент видел ноль из этого: он мог только
 * `terminal` и `console.log`. Здесь — обёртка, а не второй отладчик: сессия
 * одна на проект, агент подключается к той же, что и человек за кнопкой F5.
 *
 * Всё, что читает (стек, значения, выражение), в проект не пишет. Пишут только
 * `breakpoints`, `start` и `set` — их отмечает подсказка в описании.
 */

import type { DebugFrame, DebugScope, DebugVariable } from '../../shared/api';
import { relativePath } from './agent-terminal';
import { optionalInteger, requireString } from './tool-args';
import { unknownAction } from './agent-present';
import type { ToolContext, ToolOutcome } from './tool-context';

/** Сколько кадров и переменных показывать: стек бывает глубоким, а топ у корня. */
const MAX_FRAMES = 20;
const MAX_VARIABLES = 40;

function where(file: string | null | undefined, line: number | undefined, root: string | null): string {
  if (!file) return '<без файла>';
  return `${relativePath(file, root)}:${line ?? 0}`;
}

function describeVariable(variable: DebugVariable, indent = '  '): string {
  const type = variable.type ? `: ${variable.type}` : '';
  return `${indent}${variable.name} = ${variable.value}${type}`;
}

async function status(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const { phase } = ctx.debug.status();

  if (phase === 'idle') {
    return {
      ok: true,
      summary: `отладчик: ${phase}`,
      detail: 'Сессия не идёт. `debug` action start поднимает её, action breakpoints ставит точки останова до запуска.',
    };
  }

  const root = ctx.workspace.rootPath();
  const frames = ctx.debug.stack();
  if (frames.length === 0) return { ok: true, summary: `отладчик: ${phase}`, detail: 'Кадров нет.' };
  const top = frames[0];
  return {
    ok: true,
    summary: `отладчик: ${phase}, ${where(top?.path, top?.line, root)}`,
    detail: formatFrames(frames, root),
  };
}

function formatFrames(frames: readonly DebugFrame[], root: string | null): string {
  const shown = frames.slice(0, MAX_FRAMES);
  const lines = shown.map((frame, index) => {
    const name = frame.name || '<анонимная>';
    return `#${index} ${name} — ${where(frame.path, frame.line, root)}`;
  });
  if (frames.length > shown.length) lines.push(`… ещё кадров: ${frames.length - shown.length}`);
  return lines.join('\n');
}

async function stack(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const phase = ctx.debug.status().phase;
  if (phase === 'idle') {
    return { ok: false, summary: 'Сессии нет', detail: 'Сначала action start.' };
  }

  const frames = ctx.debug.stack();
  if (frames.length === 0) {
    return {
      ok: true,
      summary: `отладчик: ${phase}, кадров нет`,
      detail: 'Стек есть только в момент останова: `continue` или точка останова.',
    };
  }

  const root = ctx.workspace.rootPath();
  return {
    ok: true,
    summary: `кадров: ${frames.length}, верх — ${where(frames[0]?.path, frames[0]?.line, root)}`,
    detail: formatFrames(frames, root),
  };
}

async function breakpoints(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const file = requireString(args, 'path');
  await ctx.workspace.stat(file);

  // `line` — одна точка; `lines` — несколько за раз, чтобы не гонять вызов на каждую.
  const single = optionalInteger(args, 'line');
  const many = Array.isArray(args.lines) ? args.lines : [];
  const numbers = [...(single !== undefined ? [single] : []), ...many]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.max(1, Math.trunc(value)));

  if (numbers.length === 0) {
    return { ok: false, summary: 'Не задана строка: нужен `line` или `lines`' };
  }

  const result = await ctx.debug.setBreakpoints(
    file,
    numbers.map((line) => ({ line })),
  );
  const root = ctx.workspace.rootPath();
  const target = relativePath(file, root);
  const verified = result.filter((point) => point.verified).length;
  const lines = result.map((point) =>
    point.verified ? `  ${target}:${point.line} — стоит` : `  ${target}:${point.line} — не подтверждена`,
  );

  return {
    ok: true,
    summary: `точек останова: ${result.length}, подтверждено: ${verified}`,
    detail: lines.join('\n'),
  };
}

async function start(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const current = ctx.debug.status().phase;
  if (current !== 'idle') {
    return {
      ok: false,
      summary: `Отладчик уже занят: ${current}`,
      detail: 'Останови текущую сессию (action stop) или продолжай её: resume/step.',
    };
  }

  const program = requireString(args, 'program');
  await ctx.workspace.stat(program);

  const outcome = await ctx.debug.start(program, {});
  if (!outcome.ok) return { ok: false, summary: outcome.message };

  const frames = ctx.debug.stack();
  const root = ctx.workspace.rootPath();
  return {
    ok: true,
    summary: frames.length > 0 ? `остановился: ${where(frames[0]?.path, frames[0]?.line, root)}` : outcome.message,
    detail: frames.length > 0 ? formatFrames(frames, root) : undefined,
  };
}

async function perform(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const phase = ctx.debug.status().phase;
  if (phase === 'idle') {
    return { ok: false, summary: `Сессии нет: ${phase}`, detail: 'Сначала action start.' };
  }

  const action = requireString(args, 'action').trim() as
    | 'continue'
    | 'pause'
    | 'stepOver'
    | 'stepInto'
    | 'stepOut'
    | 'stop';
  const root = ctx.workspace.rootPath();

  switch (action) {
    case 'continue':
      await ctx.debug.resume();
      break;
    case 'pause':
      await ctx.debug.pause();
      break;
    case 'stepOver':
      await ctx.debug.step('over');
      break;
    case 'stepInto':
      await ctx.debug.step('into');
      break;
    case 'stepOut':
      await ctx.debug.step('out');
      break;
    default:
      ctx.debug.stop();
      return { ok: true, summary: 'Отладчик остановлен' };
  }

  // Остановка приходит событием адаптера, а не к моменту возврата вызова: кадры
  // могут быть ещё от прошлой стоянки. Показываем, что есть, и честно говорим.
  const frames = ctx.debug.stack();
  if (frames.length === 0) {
    return {
      ok: true,
      summary: `${action}: программа выполняется, стоек нет`,
      detail: 'action status покажет кадры, когда остановится.',
    };
  }
  return {
    ok: true,
    summary: `${action}: ${where(frames[0]?.path, frames[0]?.line, root)}`,
    detail: formatFrames(frames, root),
  };
}

function formatScopes(scopes: readonly { scope: DebugScope; items: readonly DebugVariable[] }[]): string {
  const lines: string[] = [];
  for (const entry of scopes) {
    lines.push(`${entry.scope.name}${entry.scope.expensive ? ' (дорого)' : ''}:`);
    const shown = entry.items.slice(0, MAX_VARIABLES);
    if (shown.length === 0) lines.push('  <пусто>');
    for (const variable of shown) lines.push(describeVariable(variable));
    if (entry.items.length > shown.length) lines.push(`  … ещё: ${entry.items.length - shown.length}`);
  }
  return lines.join('\n');
}

async function variables(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const phase = ctx.debug.status().phase;
  if (phase !== 'stopped') {
    return { ok: false, summary: `Остановки нет: ${phase}`, detail: 'Значения есть только на стоянке.' };
  }
  const frameIndex = optionalInteger(args, 'frame') ?? 0;
  const frames = ctx.debug.stack();
  const frame = frames[frameIndex];
  if (!frame) {
    return { ok: false, summary: 'Остановки нет: кадров нет — программа выполняется или сессия не начата' };
  }

  const scopes = await ctx.debug.scopes(frame.id);
  const groups: { scope: DebugScope; items: readonly DebugVariable[] }[] = [];
  let total = 0;
  for (const scope of scopes) {
    const items = await ctx.debug.variables(scope.variablesReference);
    total += items.length;
    groups.push({ scope, items });
  }

  if (total === 0) return { ok: true, summary: `переменных нет в кадре #${frameIndex}` };

  // Переменные с детьми (объект, массив) показываем по имени — раскрытие
  // отдельной переменной оценивает `evaluate`, второй инструмент не нужен.
  return {
    ok: true,
    summary: `переменных: ${total} в кадре #${frameIndex}`,
    detail: formatScopes(groups),
  };
}

async function evaluate(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const phase = ctx.debug.status().phase;
  if (phase !== 'stopped') {
    return { ok: false, summary: `Остановки нет: ${phase}`, detail: 'Выражение вычисляется только на стоянке.' };
  }
  const expression = requireString(args, 'expression').trim();
  const frames = ctx.debug.stack();
  const frameIndex = optionalInteger(args, 'frame') ?? 0;
  const frame = frames[frameIndex];
  if (!frame) {
    return { ok: false, summary: 'Остановки нет: выражение вычисляется только на стоянке' };
  }

  try {
    const value = await ctx.debug.evaluate(expression, frame.id);
    const type = value.type ? `: ${value.type}` : '';
    return { ok: true, summary: `${expression} = ${value.value}${type}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, summary: `выражение не вычислилось: ${message}` };
  }
}

async function setValue(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.debug) return { ok: false, summary: 'Отладчик недоступен' };
  const expression = requireString(args, 'expression').trim();
  const value = requireString(args, 'value');
  const frames = ctx.debug.stack();
  const frame = frames[optionalInteger(args, 'frame') ?? 0];
  if (!frame) return { ok: false, summary: 'Остановки нет' };

  // `setExpression` в DebugService нет: правка значения идёт через ссылку на
  // переменную — сначала находим её в областях кадра, потом присваиваем.
  const scopes = await ctx.debug.scopes(frame.id);
  for (const scope of scopes) {
    const items = await ctx.debug.variables(scope.variablesReference);
    const target = items.find((item) => item.name === expression);
    if (!target) continue;
    const changed = await ctx.debug.setVariable(scope.variablesReference, target.name, value);
    if (!changed) return { ok: false, summary: `не удалось присвоить ${expression}` };
    return { ok: true, summary: `${expression} = ${changed.value}` };
  }
  return { ok: false, summary: `переменная ${expression} не найдена в кадре` };
}

export async function debugAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'status':
      return await status(ctx);
    case 'breakpoints':
      return await breakpoints(ctx, args);
    case 'start':
      return await start(ctx, args);
    case 'continue':
    case 'pause':
    case 'stepOver':
    case 'stepInto':
    case 'stepOut':
    case 'stop':
      return await perform(ctx, args);
    case 'variables':
      return await variables(ctx, args);
    case 'stack':
      return await stack(ctx);
    case 'evaluate':
      return await evaluate(ctx, args);
    case 'set':
      return await setValue(ctx, args);
    default:
      return unknownAction(
        action,
        'debug: status, breakpoints, start, continue, pause, stepOver, stepInto, stepOut, stop, stack, variables, evaluate, set.',
      );
  }
}
