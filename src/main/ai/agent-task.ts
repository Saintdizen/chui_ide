import {
  clipDescription,
  formatSubagentReport,
  parseSubagentTasks,
  runWithLimit,
  subagentBatchSize,
  type SubagentFailure,
  type SubagentResult,
  type SubagentTask,
} from '../../shared/subagents';
import type { ToolContext, ToolOutcome } from './tool-context';

/**
 * Инструмент `task`: подзадача в своём контексте.
 *
 * Зачем она вообще нужна: исследование — это десятки чтений, и все они остаются
 * в ленте родителя. Модель платит за них в каждом следующем запросе, хотя нужен
 * ей только вывод. Подзадача платит за свои чтения один раз и возвращает отчёт.
 *
 * Здесь только разбор, пул и сборка сводки — сам прогон модели живёт в
 * `AiService` (там провайдер), и сюда он приходит через `ctx.subagent`. Нет
 * хука — инструмент не предлагается: пообещать вызов, который нечем выполнить,
 * хуже, чем не иметь инструмента.
 */
export async function taskRun(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.subagent) {
    return { ok: false, summary: 'Подзадачи недоступны в этом режиме.' };
  }
  const request = parseSubagentTasks(args);
  if (request.error) return { ok: false, summary: request.error };
  if (request.tasks.length === 0) return { ok: false, summary: 'Пустая подзадача: нужен prompt.' };

  const run = ctx.subagent;
  const pool = await runWithLimit(request.tasks, subagentBatchSize(request.tasks.length), run, {
    signal: ctx.signal,
  });

  // Провал одной не уносит остальные: в сводке он отдельным разделом с причиной.
  const results: SubagentResult[] = pool.done.map((item) => item.value);
  const failures: SubagentFailure[] = pool.failed.map((item) => ({
    description: request.tasks[item.index]?.description ?? clipDescription(undefined),
    reason: item.error instanceof Error ? item.error.message : String(item.error),
  }));

  if (results.length === 0) {
    const reason = failures[0]?.reason ?? 'подзадача не вернула отчёт';
    return { ok: false, summary: `Подзадача не выполнена: ${reason}` };
  }

  const steps = results.reduce((sum, item) => sum + item.steps, 0);
  const title =
    results.length === 1 ? `Подзадача: ${results[0]!.description}` : `Подзадачи (${results.length}): ${steps} шагов`;
  return { ok: failures.length === 0, summary: title, detail: formatSubagentReport(results, failures) };
}

/** Перенести итог прогона в форму отчёта: числа нужны трассе, текст — модели. */
export function subagentResult(task: SubagentTask, text: string, steps: number, usage: { inputTokens?: number; outputTokens?: number }): SubagentResult {
  return {
    description: task.description,
    text,
    steps,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
}
