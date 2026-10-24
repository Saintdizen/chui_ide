/**
 * `edit` действием `write`: правки по якорям и запись целиком.
 *
 * Запись целиком без якоря уходит в `create`, остальное — в хост правок. Здесь же
 * сборка ответа: что применилось, что осталось только в буфере редактора и что не
 * удалось. `editAction` — развод по действиям `file`.
 */
import path from 'node:path';
import type { ApplyEditsHostResult } from '../../shared/api';
import {
  EDITOR_MISSING,
  createFile,
  editNeedles,
  editWindows,
  fileAction,
  mergeDecisions,
  normalizeWrite,
  readEditsOutcome,
  splitWholeWrites,
} from './agent-edit';
import { combineOutcomes, parseEdits } from './edit-parsing';
import type { ToolContext, ToolOutcome } from './tool-context';

export async function editFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Сначала форма: обёртки разворачиваются, запись целиком без якоря уходит в `create`.
  const split = await splitWholeWrites(ctx.workspace, normalizeWrite(args));
  const created: ToolOutcome[] = [];
  for (const whole of split.creates)
    created.push(
      await createFile(ctx.workspace, {
        path: whole.path,
        contents: whole.contents,
      }),
    );
  if (split.files.length === 0) return combineOutcomes(created);

  const parsed = parseEdits(split.files);
  const names = [...parsed.anchors, ...parsed.positions].map((file) => path.basename(file.path));

  const decisions: ApplyEditsHostResult[] = [];
  if (parsed.anchors.length > 0) {
    if (!ctx.applyPatches) return combineOutcomes([...created, EDITOR_MISSING]);
    decisions.push(await ctx.applyPatches(parsed.anchors, ctx.autoApprove === true));
  }
  if (parsed.positions.length > 0) {
    if (!ctx.applyEdits) return combineOutcomes([...created, EDITOR_MISSING]);
    decisions.push(await ctx.applyEdits(parsed.positions, ctx.autoApprove === true));
  }

  if (decisions.some((decision) => decision.rejected)) {
    return combineOutcomes([
      ...created,
      {
        ok: false,
        summary: `Пользователь отклонил правки: ${names.join(', ')}`,
        detail: 'Пользователь отклонил правки. Не повторяй этот вызов — предложи другое решение.',
      },
    ]);
  }

  const merged = mergeDecisions(decisions);
  const outcome = readEditsOutcome(merged, (file) => path.basename(file));
  const unwritten = merged.unwritten?.length ?? 0;
  // Файлы легли — показываем окно вокруг правки: иначе модель проверяет результат
  // отдельным `read`, а это в замере — 4,7 тыс. ток. на трёх беседах (6% чтений).
  const window = outcome.ok && unwritten === 0 ? await editWindows(ctx.workspace, editNeedles(parsed)) : '';

  return combineOutcomes([
    ...created,
    {
      ok: outcome.ok,
      summary: `применено файлов: ${outcome.applied.length}${outcome.failed.length ? `, с ошибками: ${outcome.failed.length}` : ''}${outcome.tail}`,
      detail: outcome.detail + window,
      // Тела правок можно забыть только когда они действительно легли в файлы:
      // отклонённая или оставшаяся в буфере правка модели ещё понадобится.
      ...(outcome.ok && unwritten === 0 ? { applied: true } : {}),
    },
  ]);
}

/**
 * Слитая запись: `write` (или его отсутствие) — правки по якорям, остальные
 * действия — файловые операции. `file` остаётся вызываемым по имени ради
 * старых бесед, но схему больше не возит.
 */
export async function editAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = typeof args.action === 'string' && args.action.trim() ? args.action.trim() : 'write';
  if (action === 'write') return await editFiles(ctx, args);
  return await fileAction(ctx, {
    ...args,
    action,
    from: args.from ?? args.path,
  });
}
