import { describe, expect, it } from 'vitest';
import {
  findProviderPreset,
  offeredProviderPresets,
  providerConfigError,
  providerConfigFields,
  type ProviderConfigValues,
} from '../src/shared/providers';

/**
 * Окно подключения провайдера: какие поля спрашивать и что мешает сохранить.
 * Поля описывает пресет, поэтому проверки идут от реальных записей `PROVIDER_PRESETS`,
 * а не от выдуманных объектов: так видно, если у провайдера поменяли `needsKey`.
 */

const values = (overrides: Partial<ProviderConfigValues> = {}): ProviderConfigValues => ({
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  protocol: 'openai',
  ...overrides,
});

describe('поля окна подключения', () => {
  it('облачный провайдер спрашивает ключ', () => {
    const deepseek = findProviderPreset('deepseek');
    expect(deepseek).toBeDefined();
    expect(providerConfigFields(deepseek!)).toEqual(['label', 'baseUrl', 'apiKey', 'model']);
  });

  it('локальному серверу ключ не нужен — и про него не спрашивают', () => {
    const ollama = findProviderPreset('ollama');
    expect(ollama).toBeDefined();
    expect(providerConfigFields(ollama!)).not.toContain('apiKey');
  });

  it('пресет может задать поля сам: у «Другого» есть протокол', () => {
    const custom = findProviderPreset('custom');
    expect(custom).toBeDefined();
    expect(providerConfigFields(custom!)).toEqual(['label', 'baseUrl', 'apiKey', 'model', 'protocol']);
  });

  it('в предложении сейчас один провайдер — DeepSeek', () => {
    expect(offeredProviderPresets().map((preset) => preset.id)).toEqual(['deepseek']);
  });
});

describe('проверка значений перед сохранением', () => {
  it('полный набор проходит', () => {
    expect(providerConfigError(findProviderPreset('deepseek')!, values())).toBeNull();
  });

  it('ключ не обязателен: он может быть уже сохранён', () => {
    expect(providerConfigError(findProviderPreset('deepseek')!, values({ apiKey: '' }))).toBeNull();
  });

  it('адрес без схемы не пускают', () => {
    const complaint = providerConfigError(findProviderPreset('deepseek')!, values({ baseUrl: 'api.deepseek.com' }));
    expect(complaint).toContain('http');
  });

  it('пустой адрес не пускают', () => {
    expect(providerConfigError(findProviderPreset('deepseek')!, values({ baseUrl: '   ' }))).not.toBeNull();
  });

  it('безымянное подключение не пускают: в списке была бы пустая строка', () => {
    expect(providerConfigError(findProviderPreset('deepseek')!, values({ label: '  ' }))).not.toBeNull();
  });

  it('без модели не сохраняют: непонятно, кого звать', () => {
    expect(providerConfigError(findProviderPreset('deepseek')!, values({ model: '' }))).not.toBeNull();
  });
});
