/**
 * `present` — действие `show`: объявить готовый результат.
 *
 * Агент и раньше писал «файл готов, он лежит в docs/тз.md», и человек шёл искать
 * его в дереве. Карточка в ленте делает то же самое одним нажатием: путь и кнопка
 * «Открыть». Файл при этом не читается и не меняется — инструмент только объявляет.
 *
 * Проверяем существование: объявить несуществующий файл — это ложь, на которую
 * человек потратит время. Пути идут через `WorkspaceService`, поэтому за пределы
 * проекта карточка не выведет.
 */
import path from 'node:path';
import type { ToolPresentedFile } from '../../shared/api';
import { optionalString } from './tool-args';
import type { ToolContext, ToolOutcome } from './tool-context';

/** Сколько файлов объявляем за раз: это «вот результат», а не список всего проекта. */
export const MAX_PRESENTED_FILES = 8;

/**
 * Место из аргументов — только положительное целое. Ноль, дробь и строка —
 * не место, а мусор: с ними кнопка встанет не туда, а модель ещё и не узнает.
 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function presentFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = Array.isArray(args.paths) ? args.paths : typeof args.path === 'string' ? [args.path] : [];
  const paths = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (paths.length === 0) {
    return {
      ok: false,
      summary: 'Не указаны файлы',
      detail: 'Инструменту нужен непустой список paths — файлы, которые человек должен открыть.',
    };
  }

  const note = (optionalString(args, 'note') ?? '').trim();
  // Место — у первого файла: у `present` один результат-якорь, его и открываем на месте.
  const line = positiveInteger(args.line);
  const column = positiveInteger(args.column);
  const presented: ToolPresentedFile[] = [];
  const missing: string[] = [];

  for (const item of paths.slice(0, MAX_PRESENTED_FILES)) {
    try {
      const stat = await ctx.workspace.stat(item);
      if (stat.kind === 'directory') {
        missing.push(`${item} (это папка, а не файл)`);
        continue;
      }
      const place = presented.length === 0 ? { line, column } : {};
      presented.push({
        path: stat.path,
        ...(note ? { note } : {}),
        // Пошли вместе: колонка без строки — это уже не место, а догадка.
        ...(place.line === undefined ? {} : { line: place.line }),
        ...(place.line === undefined || place.column === undefined ? {} : { column: place.column }),
      });
    } catch {
      // Файла нет или путь вне проекта: говорим прямо, а не показываем кнопку-обманку.
      missing.push(item);
    }
  }

  const skipped =
    paths.length > MAX_PRESENTED_FILES
      ? ` Ещё ${paths.length - MAX_PRESENTED_FILES} не показаны: потолок ${MAX_PRESENTED_FILES}.`
      : '';
  if (presented.length === 0) {
    return {
      ok: false,
      summary: 'Нечего показать: файлов не нашлось',
      detail: `Не нашлись: ${missing.join(', ')}. Проверь пути — объявлять надо существующие файлы внутри проекта.${skipped}`,
    };
  }

  const names = presented.map((file) => file.path);
  return {
    ok: true,
    summary: presented.length === 1 ? `результат: ${path.basename(names[0]!)}` : `результатов: ${presented.length}`,
    detail: [
      `Готово, показано человеку в ленте: ${names.join(', ')}`,
      missing.length > 0 ? `Не нашлись (не показаны): ${missing.join(', ')}` : '',
      skipped,
      'Ссылки в тексте ответа не нужны: файлы уже перед человеком кнопками.',
    ]
      .filter(Boolean)
      .join('\n'),
    presented,
  };
}

/** Незнакомое действие слитого инструмента: ответ называет допустимые. */
export function unknownAction(action: string, detail: string): ToolOutcome {
  return { ok: false, summary: `Неизвестное действие: ${action}`, detail };
}
