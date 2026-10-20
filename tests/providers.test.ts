import { describe, expect, it } from 'vitest';
import {
  contextWindow,
  findProviderPreset,
  modelCapabilities,
  modelPricing,
  reasoningEffortFor,
} from '../src/shared/providers';

describe('modelCapabilities', () => {
  it('o-серия: reasoning_effort есть, temperature нет', () => {
    const caps = modelCapabilities('o3-mini');
    expect(caps.reasoningEffort).toBe(true);
    expect(caps.temperature).toBe(false);
  });

  it('deepseek-reasoner: ни усилия, ни температуры', () => {
    const caps = modelCapabilities('deepseek-reasoner');
    expect(caps.reasoningEffort).toBe(false);
    expect(caps.temperature).toBe(false);
  });

  it('обычная модель: temperature есть, усилия нет', () => {
    const caps = modelCapabilities('gpt-4o-mini');
    expect(caps.reasoningEffort).toBe(false);
    expect(caps.temperature).toBe(true);
  });

  it('открытые reasoning-модели принимают оба параметра', () => {
    const caps = modelCapabilities('qwen3-32b');
    expect(caps.reasoningEffort).toBe(true);
    expect(caps.temperature).toBe(true);
  });
});

describe('reasoningEffortFor', () => {
  it('off не отправляем', () => {
    expect(reasoningEffortFor('o3-mini', 'off')).toBeUndefined();
  });

  it('на модели без поддержки параметр не уезжает', () => {
    expect(reasoningEffortFor('gpt-4o', 'high')).toBeUndefined();
  });

  it('на поддерживающей модели усилие сохраняется', () => {
    expect(reasoningEffortFor('o3-mini', 'high')).toBe('high');
  });
});

describe('contextWindow', () => {
  it('распознаёт известные модели', () => {
    expect(contextWindow('gemini-2.5-pro')).toBe(1_000_000);
    expect(contextWindow('o3-mini')).toBe(200_000);
    expect(contextWindow('claude-sonnet-4-5')).toBe(200_000);
  });

  it('незнакомая модель → разумное значение по умолчанию', () => {
    expect(contextWindow('какая-то-модель')).toBe(128_000);
  });

  it('явное значение из настроек важнее эвристики', () => {
    expect(contextWindow('gemini-2.5-pro', 32_000)).toBe(32_000);
    // Некорректное переопределение игнорируется.
    expect(contextWindow('gemini-2.5-pro', 0)).toBe(1_000_000);
    expect(contextWindow('gemini-2.5-pro', Number.NaN)).toBe(1_000_000);
  });
});

describe('modelPricing', () => {
  it('известная модель', () => {
    expect(modelPricing('gpt-4o-mini')).toMatchObject({ input: 0.15, output: 0.6 });
  });

  it('пустое имя → null', () => {
    expect(modelPricing('   ')).toBeNull();
  });

  it('локальная модель без цены → null', () => {
    expect(modelPricing('qwen2.5-coder:7b')).toBeNull();
  });
});

describe('findProviderPreset', () => {
  it('находит по id', () => {
    expect(findProviderPreset('openai')?.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('неизвестный id → undefined', () => {
    expect(findProviderPreset('nope')).toBeUndefined();
  });
});

describe('modelCapabilities: разбор имён', () => {
  it('OpenAI o-серия и gpt-5 думают сами, temperature отвергают', () => {
    for (const name of ['o1-preview', 'o4-mini', 'gpt-5']) {
      const caps = modelCapabilities(name);
      expect(caps.reasoningEffort).toBe(true);
      expect(caps.temperature).toBe(false);
      expect(caps.note).toBeTruthy();
    }
  });

  it('открытые reasoning-модели распознаются по имени', () => {
    for (const name of ['qwq-32b', 'deepseek-r1', 'some-distill', 'grok-3-mini', 'grok-4']) {
      const caps = modelCapabilities(name);
      expect(caps.reasoningEffort).toBe(true);
      expect(caps.temperature).toBe(true);
    }
  });

  it('регистр и пробелы в имени не мешают', () => {
    expect(modelCapabilities('  O3-MINI  ').reasoningEffort).toBe(true);
  });
});

describe('contextWindow: разбор имён', () => {
  it('deepseek и grok получают свои окна', () => {
    expect(contextWindow('deepseek-chat')).toBe(64_000);
    expect(contextWindow('grok-4')).toBe(131_072);
  });

  it('gpt-5 попадает в окно o-серии', () => {
    expect(contextWindow('gpt-5-mini')).toBe(200_000);
  });
});

describe('modelPricing: прайс по семействам', () => {
  it('OpenAI', () => {
    expect(modelPricing('gpt-4o')).toMatchObject({ input: 2.5, output: 10 });
    expect(modelPricing('gpt-4.1-mini')).toMatchObject({ input: 0.4, output: 1.6 });
    expect(modelPricing('gpt-4.1')).toMatchObject({ input: 2, output: 8 });
    expect(modelPricing('o4-mini')).toMatchObject({ input: 1.1, output: 4.4 });
    expect(modelPricing('o3')).toMatchObject({ input: 10, output: 40 });
    expect(modelPricing('o1-mini')).toMatchObject({ input: 1.1, output: 4.4 });
    expect(modelPricing('o1')).toMatchObject({ input: 15, output: 60 });
    expect(modelPricing('gpt-5')).toMatchObject({ input: 1.25, output: 10 });
  });

  it('DeepSeek', () => {
    expect(modelPricing('deepseek-reasoner')).toMatchObject({ input: 0.55, output: 2.19 });
    expect(modelPricing('deepseek-chat')).toMatchObject({ input: 0.27, output: 1.1 });
  });

  it('Anthropic через шлюз', () => {
    expect(modelPricing('claude-opus-4-1')).toMatchObject({ input: 15, output: 75 });
    expect(modelPricing('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 });
    expect(modelPricing('claude-sonnet-4-5')).toMatchObject({ input: 3, output: 15 });
  });

  it('кеш промпта: скидка за чтение и надбавка за запись', () => {
    // Без этих двух чисел нельзя ответить, окупается ли кеш: попадание дешевле
    // обычного ввода, а запись у Anthropic дороже.
    expect(modelPricing('gpt-4o')).toMatchObject({ cachedInput: 1.25, cacheWrite: 2.5 });
    expect(modelPricing('claude-sonnet-4-5')?.cachedInput).toBeCloseTo(0.3, 10);
    expect(modelPricing('claude-sonnet-4-5')?.cacheWrite).toBe(3.75);
    expect(modelPricing('deepseek-chat')?.cachedInput).toBeCloseTo(0.027, 10);
  });

  it('из пресетов и прочее', () => {
    expect(modelPricing('llama-3.3-70b-versatile')).toMatchObject({ input: 0.59, output: 0.79 });
    expect(modelPricing('некая-модель')).toBeNull();
  });
});
