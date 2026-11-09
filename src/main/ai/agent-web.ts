/**
 * Сеть и MCP: поиск в вебе, чтение страницы, каталог ресурсов MCP, сам ресурс и
 * запуск внешнего MCP-инструмента. Всё здесь — разговор с чужим процессом или
 * сайтом, поэтому общего с поиском по проекту только формы аргументов.
 */

import { formatFetchedPage, type FetchedPage } from '../../shared/web-fetch';
import { formatMcpResources } from '../../shared/mcp';
import { missingForAction, optionalInteger, optionalString, requireString } from './tool-args';
import type { ToolContext, ToolOutcome } from './tool-context';
import { MAX_FETCH_CHARS, DEFAULT_WEB_RESULTS, MAX_WEB_RESULTS } from './agent-limits';
import { formatWebResults } from '../../shared/web-search';
import { describeValue } from '../../shared/tool-args';
import type { McpResourceInfo, McpToolInfo } from '../../shared/mcp';
import { unknownAction } from './agent-present';

/**
 * Вызов внешнего инструмента (MCP).
 *
 * Две проверки перед исполнением. Первая: инструмент всё ещё существует — сервер
 * мог не подняться или его выключили в настройках, а модель работает со списком,
 * собранным в начале прогона. Вторая: если сервер не пометил инструмент как
 * «только чтение», спрашиваем человека — внешний инструмент может изменить что
 * угодно, и подтверждение здесь то же, что для команд терминала.
 */
export async function runExternalTool(
  ctx: ToolContext,
  exposedName: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (!ctx.mcp)
    return {
      ok: false,
      summary: `Внешний инструмент недоступен: ${exposedName}`,
    };

  let tool: McpToolInfo | undefined;
  try {
    tool = (await ctx.mcp.list()).find((item) => item.exposedName === exposedName);
  } catch {
    tool = undefined;
  }
  if (!tool) {
    return {
      ok: false,
      summary: `Внешний инструмент «${exposedName}» сейчас недоступен`,
      detail: 'Сервер не запущен или отключён. Не повторяй вызов — продолжи без него.',
    };
  }

  if (!tool.readOnly) {
    if (!ctx.confirmCommand) {
      return {
        ok: false,
        summary: 'Внешний вызов требует подтверждения, но окно не подключено',
      };
    }
    const allowed = await ctx.confirmCommand(`${exposedName} ${JSON.stringify(args)}`);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил внешний вызов',
        detail: 'Пользователь не разрешил этот вызов. Не повторяй его — предложи другое решение.',
      };
    }
  }

  const result = await ctx.mcp.call(exposedName, args);
  const first = result.text.split('\n')[0] ?? '';
  return {
    ok: !result.isError,
    summary: result.isError
      ? `${exposedName}: ошибка — ${first.slice(0, 120)}`
      : `${exposedName}${tool.readOnly ? '' : ' (подтверждено)'}`,
    detail: result.text,
  };
}

/**
 * Веб-поиск. Пустая выдача — не ошибка инструмента: модель должна узнать, что по
 * такому запросу ничего нет, и сменить формулировку. Ошибкой считаем только
 * недоступность сервиса — тогда в ответе есть текст причины.
 */
async function webSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.webSearch) return { ok: false, summary: 'Веб-поиск не подключён' };

  const query = requireString(args, 'query');
  const limit = Math.min(Math.max(optionalInteger(args, 'limit') ?? DEFAULT_WEB_RESULTS, 1), MAX_WEB_RESULTS);

  try {
    const { hits, providerLabel } = await ctx.webSearch.search(query, limit, ctx.signal);
    const shaped = formatWebResults(query, providerLabel, hits);
    return { ok: true, summary: shaped.summary, detail: shaped.detail };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: `Веб-поиск недоступен: ${reason}`,
      detail: 'Поиск не выполнился. Не повторяй тот же запрос — ответь по тому, что известно из проекта.',
    };
  }
}

/**
 * Чтение страницы по ссылке. Отказ объясняем причиной: «сайт не пускает без
 * входа», «такой страницы нет» — это разные вещи, и дальше модель действует
 * по-разному: в первом случае меняет источник, во втором — проверяет адрес.
 *
 * Чужое содержимое помечено в ответе как данные, а не как указания: текст
 * страницы может содержать что угодно, включая просьбы выполнить команду.
 */
async function webFetch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.webFetch) return { ok: false, summary: 'Чтение страниц не подключено' };

  const url = requireString(args, 'url');
  const requested = optionalInteger(args, 'maxChars');
  const maxChars = requested === undefined ? undefined : Math.min(Math.max(requested, 1000), MAX_FETCH_CHARS);

  try {
    const page = await ctx.webFetch.fetch(url, {
      signal: ctx.signal,
      maxChars,
    });
    const shaped = formatFetchedPage(page);
    // `saveTo`: страница целиком — в файл проекта, а модели — адрес и размеры.
    // Страница на 400 КБ в контексте не нужна ни целиком, ни обрезком: дальше
    // работают с файлом — search по нему, read диапазоном.
    const saveTo = optionalString(args, 'saveTo');
    if (saveTo) return await savePageToFile(ctx, page, saveTo, shaped);
    return { ok: true, summary: shaped.summary, detail: shaped.detail };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: `Страница не открылась: ${reason}`,
      detail:
        'Эта страница не прочиталась. Не повторяй тот же адрес: возьми другой источник ' +
        'или ответь по тому, что уже известно. Если адрес ведёт на файл (картинку, архив, pdf), ' +
        'его скачивают терминалом.',
    };
  }
}

