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
      return await diagnostics(ctx, args);
    case 'lint':
      return await runLinter(ctx, args);
    default:
      return unknownAction(action, 'checks: diagnostics, lint.');
  }
}

/** Сеть: поиск и чтение страницы — два шага одного пути. */

/* ── диагностика ────────────────────────────────────────────────────────── */

const MAX_DIAGNOSTICS = 60;

/** Пометки языка собирает renderer: они живут в редакторе, а не на диске. */
export async function diagnostics(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.diagnostics) {
    return {
      ok: false,
      summary: 'Диагностика недоступна: окно редактора не подключено',
    };
  }

  const target = optionalString(args, 'path');
  const result = await ctx.diagnostics(target);
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
