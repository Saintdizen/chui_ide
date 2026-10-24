/**
 * `show` — открыть файл в редакторе и предложить результат кнопками.
 *
 * `open` — вкладка и позиция, `present` — карточка с путями. `unknownTool` лежит
 * здесь же: это ответ на имя, которого нет в реестре, и он должен называть явно
 * те имена, что есть, а не молчать.
 */
import { AGENT_TOOLS } from '../../shared/tools';
import { missingForAction, optionalInteger, requireString } from './tool-args';
import { presentFiles, unknownAction } from './agent-present';
import { relative } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';

/* ── открытие файла в редакторе ─────────────────────────────────────────── */

export async function showAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Показ одним именем: открыть файл и предложить результат кнопками — две
  // стороны одного «вот здесь», а стоили двух схем каждая.
  const action = requireString(args, 'action').trim();
  if (action === 'open') return missingForAction(args, ['path']) ?? (await openFile(ctx, args));
  if (action === 'present') return await presentFiles(ctx, args);
  return unknownAction(action, 'show: open, present.');
}

/** Открывает файл в renderer: вкладка и позиция — дело интерфейса, не ФС. */
export async function openFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.openFile) {
    return {
      ok: false,
      summary: 'Открытие файла недоступно: окно редактора не подключено',
    };
  }

  const target = requireString(args, 'path');
  const line = optionalInteger(args, 'line');
  const column = optionalInteger(args, 'column');
  await ctx.openFile(target, line, column);

  const rel = relative(target, ctx.workspace.rootPath());
  return {
    ok: true,
    summary: `открыт ${rel}${line ? `:${line}` : ''}`,
    detail: 'Файл открыт в редакторе.',
  };
}

/**
 * Незнакомое имя инструмента: назвать те, что есть.
 *
 * Имена сливались (`apply_patch` → `edit`, `read_file` → `read`), а сохранённая
 * беседа продолжается: модель копирует прошлый вызов. Голое «инструмент
 * недоступен» стоит целого шага — агент пробует другое имя наугад. Перечень имён
 * в ответе (около 40 токенов) дешевле потерянного шага.
 */
export function unknownTool(name: string): ToolOutcome {
  return {
    ok: false,
    summary: `Инструмент недоступен: ${name}`,
    detail: `Такого инструмента нет. Доступные: ${AGENT_TOOLS.map((tool) => tool.name).join(', ')}.`,
  };
}
