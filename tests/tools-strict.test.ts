import { describe, expect, it } from 'vitest';
import { toOpenAiTools, type ExposedToolSpec } from '../src/shared/tools';

/**
 * Строгий режим DeepSeek: `strict: true` плюс схемы без ключей, которых он не
 * знает. Проверяем на схеме, похожей на MCP-инструмент: чужие серверы ставят
 * ограничения длины охотно, а с ними провайдер отвергает весь запрос.
 */

const spec = (parameters: Record<string, unknown>): ExposedToolSpec => ({
  name: 'demo',
  description: 'демо',
  inputSchema: parameters,
}) as ExposedToolSpec;

describe('toOpenAiTools в строгом режиме', () => {
  it('по умолчанию strict не ставится', () => {
    const [tool] = toOpenAiTools([spec({ type: 'object', properties: {} })]);
    expect(tool?.function.strict).toBeUndefined();
  });

  it('со strict схема чистится от minLength и прочих неподдерживаемых', () => {
    const [tool] = toOpenAiTools(
      [
        spec({
          type: 'object',
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 64, description: 'почта' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
          },
          required: ['email'],
        }),
      ],
      { strict: true },
    );

    const parameters = tool?.function.parameters as Record<string, any>;
    expect(tool?.function.strict).toBe(true);
    expect(parameters.properties.email).toEqual({ type: 'string', description: 'почта' });
    expect(parameters.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    // Остальное не тронуто: чистка не должна менять саму форму аргументов.
    expect(parameters.required).toEqual(['email']);
  });

  it('исходная схема не меняется', () => {
    const source = { type: 'object', properties: { a: { type: 'string', minLength: 2 } } };
    toOpenAiTools([spec(source)], { strict: true });
    expect(source.properties.a.minLength).toBe(2);
  });
});
