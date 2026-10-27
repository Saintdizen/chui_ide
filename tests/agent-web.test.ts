import { describe, expect, it, vi } from 'vitest';
import { mcpAction, runExternalTool, webAction } from '../src/main/ai/agent-web';
import { runTool } from '../src/main/ai/agent-tools';
import type { ToolContext } from '../src/main/ai/tool-context';
import type { McpResourceInfo, McpToolInfo } from '../src/shared/mcp';
import type { FetchedPage } from '../src/shared/web-fetch';
import type { WebSearchHit } from '../src/shared/web-search';

/**
 * Сеть и MCP — единственное место агента, где ответ приходит из чужого процесса.
 * Поэтому проверяем не только удачу, но и отказы: «поиск не подключён», «сервер
 * не поднялся», «человек не разрешил» — это тоже ответ модели, и он должен
 * прийти словами, а не исключением.
 */

interface Parts {
  hits?: WebSearchHit[];
  provider?: string;
  searchError?: Error;
  noSearch?: boolean;
  page?: FetchedPage;
  fetchError?: Error;
  noFetch?: boolean;
  tools?: McpToolInfo[];
  resources?: McpResourceInfo[];
  listError?: Error;
  resourcesError?: Error;
  callResult?: { text: string; isError: boolean };
  readResult?: { text: string; isError: boolean };
  noMcp?: boolean;
  confirm?: (command: string) => Promise<boolean>;
}

function mcpTool(over: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    serverId: 'srv',
    toolName: 'ping',
    exposedName: 'mcp__srv__ping',
    readOnly: true,
    ...over,
  } as McpToolInfo;
}

function page(over: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/a',
    contentType: 'text/html',
    status: 200,
    title: 'Пример',
    text: 'текст страницы',
    links: [],
    truncated: false,
    totalChars: 'текст страницы'.length,
    ...over,
  } as FetchedPage;
}

function ctx(parts: Parts = {}): ToolContext {
  const search = vi.fn(async () => ({
    hits: parts.hits ?? [],
    providerLabel: parts.provider ?? 'Brave',
  }));
  const fetchFn = vi.fn(async () => parts.page ?? page());
  const call = vi.fn(async () => parts.callResult ?? { text: 'ok', isError: false });
  const readResource = vi.fn(async () => parts.readResult ?? { text: 'тело', isError: false });

  const webSearch = parts.noSearch
    ? undefined
    : {
        search: parts.searchError
          ? vi.fn(async () => {
              throw parts.searchError;
            })
          : search,
      };
  const webFetch = parts.noFetch
    ? undefined
    : {
        fetch: parts.fetchError
          ? vi.fn(async () => {
              throw parts.fetchError;
            })
          : fetchFn,
      };

  const mcp = parts.noMcp
    ? undefined
    : {
        list: parts.listError
          ? vi.fn(async () => {
              throw parts.listError;
            })
          : vi.fn(async () => parts.tools ?? []),
        call,
        resources: parts.resourcesError
          ? vi.fn(async () => {
              throw parts.resourcesError;
            })
          : vi.fn(async () => parts.resources ?? []),
        readResource,
      };

  return {
    webSearch,
    webFetch,
    mcp,
    confirmCommand: parts.confirm,
  } as unknown as ToolContext;
}

const hit: WebSearchHit = {
  title: 'Заголовок',
  url: 'https://example.com',
  snippet: 'отрывок',
};

describe('web: разбор действия', () => {
  it('незнакомое действие называет доступные', async () => {
    const outcome = await webAction(ctx(), { action: 'скачать' });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail ?? outcome.summary).toContain('search');
  });

  it('search без query — отказ до похода в сеть', async () => {
    const outcome = await webAction(ctx(), { action: 'search' });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('query');
  });
});

