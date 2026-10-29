import { describe, expect, it } from 'vitest';
import { canRunTool, canUseWebSearch, narrowToolSpec, type ToolAvailability } from '../src/main/ai/available-tools';
import { AGENT_TOOLS, WEB_ACTION_TEXT } from '../src/shared/tools';

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
  webSearch: { enabled: false, provider: 'none' } as unknown as ToolAvailability['webSearch'],
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

  it('браузер сам по себе не включается: нужна настройка и окно для подтверждения', () => {
    const browser = { zoom: () => {} };
    const host = { confirmBrowser: async () => true } as never;
    expect(canRunTool(spec('browser'), { ...empty, browser, browserEnabled: false, host })).toBe(false);
    // Одно окно без настройки — тоже не повод предлагать: настройка выключена.
    expect(canRunTool(spec('browser'), { ...empty, browser, browserEnabled: true })).toBe(false);
    expect(canRunTool(spec('browser'), { ...empty, browser, browserEnabled: true, host })).toBe(true);
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

  describe('enum сужается до живых действий', () => {
    const web = AGENT_TOOLS.find((tool) => tool.name === 'web');

    it('только fetch без поиска — уходят и действие, и чужие поля', () => {
      const schema = narrowToolSpec(web!, { ...empty, webFetchEnabled: true }).inputSchema;
      expect(schema.properties.action?.enum).toEqual(['fetch']);
      // Текст суженного действия — ровно тот же, что в полной схеме: одна
      // константа на два места, иначе подсказка разойдётся с реальностью.
      expect(schema.properties.action?.description).toBe(WEB_ACTION_TEXT.fetch);
      expect(Object.keys(schema.properties).sort()).toEqual(['action', 'maxChars', 'url']);
    });

    it('только поиск без fetch — остаётся search и его поля', () => {
      const brave = { enabled: true, provider: 'brave' } as ToolAvailability['webSearch'];
      const schema = narrowToolSpec(web!, { ...empty, webSearch: brave, webSearchKey: 'k' }).inputSchema;
      expect(schema.properties.action?.enum).toEqual(['search']);
      expect(schema.properties.action?.description).toBe(WEB_ACTION_TEXT.search);
      expect(Object.keys(schema.properties).sort()).toEqual(['action', 'limit', 'query']);
    });

    it('живо всё — схема не тронута, включая порядок и описание', () => {
      const brave = { enabled: true, provider: 'brave' } as ToolAvailability['webSearch'];
      const env = { ...empty, webFetchEnabled: true, webSearch: brave, webSearchKey: 'k' };
      expect(narrowToolSpec(web!, env)).toBe(web);
    });

    it('не живо ничего — схему не оголяем', () => {
      expect(narrowToolSpec(web!, empty)).toBe(web);
    });
  });

  /**
   * Печать достижимости: каждое объявленное имя обязано включаться хоть при
   * каком-то окружении. Новый инструмент без условия в `canRunTool` и без
   * флага `alwaysAvailable` молча выпадает из пробы — здесь это падает, а не
   * всплывает потом «почему модель его не видит».
   */
  it('у каждого объявленного инструмента есть окружение, в котором он предлагается', () => {
    // Всё, что только можно: и мост к окну, и все сервисы, и обе настройки.
    const host = {
      applyPatches: async () => ({}),
      applyEdits: async () => ({}),
      confirmCommand: async () => true,
      confirmBrowser: async () => true,
      getDiagnostics: async () => [],
      openFile: async () => {},
    } as never;
    const full: ToolAvailability = {
      ...empty,
      host,
      terminals: {} as never,
      tests: {} as never,
      linter: {} as never,
      symbols: {} as never,
      browser: { zoom: () => {} },
      browserEnabled: true,
      webFetchEnabled: true,
      webSearch: { enabled: true, provider: 'brave' } as ToolAvailability['webSearch'],
      webSearchKey: 'k',
    };

    // `mcp` — отдельный случай: в статическом отборе его нет нарочно, схемы
    // ресурсов добавляет подключение (см. `resourceTools`).
    const reachable = AGENT_TOOLS.map((tool) => tool.name).filter(
      (name) => canRunTool(spec(name), full) || name === 'mcp',
    );
    expect(reachable).toEqual(AGENT_TOOLS.map((tool) => tool.name));
  });
});
