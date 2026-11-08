/**
 * `open_files`: что человек видит в редакторе прямо сейчас.
 *
 * Самый частый вопрос в чате — «где открыт?», «куда я смотрю?». Ответ знает
 * только renderer (вкладки и курсоры живут там), а агент раньше не мог спросить:
 * оставалось угадывать по `read` и переспрашивать. Отдельный инструмент, а не
 * действие `show`: `show` показывает файл, этот его читает.
 *
 * Без аргументов и без побочных действий: список открытых вкладок — это
 * состояние, а не операция. Цена — имя в ростере, схема пустая.
 */

import { relativePath } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';

/** Сколько вкладок перечислять: больше — это уже не «где я», а инвентаризация. */
const MAX_FILES = 30;

export async function openFiles(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.openFiles) return { ok: false, summary: 'Список открытых файлов недоступен' };

  const { files } = await ctx.openFiles();
  if (files.length === 0) return { ok: true, summary: 'Открытых файлов нет' };

  const root = ctx.workspace.rootPath();
  const active = files.find((file) => file.active);
  // Активная вкладка первой: вопрос обычно именно про неё, и читать её
  // из середины списка — лишняя работа для модели.
  const ordered = [...files].sort((a, b) => Number(b.active) - Number(a.active));
  const shown = ordered.slice(0, MAX_FILES);
  const lines = shown.map((file) => {
    const mark = file.active ? '→ ' : '  ';
    return `${mark}${relativePath(file.path, root)}:${file.line}:${file.column}`;
  });
  if (files.length > shown.length) lines.push(`… ещё вкладок: ${files.length - shown.length}`);

  return {
    ok: true,
    summary: active
      ? `открыто: ${files.length}, активный — ${relativePath(active.path, root)}:${active.line}`
      : `открыто: ${files.length}, активного нет`,
    detail: lines.join('\n'),
  };
}
