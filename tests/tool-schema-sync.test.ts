import { describe, expect, it } from 'vitest';
import { runTool, type ToolContext } from '../src/main/ai/agent-tools';
import { AGENT_TOOLS, type JsonSchema, type JsonSchemaProperty } from '../src/shared/tools';

/**
 * Сверка схемы с реализацией: каждое объявленное поле должно дойти до разбора.
 *
 * `unknownArguments` отбивает поля мимо схемы (иначе опечатка теряется молча),
 * но у того же правила есть обратная сторона: поле, которое схема ОБЪЯВЛЯЕТ, а
 * валидатор не признаёт, — это поломка без вины модели. Так и вышло с
 * `search`: три булевых поля читались реализацией и отбивались валидатором.
 *
 * Тест ставит заглушку контекста, где каждый обработчик падает на своём первом
 * обращении, и смотрит только одно: назван ли аргумент неизвестным. Глубже не
 * проверяем — у инструментов разная среда (ФС, процессы, LSP), а нам нужна
 * форма вызова, а не результат.
 */

const ctx = { workspace: {} } as unknown as ToolContext;

/** Пример значения по описанию поля: валидатору хватает формы, не смысла. */
function sampleValue(property: JsonSchemaProperty): unknown {
  const options = property.enum;
  if (options && options.length > 0) return options[0];
  if (property.const !== undefined) return property.const;
  if (property.type === 'number') return 1;
  if (property.type === 'boolean') return false;
  if (property.type === 'array') return [];
  if (property.type === 'object') return {};
  return 'x';
}

/** Все поля схемы разом — включая вложенные, иначе расхождение в них не видно. */
function fullArguments(schema: JsonSchema): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (property.type === 'object' && property.properties) {
      args[name] = fullArguments({ type: 'object', properties: property.properties });
    } else if (property.type === 'array' && property.items?.properties) {
      args[name] = [fullArguments({ type: 'object', properties: property.items.properties })];
    } else {
      args[name] = sampleValue(property);
    }
  }
  return args;
}

describe('схема и валидатор не расходятся', () => {
  for (const spec of AGENT_TOOLS) {
    it(`${spec.name}: объявленные поля доходят до разбора`, async () => {
      const outcome = await runTool(ctx, spec.name, JSON.stringify(fullArguments(spec.inputSchema)));
      // Отказ по делу (нет ФС, нет процесса, плохой адрес) — не беда теста.
      // Беда — если валидатор счёл объявленный аргумент незнакомым.
      expect(outcome.summary).not.toContain('Неизвестный аргумент');
    });
  }
});

/**
 * Обратная сторона: поле, которое реализация читает, должно быть в схеме.
 *
 * Односторонняя сверка (выше) выглядит зелёной и тогда, когда поле читается
 * из `args`, но схемой не объявлено: валидатор его отбивает, а тест его и не
 * посылал. Так и жили `search.isRegex`/`caseSensitive`/`filesOnly`.
 *
 * Список проверяемый, а не автоматический: прочитать код и вывести набор
 * ключей нельзя без разбора AST, а тащить парсер ради теста — дороже, чем
 * держать 13 строк руками. Новое поле в реализации — новая строка здесь; это
 * и есть напоминание, что схему надо обновить.
 */
const READENS: { tool: string; fields: string[]; why: string }[] = [
  {
    tool: 'search',
    fields: ['isRegex', 'caseSensitive', 'filesOnly'],
    why: 'agent-search.ts читает их как булевы, схема объявляет только `flags` строкой',
  },
  {
    tool: 'edit',
    fields: ['action'],
    why: 'старая раскладка `action: old|create|replace`, разбор в stillLegacyAction',
  },
  {
    tool: 'terminal',
    fields: ['action'],
    why: 'тесты и промпт шлют `action: run`; инструмент разведён по именам',
  },
  {
    tool: 'file',
    fields: ['action', 'path', 'contents'],
    why: 'старые беседы: `create`/`replace`, `path` вместо `name`, тело в `contents`',
  },
];

describe('читаемое объявлено или осознанно пропущено', () => {
  for (const { tool, fields, why } of READENS) {
    it(`${tool}: поля реализованы (${fields.join(', ')})`, async () => {
      const spec = AGENT_TOOLS.find((candidate) => candidate.name === tool);
      expect(spec, `инструмент ${tool} пропал из реестра`).toBeDefined();
      const args: Record<string, unknown> = {};
      for (const field of fields) args[field] = 'x';
      const outcome = await runTool(ctx, tool, JSON.stringify(args));
      // Не отбито как опечатка — значит реализация поле не теряет.
      expect(outcome.summary, `${tool}: ${why}`).not.toContain('Неизвестный аргумент');
    });
  }
});
