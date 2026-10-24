/**
 * Скелет кода: оглавление файла, объявления по проекту, разделы документации.
 * Все три отвечают на вопрос «где это лежит», не отдавая тело файлов.
 */

import { formatOutline } from '../../shared/lsp-symbols';
import { digestHits, formatCodeSearch, rankSymbols } from '../../shared/code-search';
import type { SearchSymbol } from '../../shared/code-search';
import { formatDocsAnswer } from '../../shared/docs-index';
import { optionalInteger, requireString } from './tool-args';
import { relative, relativePath } from './agent-terminal';
import type { ToolContext, ToolOutcome } from './tool-context';
import {
  MAX_CODE_FILES,
  MAX_SEARCH_HITS,
  DEFAULT_CODE_SYMBOLS,
  DEFAULT_DOC_RESULTS,
  MAX_DOC_RESULTS,
} from './agent-limits';
import { formatReadImageReply, formatReadImageSummary } from '../../shared/read-image';

export async function fileOutline(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  if (!ctx.symbols?.outline) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: скелет файла недоступен',
    };
  }

  const content = await ctx.workspace.readFile(target);
  const language = ctx.symbols.languageFor?.(target);
  if (!language) {
    return {
      ok: false,
      summary: `${relative(target, ctx.workspace.rootPath())}: язык не распознан`,
      detail: 'Для этого расширения языкового сервера нет — устройство файла смотри через search.',
    };
  }

  const total = content.text.length === 0 ? 0 : content.text.split('\n').length;
  const symbols = await ctx.symbols.outline(target, language, content.text);
  const rel = relative(target, ctx.workspace.rootPath());
  if (symbols === null) {
    return {
      ok: false,
      summary: `${rel}: языковой сервер недоступен`,
      detail:
        'Сервер этого языка не запущен или не умеет разбирать объявления. ' +
        'Устройство файла смотри через search или read.',
    };
  }

  const { summary, detail } = formatOutline(rel, symbols, {
    totalLines: total,
  });
  return { ok: true, summary, detail };
}

export async function codebaseSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const limit = Math.min(optionalInteger(args, 'limit') ?? DEFAULT_CODE_SYMBOLS, DEFAULT_CODE_SYMBOLS);
  const root = ctx.workspace.rootPath();

  let found: readonly SearchSymbol[] = [];
  let symbolsAvailable = false;
  if (ctx.symbols) {
    try {
      found = await ctx.symbols.projectSymbols(query);
      symbolsAvailable = true;
    } catch {
      // Сервер не ответил — не повод отказывать в поиске: продолжаем текстом.
      symbolsAvailable = false;
    }
  }

  // Запрос словами («read file») текстом не найти: ищем по спрессованной форме —
  // так он совпадёт с `readFile`. Регистр `search` учитывает сам.
  const compact = query.replace(/\s+/g, '');
  const hits = await ctx.workspace.search(
    {
      query: compact,
      isRegex: false,
      caseSensitive: false,
      maxResults: MAX_SEARCH_HITS,
    },
    ctx.signal,
  );
  const files = digestHits(
    hits.hits.map((hit) => ({
      path: relativePath(hit.path, root),
      line: hit.line,
      text: hit.text,
    })),
    MAX_CODE_FILES,
  );

  const shaped = formatCodeSearch({
    query,
    // Пути — как во всех инструментах: относительно рабочей папки, иначе модель
    // видит длинный абсолютный путь и не понимает, что файл рядом.
    symbols: rankSymbols(found, query, limit).map((symbol) => ({
      ...symbol,
      path: relativePath(symbol.path, root),
    })),
    symbolTotal: found.length,
    files,
    hitTotal: hits.hits.length,
    scanned: hits.scanned,
    truncated: hits.truncated || found.length > limit,
    symbolsAvailable,
  });

  return { ok: true, summary: shaped.summary, detail: shaped.detail };
}

/**
 * Ответы по документации проекта: ищем в ней, а не в коде. Источник — README,
 * `docs/` и прочие документы; отбор и нарезка на разделы — в main (`searchDocs`),
 * потому что читать файлы можно только там. Модели отдаём путь, заголовок и строку
 * раздела: тот же путь и та же строка годятся в `read`, чтобы дочитать раздел.
 */
export async function searchDocs(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const limit = Math.min(Math.max(optionalInteger(args, 'limit') ?? DEFAULT_DOC_RESULTS, 1), MAX_DOC_RESULTS);
  const result = await ctx.workspace.searchDocs({ query, limit });
  const root = ctx.workspace.rootPath();
  const { summary, detail } = formatDocsAnswer(result, (target) => relativePath(target, root));
  return { ok: true, summary, detail };
}

/**
 * Посмотреть картинку (`read_image`). Саму картинку в текст результата не положить:
 * у OpenAI в `tool`-сообщении допустим только текст, поэтому она едет в
 * `images` — отдельным сообщением прогона (см. `service.ts`). Здесь — вызов main,
 * который читает и при необходимости уменьшает файл, и слова для модели.
 */
export async function readImage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.readImage) return { ok: false, summary: 'Картинки недоступны: нет доступа к проекту' };
  const target = requireString(args, 'path');
  const image = await ctx.readImage.load(target);
  const rel = relative(target, ctx.workspace.rootPath());
  const report = {
    mime: image.mime,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
    source: image.source,
  };
  return {
    ok: true,
    summary: `${rel}: ${formatReadImageSummary(report)}`,
    detail: formatReadImageReply(rel, report),
    images: [image.dataUrl],
  };
}
