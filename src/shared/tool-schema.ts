/**
 * Сверка аргументов вызова со схемой инструмента.
 *
 * Схема обещает модели, какие поля обязательны, но до этого разбора её никто не
 * сверял: забытое поле доезжало до реализации и возвращалось оттуда глубокой
 * ошибкой — модель принималась угадывать форму вызова. Проверка на входе даёт
 * одинаковый и понятный отказ для всех инструментов.
 *
 * Сверяется только НАЛИЧИЕ полей, а не их типы: `numericArg` в `tool-args.ts`
 * нарочно принимает "2" вместо 2, и запрещать это здесь значило бы отвергать
 * вызов, который разбор всё равно понял бы.
 */

import { AGENT_TOOLS, type AgentToolSpec, type JsonSchema, type JsonSchemaProperty } from './tools';

function objectSchema(properties: Record<string, JsonSchemaProperty>, required?: string[]): JsonSchema {
  return required ? { type: 'object', properties, required } : { type: 'object', properties };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Чего не хватает в аргументах — пути полей; пустой список, если всё на месте. */
export function missingArguments(schema: JsonSchema, args: Record<string, unknown>, prefix = ''): string[] {
  const missing: string[] = [];
  for (const name of schema.required ?? []) {
    const value = args[name];
    if (value === undefined || value === null) missing.push(`${prefix}${name}`);
  }
  // Вложенные объекты (`apply_patch`, `apply_edit`): обязательные поля элементов
  // массива проверяются по их схеме — именно там терялся `path`.
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = args[name];
    if (property.type === 'object' && property.properties && isPlainObject(value)) {
      const nested = objectSchema(property.properties, property.required);
      missing.push(...missingArguments(nested, value, `${prefix}${name}.`));
    }
    if (property.type === 'array' && property.items?.properties && Array.isArray(value)) {
      const itemSchema = objectSchema(property.items.properties, property.items.required);
      value.forEach((item, index) => {
        if (!isPlainObject(item)) return;
        missing.push(...missingArguments(itemSchema, item, `${prefix}${name}[${index}].`));
      });
    }
  }
  return missing;
}

/** Схема инструмента по имени — или `undefined`, если имя чужое (MCP). */
export function toolSpec(name: string): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}