describe('web: search', () => {
  it('без подключённого поиска — словами, а не исключением', async () => {
    const outcome = await webAction(ctx({ noSearch: true }), {
      action: 'search',
      query: 'x',
    });
    expect(outcome).toEqual({ ok: false, summary: 'Веб-поиск не подключён' });
  });

  it('найденное — в сводке число, в подробностях ссылка', async () => {
    const outcome = await webAction(ctx({ hits: [hit] }), {
      action: 'search',
      query: 'кофе',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('1');
    expect(outcome.detail).toContain('https://example.com');
  });

  it('пустая выдача — не ошибка: модель должна сменить формулировку', async () => {
    const outcome = await webAction(ctx(), {
      action: 'search',
      query: 'ничего',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('ничего не найдено');
  });

  it('недоступный сервис — ошибка с причиной', async () => {
    const outcome = await webAction(ctx({ searchError: new Error('нет сети') }), {
      action: 'search',
      query: 'x',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('нет сети');
  });
});

describe('web: fetch', () => {
  it('fetch без url — отказ до похода в сеть', async () => {
    const outcome = await webAction(ctx(), { action: 'fetch' });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('url');
  });

  it('без подключённого чтения страниц — словами', async () => {
    const outcome = await webAction(ctx({ noFetch: true }), {
      action: 'fetch',
      url: 'https://a',
    });
    expect(outcome).toEqual({
      ok: false,
      summary: 'Чтение страниц не подключено',
    });
  });

  it('страница прочитана: отдаём текст', async () => {
    const outcome = await webAction(ctx({ page: page() }), {
      action: 'fetch',
      url: 'https://a',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('текст страницы');
  });

  it('maxChars зажимается в допустимые пределы', async () => {
    const context = ctx({ page: page() });
    const spy = context.webFetch!.fetch as unknown as ReturnType<typeof vi.fn>;
    await webAction(context, {
      action: 'fetch',
      url: 'https://a',
      maxChars: 10,
    });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ maxChars: 1000 });
  });

  it('не открывшаяся страница советует другой источник', async () => {
    const outcome = await webAction(ctx({ fetchError: new Error('404') }), {
      action: 'fetch',
      url: 'https://a',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('404');
    expect(outcome.detail).toContain('другой источник');
  });
});

describe('mcp: разбор действия', () => {
  it('незнакомое действие называет доступные', async () => {
    const outcome = await mcpAction(ctx(), { action: 'перезапусти' });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail ?? outcome.summary).toContain('list');
  });
});

describe('mcp: каталог ресурсов', () => {
  it('без серверов — отказ', async () => {
    const outcome = await mcpAction(ctx({ noMcp: true }), { action: 'list' });
    expect(outcome).toEqual({
      ok: false,
      summary: 'MCP-серверы не подключены',
    });
  });

  it('пустой каталог объясняет, что ресурсов не будет', async () => {
    const outcome = await mcpAction(ctx(), { action: 'list' });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('ресурсов нет');
    expect(outcome.detail).toContain('не ищи ресурсы повторно');
  });

  it('фильтр по серверу: чужое не показываем', async () => {
    const resources: McpResourceInfo[] = [
      { serverId: 'srv', name: 'Документ', uri: 'mem://a' } as McpResourceInfo,
      { serverId: 'other', name: 'Чужой', uri: 'mem://b' } as McpResourceInfo,
    ];
    const outcome = await mcpAction(ctx({ resources }), {
      action: 'list',
      server: 'srv',
    });
    expect(outcome.summary).toContain('1');
    expect(outcome.detail).not.toContain('Чужой');
  });

  it('недоступный каталог — ошибка с причиной', async () => {
    const outcome = await mcpAction(ctx({ resourcesError: new Error('нет связи') }), { action: 'list' });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toBe('Каталог ресурсов недоступен');
    expect(outcome.detail).toContain('нет связи');
  });
});

describe('mcp: чтение ресурса', () => {
  it('read без uri — отказ', async () => {
    const outcome = await mcpAction(ctx(), { action: 'read' });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('uri');
  });

  it('прочитанный ресурс отдаёт тело', async () => {
    const outcome = await mcpAction(ctx({ readResult: { text: 'тело', isError: false } }), {
      action: 'read',
      uri: 'mem://a',
      server: 'srv',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('прочитан');
    expect(outcome.detail).toBe('тело');
  });

  it('ошибка сервера — первая строка в сводке', async () => {
    const outcome = await mcpAction(ctx({ readResult: { text: 'нет доступа', isError: true } }), {
      action: 'read',
      uri: 'mem://a',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('нет доступа');
  });
});

describe('внешний инструмент MCP', () => {
  it('без подключения — словами', async () => {
    const outcome = await runExternalTool(ctx({ noMcp: true }), 'mcp__srv__ping', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('недоступен');
  });

  it('инструмент исчез с сервера — не повторять вызов', async () => {
    const outcome = await runExternalTool(ctx({ tools: [] }), 'mcp__srv__ping', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('Не повторяй');
  });

  it('упавший сервер при поиске инструмента — тот же отказ', async () => {
    const outcome = await runExternalTool(ctx({ listError: new Error('упал') }), 'mcp__srv__ping', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('сейчас недоступен');
  });

  it('только чтение: без вопроса, результат в подробностях', async () => {
    const confirm = vi.fn(async () => true);
    const outcome = await runExternalTool(ctx({ tools: [mcpTool()], confirm }), 'mcp__srv__ping', {});
    expect(confirm).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe('ok');
  });

  it('запись без окна подтверждения — отказ', async () => {
    const outcome = await runExternalTool(ctx({ tools: [mcpTool({ readOnly: false })] }), 'mcp__srv__ping', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('окно не подключено');
  });

  it('человек отказал — вызов не выполняется', async () => {
    const outcome = await runExternalTool(
      ctx({
        tools: [mcpTool({ readOnly: false })],
        confirm: async () => false,
      }),
      'mcp__srv__ping',
      {},
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toBe('Пользователь запретил внешний вызов');
    expect(outcome.detail).toContain('Не повторяй');
  });

  it('человек разрешил — в сводке видно подтверждение', async () => {
    const outcome = await runExternalTool(
      ctx({ tools: [mcpTool({ readOnly: false })], confirm: async () => true }),
      'mcp__srv__ping',
      { a: 1 },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('подтверждено');
  });

  it('ошибка инструмента — первая строка ответа', async () => {
    const outcome = await runExternalTool(
      ctx({
        tools: [mcpTool()],
        callResult: { text: 'сломалось\nподробности', isError: true },
      }),
      'mcp__srv__ping',
      {},
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('сломалось');
    expect(outcome.summary).not.toContain('подробности');
  });
});

describe('маршрутизация диспетчера', () => {
  it('имя mcp__ идёт во внешние инструменты мимо switch', async () => {
    const outcome = await runTool(ctx({ tools: [mcpTool()] }), 'mcp__srv__ping', '{}');
    expect(outcome.ok).toBe(true);
  });

  it('web доходит до поиска', async () => {
    const outcome = await runTool(ctx({ hits: [hit] }), 'web', JSON.stringify({ action: 'search', query: 'x' }));
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('результатов');
  });
});
