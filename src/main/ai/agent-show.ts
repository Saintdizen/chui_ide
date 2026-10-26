/**
 * `show` — открыть файл в редакторе и предложить результат кнопками.
 *
 * `open` — вкладка и позиция, `present` — карточка с путями. `unknownTool` лежит
 * здесь же: это ответ на имя, которого нет в реестре, и он должен называть явно
 * те имена, что есть, а не молчать.
 */
import { AGENT_TOOLS } from '../../shared/tools';
import { describeShape } from '../../shared/tool-schema';
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
 * Незнакомое имя инструмента: назвать те, что есть, и напомнить форму.
 *
 * Имена сливались (`apply_patch` → `edit`, `read_file` → `read`), а сохранённая
 * беседа продолжается: модель копирует прошлый вызов. Голое «инструмент
 * недоступен» стоит целого шага — агент пробует другое имя наугад. Перечень имён
 * в ответе (около 40 токенов) дешевле потерянного шага.
 *
 * Имя могло быть угадано и в ростере (`mind`, `browser`, `show`): их схема в
 * запросе — одна строка без полей, и промах по полю давал «Не хватает аргумента»
 * без подсказки, что класть. Форма `AGENT_TOOLS` стоит сорок токенов и только
 * на промахе.
 *
 * Похожие имена идут первыми и по одному в строке: плоский список из двадцати
 * форм превращал подсказку в дамп, и `read` терялся среди `terminal*` именно
 * тогда, когда `read_file` и звали.
 */
export function unknownTool(name: string): ToolOutcome {
  const names = AGENT_TOOLS.map((tool) => tool.name).join(', ');
  const shape = rosterShape(name);
  return {
    ok: false,
    summary: `Инструмент недоступен: ${name}`,
    detail:
      `Такого инструмента нет. Доступные: ${names}.` +
      (shape ? `\nФорма аргументов (поле? — необязательное): ${shape}` : ''),
  };
}

/** Формы аргументов для `unknownTool`: сперва похожие имена, потом остальные. */
function rosterShape(name: string): string {
  const prefix = name.slice(0, 3).toLowerCase();
  const similar: string[] = [];
  const others: string[] = [];
  for (const tool of AGENT_TOOLS) {
    const shape = describeShape(tool.inputSchema);
    if (!shape) continue;
    const part = `${tool.name}(${shape})`;
    if (prefix && tool.name.toLowerCase().startsWith(prefix)) similar.push(part);
    else others.push(part);
  }
  // Похожие — по одному в строке: иначе в плоском списке из 20 форм именно они
  // теряются среди чужих, и подсказка не подсказывает.
  return [similar.length > 0 ? `\nПохожие:\n  ${similar.join('\n  ')}` : '', others.join(' ')]
    .filter(Boolean)
    .join('\nОстальные: ');
}
