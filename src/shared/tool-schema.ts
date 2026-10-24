/**
 * Сверка аргументов вызова со схемой инструмента.
 *
 * Схема обещает модели, какие поля обязательны, но до этого разбора её никто не
 * сверял: забытое поле доезжало до реализации и возвращалось оттуда глубокой
 * ошибкой — модель принималась угадывать форму вызова. Проверка на входе даёт
 * одинаковый и понятный отказ для всех инструментов.
 *
 * Сверяется НАЛИЧИЕ полей и значения `enum`, но не типы: `numericArg` в
 * `tool-args.ts` нарочно принимает "2" вместо 2, и запрещать это здесь значило бы
 * отвергать вызов, который разбор всё равно понял бы. `enum` — не тип, а перечень
 * допустимых значений: "closed" вместо "done" — тоже строка, и без сверки модель
 * узнавала о промахе уже после шага.
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
  // Вложенные объекты (`edit`, обе формы): обязательные поля элементов
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
  // Условная часть схемы (`if/then`): набор обязательных полей зависит от действия —
  // у `terminal` `id` нужен для `read`, но не для `clear`. Без этого шага `switch`
  // ниже отвечал формой не того действия, и модель угадывала заново.
  for (const branch of schema.allOf ?? []) {
    const condition = branch.if?.properties;
    if (!condition) continue;
    const matched = Object.entries(condition).every(([key, expected]) => {
      const actual = args[key];
      if (expected.enum) return typeof actual === 'string' && expected.enum.includes(actual);
      if (expected.const !== undefined) return actual === expected.const;
      // Условие без перечня — «поле задано»: промах по значению ловит `wrongArguments`.
      return actual !== undefined && actual !== null;
    });
    if (!matched) continue;
    for (const requiredField of branch.then?.required ?? []) {
      const actual = args[requiredField];
      if (actual === undefined || actual === null) missing.push(`${prefix}${requiredField}`);
    }
  }
  return missing;
}

/**
 * Форма вызова одной строкой — к отказу «не хватает аргумента».
 *
 * Отказ называл потерянное поле, но не говорил, куда его класть: `edit`
 * присылали плоским (`{path, edits: [{oldText, newText}]}`) вместо обёртки
 * `edits: [{path, edits: [...]}]`, и каждый промах стоил шага переделки.
 * Строка строится из самой схемы, поэтому с ней не разойдётся и токенов
 * в шаге не стоит: платит только промах.
 */
export function describeShape(schema: JsonSchema, depth = 0): string {
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(schema.properties ?? {}).map(
    ([name, property]) => `${name}${required.has(name) ? '' : '?'}${shapeTail(property, depth)}`,
  );
  return parts.join(', ');
}

/** Хвост формы для одного поля: вложенные объекты и массивы объектов. */
function shapeTail(property: JsonSchemaProperty, depth: number): string {
  // Глубже четырёх уровней схемы не уходят — дальше форма только мешает читать.
  if (depth >= 3) return '';
  const inner = (properties: Record<string, JsonSchemaProperty>, required?: string[]) =>
    describeShape({ type: 'object', properties, required }, depth + 1);
  if (property.type === 'object' && property.properties) {
    return `: {${inner(property.properties, property.required)}}`;
  }
  if (property.type === 'array' && property.items?.properties) {
    return `: [{${inner(property.items.properties, property.items.required)}}]`;
  }
  return '';
}

/** Одно значение мимо схемы: где, что пришло, что допускается. */
export interface ArgumentIssue {
  /** Путь поля: `action`, `steps[0].status`. */
  path: string;
  /** Что пришло от модели. */
  value: string;
  /** Что допускает схема. */
  allowed: readonly string[];
}

/**
 * Значения вне `enum` — пути полей вместе со списком допустимых.
 *
 * Отказ на входе ровно с перечнем дешевле шага: иначе `action: 'term'` доезжает
 * до `switch` и оттуда возвращается «неизвестное действие» без вариантов. Вложенные
 * объекты и элементы массивов обходятся: `update_plan.status` лежит внутри `steps[]`.
 */
export function wrongArguments(schema: JsonSchema, args: Record<string, unknown>, prefix = ''): ArgumentIssue[] {
  const wrong: ArgumentIssue[] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    const value = args[name];
    if (property.enum && typeof value === 'string' && !property.enum.includes(value)) {
      wrong.push({ path: `${prefix}${name}`, value, allowed: property.enum });
    }
    if (property.type === 'object' && property.properties && isPlainObject(value)) {
      wrong.push(...wrongArguments(objectSchema(property.properties, property.required), value, `${prefix}${name}.`));
    }
    if (property.type === 'array' && property.items?.properties && Array.isArray(value)) {
      const itemSchema = objectSchema(property.items.properties, property.items.required);
      value.forEach((item, index) => {
        if (!isPlainObject(item)) return;
        wrong.push(...wrongArguments(itemSchema, item, `${prefix}${name}[${index}].`));
      });
    }
  }
  return wrong;
}

/** Схема инструмента по имени — или `undefined`, если имя чужое (MCP). */
export function toolSpec(name: string): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((tool) => tool.name === name);
}

/**
 * Схема инструмента к отказу по аргументам — тот же JSON, но без прозы.
 *
 * Инструменты из ростера едут в запросе одной строкой (п.45); форма его
 * аргументов модели неизвестна, и промах стоил двух шагов: сначала «не хватает
 * аргумента», потом угадывание. Форма в отказе — та же схема без описаний:
 * модель видит имена и типы, а цену платит только промах (не каждый шаг).
 * Описания остаются у полей, но в одну строку — по ним видно, что куда класть
 * (`text`, `question`, `steps` у `mind`).
 */
export function argumentsShape(schema: JsonSchema, depth = 0): string {
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(schema.properties ?? {}).map(([name, property]) => {
    const mark = required.has(name) ? '' : '?';
    const enumList = property.enum ? `=${property.enum.join('|')}` : '';
    const inner = depth >= 3 ? '' : shapeTail(property, depth);
    return `${name}${mark}:${property.type ?? 'any'}${enumList}${inner}`;
  });
  return parts.length > 0 ? `{${parts.join(', ')}}` : '{}';
}
