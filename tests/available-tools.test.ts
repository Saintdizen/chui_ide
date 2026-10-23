import { describe, expect, it } from 'vitest';
import { canRunTool, canUseWebSearch, type ToolAvailability } from '../src/main/ai/available-tools';

/**
 * Условия «предлагать ли инструмент» проверяются напрямую: до переезда в
 * `available-tools` они были методом сервиса, и единственным способом их
 * проверить было читать исходник глазами или регуляркой.
 */

const empty: ToolAvailability = {
  host: undefined,
  terminals: undefined,
  tests: undefined,
  linter: undefined,
  symbols: undefined,
  browser: undefined,
  browserEnabled: false,
  webSearch: { enabled: false, provider: 'none' } as ToolAvailability['webSearch'],
  webFetchEnabled: false,
  webSearchKey: undefined,
};

const spec = (name: string) => ({ name }) as Parameters<typeof canRunTool>[0];

describe('что предлагать модели', () => {
  it('без моста к окну правка файлов не предлагается', () => {
    expect(canRunTool(spec('edit'), empty)).toBe(false);
    expect(canRunTool(spec('edit'), { ...empty, host: { applyPatches: async () => ({}) } as never })).toBe(true);
  });

  it('терминал — либо сервис терминалов, либо окно для подтверждения', () => {
    expect(canRunTool(spec('terminal'), empty)).toBe(false);
    expect(canRunTool(spec('terminal'), { ...empty, terminals: {} as never })).toBe(true);
  });

  it('браузер сам по себе не включается: нужна настройка', () => {
    const browser = { zoom: () => {} };
    expect(canRunTool(spec('browser'), { ...empty, browser, browserEnabled: false })).toBe(false);
    expect(canRunTool(spec('browser'), { ...empty, browser, browserEnabled: true })).toBe(true);
  });

  it('веб-поиск: выключенный поиск не даёт инструмента, даже если есть что искать', () => {
    expect(canRunTool(spec('web'), empty)).toBe(false);
    expect(canRunTool(spec('web'), { ...empty, webFetchEnabled: true })).toBe(true);
  });

  it('Brave без ключа — не инструмент: он заведомо ответил бы ошибкой', () => {
    const brave = { enabled: true, provider: 'brave' } as ToolAvailability['webSearch'];
    expect(canUseWebSearch({ webSearch: brave, webSearchKey: undefined })).toBe(false);
    expect(canUseWebSearch({ webSearch: brave, webSearchKey: 'k' })).toBe(true);
  });

  it('незнакомый инструмент не предлагается: отказ по умолчанию', () => {
    expect(canRunTool(spec('совсем-новый'), empty)).toBe(false);
  });
});
