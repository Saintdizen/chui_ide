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
    expect(modelPricing('gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 });
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