/**
 * Страница — в файл проекта, а не в контекст.
 *
 * Зачем: длинный документ (спецификация, лог, README чужого проекта) в ответе
 * `fetch` — это обрезанный текст, по которому дальше всё равно не поработать:
 * ни поискать, ни прочитать с середины. Файл в проекте решает это одним
 * движением: `search` по нему, `read` диапазоном, и в контекст попадает только
 * то, что нужно.
 *
 * Пишем ровно тот текст, что собрал `fetch` (он уже вырезал разметку), но при
 * `saveTo` не режем по `maxChars`: смысл в полноте. Размер называем честно —
 * и сколько символов, и сколько строк.
 */
async function savePageToFile(
  ctx: ToolContext,
  page: FetchedPage,
  saveTo: string,
  shaped: { summary: string; detail: string },
): Promise<ToolOutcome> {
  const text = page.text;
  // Пустая страница — не повод создать пустой файл: об этом лучше сказать.
  if (text.trim().length === 0) {
    return {
      ok: true,
      summary: `${page.finalUrl}: пусто, файл не создан`,
      detail: `${shaped.summary}\nСтраница без текста — сохранять нечего.`,
    };
  }
  try {
    // Путь модели — проект-относительный, а `writeFile` проверяет от корня.
    const root = ctx.workspace.rootPath();
    const absolute = !root || saveTo.startsWith('/') ? saveTo : `${root}/${saveTo}`;
    await ctx.workspace.writeFile(absolute, text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: `Не записалось в ${saveTo}: ${reason}`,
      detail: 'Путь не пишется: проверь, что он внутри проекта и папка существует.',
    };
  }
  const lines = text.split('\n').length;
  return {
    ok: true,
    summary: `${page.title || page.finalUrl}: сохранено в ${saveTo} (${lines} строк)`,
    detail:
      `Страница ${page.finalUrl} (${page.status}, ${page.contentType}) сохранена в ${saveTo}: ` +
      `${text.length} символов, ${lines} строк.\n` +
      'В контекст текст не отдаю — он в файле. Дальше: search по нему для нужного места, ' +
      'read с startLine/endLine, чтобы прочитать с середины.',
  };
}

export async function webAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  if (action === 'search') return missingForAction(args, ['query']) ?? (await webSearch(ctx, args));
  if (action === 'fetch') return missingForAction(args, ['url']) ?? (await webFetch(ctx, args));
  return unknownAction(action, 'web: search, fetch.');
}

/** Ресурсы MCP: каталог и чтение — две половины одного похода. */
async function listMcpResources(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.mcp) return { ok: false, summary: 'MCP-серверы не подключены' };

  const only = (optionalString(args, 'server') ?? '').trim();
  let all: readonly McpResourceInfo[];
  try {
    all = await ctx.mcp.resources();
  } catch (error) {
    return {
      ok: false,
      summary: 'Каталог ресурсов недоступен',
      // Модели нужна причина, а не вид значения: иначе отказ «объект» ничего не говорит.
      detail: error instanceof Error ? error.message : describeValue(error),
    };
  }

  const items = only ? all.filter((item) => item.serverId === only) : all;
  const where = only ? `у сервера «${only}»` : 'ни у одного MCP-сервера';
  if (items.length === 0) {
    return {
      ok: true,
      summary: `${where} ресурсов нет`,
      detail:
        'Серверы объявили только инструменты. Работай ими и не ищи ресурсы повторно: каталог не' +
        ' появится от ещё одного вызова.',
    };
  }

  return {
    ok: true,
    summary: `ресурсов: ${items.length}${only ? ` (сервер ${only})` : ''}`,
    detail: formatMcpResources(items),
  };
}

/**
 * `mcp` (action read) — прочитать один ресурс по адресу из каталога.
 *
 * Подтверждения не спрашиваем: это чтение чужого документа, а не действие. Адрес
 * проверяем по каталогу — так опечатка модели превращается в понятный отказ, а не
 * в вопрос к серверу «что ты об этом думаешь».
 */
async function readMcpResource(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.mcp) return { ok: false, summary: 'MCP-серверы не подключены' };

  const uri = (optionalString(args, 'uri') ?? '').trim();
  if (!uri) {
    return {
      ok: false,
      summary: 'Не задан адрес ресурса',
      detail: 'Инструменту нужен непустой аргумент uri.',
    };
  }
  const server = (optionalString(args, 'server') ?? '').trim() || undefined;

  const result = await ctx.mcp.readResource(uri, server);
  const first = result.text.split('\n')[0] ?? '';
  return {
    ok: !result.isError,
    summary: result.isError ? `${uri}: ошибка — ${first.slice(0, 120)}` : `${uri}: прочитан`,
    detail: result.text,
  };
}

/**
 * `search: sessions` — что уже обсуждали в прошлых беседах проекта.
 *
 * Без ответа «ничего не нашлось» на этот вопрос агент начинает выдумывать, что
 * было в прошлом разговоре, или повторяет поиск другими словами. Поэтому пустой
 * результат говорит словами, что искали и где, и советует попросить человека
 * приложить беседу через `@`.
 */

/** Каталог MCP и чтение ресурса: две половины одного похода. */
export async function mcpAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  if (action === 'list') return await listMcpResources(ctx, args);
  if (action === 'read') return missingForAction(args, ['uri']) ?? (await readMcpResource(ctx, args));
  return unknownAction(action, 'mcp: list, read.');
}
