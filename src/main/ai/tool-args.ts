/**
 * Разбор необязательных аргументов вызова: строки, флаги, целые числа.
 *
 * Модели шлют одно и то же число то числом, то строкой («2»), флаг — то `true`,
 * то `"true"`. Терять из-за этого аргумент нельзя: без номера строки инструмент
 * сделает не то, что просили. Поэтому разбор в одном месте и терпимый; где
 * промах дорог, инструмент отказывает сам (`missingForAction`).
 */
import { booleanArg, integerArg } from '../../shared/tool-args';
import { argumentsShape, toolSpec } from '../../shared/tool-schema';
import type { ToolOutcome } from './tool-context';

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Не задан аргумент «${key}»`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Список строк из аргумента: массив — как есть, одиночная строка — один элемент.
 * Модель иной раз шлёт единственный вариант строкой — терять его из-за этого нельзя.
 * Пустое и нестроковое отбрасываем: битая метка в кнопке хуже её отсутствия.
 */
export function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0);
}

/**
 * Необязательный флаг. `"true"` и `1` — тоже «да»: строкой флаг приходит не реже,
 * чем числом (см. `shared/tool-args.ts`), а потерянный флаг меняет смысл вызова —
 * `staged: "true"` без разбора читался бы как обычный diff рабочего дерева.
 */
export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return booleanArg(args[key]);
}

/**
 * Необязательное целое. Число может прийти строкой («2») — модели и провайдеры
 * шлют и так, и терять из-за этого аргумент нельзя: без номера строки инструмент
 * делает не то, что просили. Неразбираемое значение — `undefined`, и дальше
 * каждый инструмент решает сам (там, где промах дорог, — отказывает с текстом).
 */
export function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  return integerArg(args[key]);
}

/**
 * `mcp` (action list) — каталог ресурсов MCP: адреса, имена, типы.
 *
 * Ресурс — не действие, а документ: сервер объявляет у себя адреса, и их читают.
 * Каталог отдаём целиком (с потолком внутри `formatMcpResources`): модель иначе
 * придумывает uri по аналогии, а сервер отвечает «нет такого ресурса».
 */

/**
 * Отказ, если для действия не хватает аргументов.
 *
 * Схема сверяет только поля, общие для всех действий (`action`), а `url` нужен
 * одному `open`, `ref` — `click`. Проверяем до обработчика: ответ называет место,
 * как и у остальных инструментов, а не «не задан аргумент» из глубины.
 */
export function missingForAction(
  args: Record<string, unknown>,
  keys: readonly string[],
  tool?: string,
): ToolOutcome | null {
  for (const key of keys) {
    const value = args[key];
    // `edit` называет списком не только строки: `paths` — массив, и пустой
    // массив значит «аргумента нет», а не «проиндексировать всё».
    // Элемент массива — не всегда строка: у `edit` это объект (`patches[]`,
    // `edits[]`), и он тоже считается аргументом, иначе вызов с готовым
    // аргументом получал бы «нужен аргумент patches».
    const present = Array.isArray(value)
      ? value.some((item) =>
          typeof item === 'string' ? item.trim().length > 0 : typeof item === 'object' && item !== null,
        )
      : typeof value === 'string' && value.trim().length > 0;
    if (!present) {
      // Поле действия — плюс вся форма: `mind` и прочие из ростера не возят схему,
      // и кроме имени поля модели нужно знать, какие ещё поля у инструмента есть.
      const shape = toolSpec(tool ?? '');
      return {
        ok: false,
        summary: `Действию «${String(args.action)}» нужен аргумент «${key}». Форма: ${keys.join(', ')}`,
        detail:
          `${String(args.action)} требует: ${keys.join(', ')}.` +
          (shape ? `\nАргументы ${shape.name}: ${argumentsShape(shape.inputSchema)}` : ''),
      };
    }
  }
  return null;
}
