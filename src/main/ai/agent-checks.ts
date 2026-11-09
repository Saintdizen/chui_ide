/**
 * Проверки: пометки редактора (`diagnostics`) и линтер — оба про «что не так с
 * кодом», оба не пишут ничего в проект.
 */

import { formatLintReport } from '../../shared/lint';
import type { DiagnosticItem } from '../../shared/api';
import { optionalString, requireString } from './tool-args';
import path from 'node:path';
import { unknownAction } from './agent-present';
import { relativePath } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';

async function runLinter(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.linter) return { ok: false, summary: 'Линтер недоступен' };
  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  const requested = optionalString(args, 'path');
  if (requested) await ctx.workspace.stat(requested);
  const outcome = await ctx.linter.lint(requested);
  if (!outcome.tool) {
    return {
      ok: false,
      summary: 'Линтер не найден',
      detail:
        'В окружении проекта нет подходящего линтера: у Python это ruff, у Node — eslint или biome. ' +
        'Поставь его или проверь код вручную. Не читай файлы заново ради той же проверки.',
    };
  }

  const target = requested ? relativePath(requested, root) : '.';
  const report = formatLintReport({
    tool: outcome.tool,
    target,
    problems: outcome.problems,
  });
  return { ok: true, summary: report.summary, detail: report.detail };
}

export async function checksAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'diagnostics':
      return await diagnostics(ctx, args, false);
    case 'problems':
      return await diagnostics(ctx, args, true);
    case 'lint':
      return await runLinter(ctx, args);
    default:
      return unknownAction(action, 'checks: diagnostics, problems, lint.');
  }
}

/** Сеть: поиск и чтение страницы — два шага одного пути. */

/* ── диагностика ────────────────────────────────────────────────────────── */

const MAX_DIAGNOSTICS = 60;

/**
 * `diagnostics` — пометки файла или папки (проекта при `project: true`).
 *
 * `whole` — режим `problems`: без аргументов берём ВЕСЬ проект. Иначе `diagnostics`
 * без пути отдавал пометки всех файлов, где они есть, но человек и модель читали
 * это как «файл не указан — значит текущий»; проект по умолчанию — из-за того же.
 */
export async function diagnostics(
  ctx: ToolContext,
  args: Record<string, unknown>,
  whole = false,
): Promise<ToolOutcome> {
  if (!ctx.diagnostics) {
    return {
      ok: false,
      summary: 'Диагностика недоступна: окно редактора не подключено',
    };
  }

  const target = optionalString(args, 'path');
  // `folder` — папка, `project` — весь проект: одно и то же поле хоста, разное удобство.
  const folder = optionalString(args, 'folder') ?? (args.project === true || whole ? ctx.workspace.rootPath() ?? undefined : undefined);
  const result = await ctx.diagnostics(target, folder);
  const items = result.items.slice(0, MAX_DIAGNOSTICS);

  if (result.items.length === 0) {
    return {
      ok: true,
      summary: target ? `Ошибок нет: ${path.basename(target)}` : 'Ошибок нет',
      detail: 'Пометок языка нет. Если ждал ошибку — проверь, что файл открыт в редакторе.',
    };
  }

  const root = ctx.workspace.rootPath();
  const lines = items.map((item) => `${formatDiagnostic(item, root)}`);
  if (result.items.length > items.length) lines.push(`… ещё пометок: ${result.items.length - items.length}`);

  const errors = result.items.filter((item) => item.severity === 'error').length;
  const warnings = result.items.length - errors;

  return {
    ok: true,
    summary: `ошибок: ${errors}, предупреждений: ${warnings}`,
    detail: lines.join('\n'),
  };
}

function formatDiagnostic(item: DiagnosticItem, root: string | null): string {
  const where = relativePath(item.path, root);
  return `${where}:${item.line}:${item.column} [${item.severity}] ${item.message}${item.source ? ` (${item.source})` : ''}`;
}
