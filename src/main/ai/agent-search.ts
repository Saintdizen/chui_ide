/**
 * Поиск: карта проекта, оглавление папки, файлы по маске, поиск по содержимому
 * и проход по прошлым беседам (`history`). Все — один инструмент с действиями.
 *
 * Поиск по содержимому спрашивает ripgrep, а если его нет — идёт обходом `fs`;
 * оба пути дают один и тот же ответ. Замена по проекту осталась в
 * `agent-tools.ts`: она пишет на диск, а эти только читают.
 */

import { limitPerFile, MAX_HITS_PER_FILE } from '../../shared/search-limit';
import { formatProjectMap } from '../../shared/project-map';
import { formatSessionSearch } from '../../shared/session-search';
import { scanProject } from '../project/scan';
import { optionalBoolean, optionalInteger, optionalString, requireString } from './tool-args';
import { clipText } from './output-trim';
import { relativePath } from './agent-terminal';
import type { WorkspaceService } from '../workspace/workspace';
import type { ToolContext, ToolOutcome } from './tool-context';
import {
  MAX_SEARCH_HITS,
  DEFAULT_SEARCH_HITS,
  DEFAULT_SEARCH_HITS_WITH_CONTEXT,
  SEARCH_OVERFETCH,
  MAX_FIND_FILES,
  DEFAULT_FIND_FILES,
} from './agent-limits';
import type { SearchHit } from '../../shared/api';
import type { SessionSearchReport } from '../../shared/session-search';
import { DEFAULT_FILES_ONLY_PATHS } from './tool-rules';
import { listDir } from './agent-list';
import { codebaseSearch, searchDocs } from './agent-code';
import { unknownAction } from './agent-present';

/**
 * Карта проекта: обход дерева без чтения содержимого. Тот же скан, что у окна
 * (`project.scan`), поэтому карта в промпте и ответ инструмента не разъезжаются.
 * Считается на каждый вызов: файлы за время работы могли появиться, а свежая
 * карта стоит одного `readdir` по именам.
 */
export async function projectMap(workspace: WorkspaceService): Promise<ToolOutcome> {
  const root = workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  const scan = await scanProject(root);
  const { summary, detail } = formatProjectMap(scan);
  return { ok: true, summary, detail };
}

/**
 * Одно имя на папку и на поиск по маске.
 *
 * Две схемы (`list` и `list`) различались одним аргументом и стоили
 * 186 токенов в каждом запросе. Выбор по аргументу: есть `glob` — ищем файлы по
 * маске, нет — показываем содержимое папки.
 */
export async function listAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const glob = optionalString(args, 'glob');
  if (glob !== undefined && glob.trim() !== '') {
    return await findFiles(ctx.workspace, ctx, args);
  }
  return await listDir(ctx.workspace, args);
}

/* ── замена по проекту ──────────────────────────────────────────────────── */

/**
 * Поиск одним именем: источники различались только первой строкой описания, а
 * стоили своей схемы каждый. Действие по умолчанию — `text`: так старые вызовы и
 * привычка «искать в проекте» остаются без лишнего слова.
 */
export async function searchAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = (optionalString(args, 'action') ?? '').trim() || 'text';
  // Три булевых флага переехали в одну строку `flags`: каждый стоил каркаса схемы
  // (≈9 ток) в КАЖДОМ запросе. Разворачиваем обратно здесь, старые ключи принимаем.
  const flags = searchFlags(args);
  switch (action) {
    case 'text':
      return await search(ctx, flags);
    case 'code':
      return await codebaseSearch(ctx, flags);
    case 'docs':
      return await searchDocs(ctx, flags);
    default:
      return unknownAction(action, 'search: text, code, docs.');
  }
}

/**
 * `flags: "rc"` → `isRegex`/`caseSensitive`/`filesOnly`. Значения из флагов главнее
 * старых ключей: если модель прислала и то, и другое, — пришёл новый способ.
 */
function searchFlags(args: Record<string, unknown>): Record<string, unknown> {
  const flags = optionalString(args, 'flags');
  if (flags === undefined) return args;
  const set = new Set(flags.toLowerCase().replace(/[\s,;]/g, ''));
  const { flags: _dropped, ...rest } = args;
  return {
    ...rest,
    isRegex: set.has('r'),
    caseSensitive: set.has('c'),
    filesOnly: set.has('n'),
    // `k` — «сколько»: как `grep -c`, отдаёт число совпадений одной строкой.
    // Отдельной буквой, не `c`: `c` уже занят «учитывать регистр».
    countOnly: set.has('k'),
  };
}

/**
 * Прошлые беседы и следы прогонов: `sessions` и `trace`.
 *
 * Были действиями `search`, хотя проекта не касаются: журнал разговоров — не код.
 * Схема `search` платила за них `enum` и `uid` в КАЖДОМ запросе, а перепись
 * 403 вызовов дала на них ноль обращений. Отдельным именем они едут строкой
 * ростера: имя видно, схема не стоит ничего.
 *
 * Ветеранные вызовы `search` с этими действиями схема теперь отвергает — с
 * перечнем допустимых (`text, code, docs`), то есть одним шагом поправимыми.
 */
export async function historyAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = (optionalString(args, 'action') ?? '').trim();
  if (action === 'sessions') return await sessionSearch(ctx, args);
  if (action === 'trace') return await sessionTrace(ctx, args);
  return unknownAction(action, 'history: sessions, trace.');
}

/**
 * Пустой результат поиска.
 *
 * Голое «Ничего не найдено» читается как «такого места нет» и лечится повтором того
 * же поиска другими словами — целый шаг, заплаченный ни за что (замер по беседам:
 * у поиска медиана совпадений — 0). Поэтому в ответе назван сам запрос, ослабленные
 * условия которого хватило бы, и куда смотреть, если ошиблось место.
 */
function emptySearchDetail(
  query: string,
  opts: { isRegex: boolean; glob?: string; scope?: string },
  tried: readonly string[] = [],
): string {
  const where = [opts.glob ? `маска ${opts.glob}` : '', opts.scope ? `папка ${opts.scope}` : ''].filter(Boolean);
  const hints = ['Проверьте написание и регистр'];
  // Про regex говорим, только когда режим и правда включён: флаг приходит из
  // `flags`/`isRegex`, и без него подсказка «выключите regex» — ложь, за которую
  // агент платит шагом на перепроверку несуществующей причины.
  if (opts.isRegex) hints.push('regex включён — возможно, его и надо выключить');
  // Про сужение места — только когда место правда сужено. Иначе «маска или папка
  // могли сузить зря» читается как причина и уводит от настоящей (не то слово).
  if (where.length > 0) hints.push(`${where.join(' и ')} могли сузить зря`);
  else hints.push('место ищется по всему проекту — сверьтесь с list или project_map');
  // Что уже перебрали — в том же ответе: иначе агент пробует ровно это ещё раз.
  const triedNote = tried.length > 0 ? ` Уже проверено: ${tried.join(', ')}.` : '';
  return `Совпадений нет: «${query}»${where.length > 0 ? ` (${where.join(', ')})` : ''}. ${hints.join('; ')}.${triedNote}`;
}

/**
 * Слова составного запроса: `read_file`, `readTextFile`, `src/a.ts` → части.
 *
 * Нужны запасному поиску: имя в коде пишут не так, как в запросе (camelCase против
 * snake_case), и точная подстрока не находится, хотя место есть.
 */
function queryWords(query: string): string[] {
  const words: string[] = [];
  for (const chunk of query.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    // Граница camelCase: заглавная после строчной либо конец аббревиатуры.
    for (const part of chunk.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)) {
      if (part) words.push(part);
    }
  }
  return words;
}

/** Запасной запрос: ослабленное условие, подпись к ответу и короткая пометка для перечня проб. */
export interface SearchFallback {
  values: { query?: string; isRegex?: boolean; caseSensitive?: boolean };
  note: string;
  /** Короткое описание пробы: им перечисляется, что уже проверено. */
  label: string;
}

/**
 * Чем заменить запрос, который ничего не нашёл.
 *
 * Поиск без совпадений — самый частый его исход (перепись: медиана 0 попаданий на
 * 43 вызова). Голое «совпадений нет» агент лечит повтором того же поиска другими
 * словами — целый шаг. Дешевле один-два ослабленных запроса, сделанных здесь.
 *
 * Порядок — от самого вероятного промаха: regex, который надо было выключить;
 * регистр; составное имя, которое в коде пишут иначе. Предел — два запроса: каждый
 * стоит времени обхода, и третий уже не окупается.
 */
export function searchFallbacks(
  query: string,
  options: { isRegex: boolean; caseSensitive: boolean },
): SearchFallback[] {
  const variants: SearchFallback[] = [];
  if (options.isRegex) {
    variants.push({
      values: { isRegex: false },
      note: 'regex ничего не нашёл; та же строка как обычный текст',
      label: 'как обычный текст',
    });
  }
  if (options.caseSensitive) {
    variants.push({
      values: { caseSensitive: false },
      note: 'точного с учётом регистра нет; без учёта регистра',
      label: 'без учёта регистра',
    });
  }
  if (!options.isRegex) {
    // Самая длинная часть имени: она и informative, и реже всего шумная.
    const part = queryWords(query)
      .filter((word) => word.length >= 3 && word !== query)
      .sort((left, right) => right.length - left.length)[0];
    if (part) {
      variants.push({
        values: { query: part, caseSensitive: false },
        note: `«${query}» целиком не найдено; по части «${part}» (не точное совпадение)`,
        label: `по части «${part}»`,
      });
    }
  }
  return variants.slice(0, 2);
}

/** Всё, что нужно одному заходу поиска — и на исполнение, и на оформление ответа. */
interface SearchRequest {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  filesOnly: boolean;
  glob?: string;
  scope?: string;
  context: number;
  limit: number;
  fileLimit: number;
  /** `grep -c`: нужен счёт совпадений, а не строки — он считается по всему списку. */
  countOnly?: boolean;
  /** Подпись к ответу, если запрос ослаблен запасной попыткой. */
  note?: string;
}

/** Один заход: исполнение и оформление. `empty` — ни одного совпадения. */
async function runSearch(ctx: ToolContext, request: SearchRequest): Promise<{ outcome: ToolOutcome; empty: boolean }> {
  const { workspace } = ctx;
  const { query, isRegex, caseSensitive, filesOnly, glob, scope, context, limit, fileLimit } = request;
  const result = await workspace.search(
    {
      query,
      isRegex,
      caseSensitive,
      filesOnly,
      glob,
      path: scope,
      context,
      // Просим с запасом: потолок на файл отбирает уже потом, и без запаса один
      // шумный файл (`package-lock.json`) занял бы весь список, а до остальных
      // файлов поиск бы даже не дошёл.
      // В режиме «только файлы» просим всё, что даст поиск: обход дешев, а число
      // найденных файлов нужно, чтобы назвать остаток. Дорого было отдавать их
      // модели — это решает `fileLimit` ниже.
      // Счёт (`grep -c`) — тоже требование ко всему списку, а не к его видимой части.
      maxResults: filesOnly || request.countOnly ? MAX_FIND_FILES : limit * SEARCH_OVERFETCH,
    },
    ctx.signal,
  );
  const root = workspace.rootPath();
  // Подпись ослабленного запроса — первой строкой: без неё найденное читается
  // как точное совпадение, и агент делает вывод по чужому имени.
  const head = request.note ? `${request.note}:\n` : '';

  // Режим «только файлы»: одна строка на файл, без номера строки и текста.
  if (filesOnly) {
    const unique = [...new Set(result.hits.map((hit) => relativePath(hit.path, root)))];
    const files = unique.slice(0, fileLimit);
    const rest = unique.length - files.length;
    const tail =
      rest > 0
        ? `\n… ещё файлов: ${rest} — сузьте запрос или папку, либо limit=${Math.min(MAX_FIND_FILES, fileLimit * 2)}`
        : '';
    return {
      empty: unique.length === 0,
      outcome: {
        ok: true,
        summary: `совпадения в файлах: ${unique.length}${result.truncated || rest > 0 ? ' (список обрезан)' : ''} · просканировано: ${result.scanned}`,
        detail: files.length
          ? head + clipText(ctx, 'search', files.join('\n')).text + tail
          : emptySearchDetail(query, { isRegex, glob, scope }),
      },
    };
  }

  // Потолок на файл: десяток строк из одного места полезнее двухсот, а по числу
  // скрытых видно, что файл шумный, — и модель сузит запрос вместо вывода
  // «больше нигде нет».
  const limited = limitPerFile(result.hits, MAX_HITS_PER_FILE, limit);
  const detail = formatSearchHits(limited.hits, root, context);
  const truncated = result.truncated || limited.truncated;
  const notes = [truncated ? 'список обрезан' : '', limited.hidden > 0 ? `на файл до ${MAX_HITS_PER_FILE}` : ''].filter(
    Boolean,
  );

  // Хвост именно в `detail`: `summary` остаётся для карточки, а модель видит
  // только `detail`. Без этой строки обрезанный список читается как «больше
  // нигде нет», и агент делает вывод по половине ответа.
  const tail =
    truncated || limited.hidden > 0
      ? `\n… (список неполный: ${limited.hits.length} из ${limit}, на файл до ${MAX_HITS_PER_FILE} — ` +
        `поднимите limit или сузьте запрос)`
      : '';

  return {
    empty: limited.hits.length === 0,
    outcome: {
      ok: true,
      summary: `${limited.hits.length} совпадений${notes.length ? ` (${notes.join(', ')})` : ''} · просканировано файлов: ${result.scanned}`,
      detail: detail.length
        ? head + clipText(ctx, 'search', detail).text + tail
        : emptySearchDetail(query, { isRegex, glob, scope }),
      // Столько всего нашлось, без учёта потолка на файл: `grep -c` печатает это число.
      matches: result.hits.length,
    },
  };
}

async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const workspace = ctx.workspace;
  const query = requireString(args, 'query');
  const isRegex = optionalBoolean(args, 'isRegex') ?? false;
  const caseSensitive = optionalBoolean(args, 'caseSensitive') ?? false;
  const filesOnly = optionalBoolean(args, 'filesOnly') ?? false;
  const glob = optionalString(args, 'glob');
  const scope = optionalString(args, 'path');
  // Область проверяем через `stat` — это заодно та же граница рабочей папки,
  // что у чтения и правок: искать «где-нибудь снаружи» через search нельзя.
  if (scope) await workspace.stat(scope);
  // Контекст — как -A/-B у grep. Ограничиваем здесь, а не только в workspace:
  // инструмент должен вести себя предсказуемо и в проверках, и на глаз модели.
  const context = optionalInteger(args, 'context') ?? 0;
  // Сколько совпадений отдать. Раньше выбора не было — всегда 200, и запрос вида
  // «export function» отдавал 21 000 символов (≈6 000 токенов) даже когда модели
  // хватало десятка. С контекстом умолчание ниже: там каждое совпадение — блок
  // из пяти строк, и двести таких блоков не читает никто.
  const wantedLimit = optionalInteger(args, 'limit');
  const fallbackLimit = context > 0 ? DEFAULT_SEARCH_HITS_WITH_CONTEXT : DEFAULT_SEARCH_HITS;
  const limit = Math.min(MAX_SEARCH_HITS, Math.max(1, wantedLimit ?? fallbackLimit));
  // В режиме «только файлы» предел считает файлы, а не строки: одна строка на
  // файл, и умолчание там своё (см. DEFAULT_FILES_ONLY_PATHS).
  const fileLimit = Math.min(MAX_FIND_FILES, Math.max(1, wantedLimit ?? DEFAULT_FILES_ONLY_PATHS));
  const request: SearchRequest = {
    query,
    isRegex,
    caseSensitive,
    filesOnly,
    glob,
    scope,
    context,
    limit,
    fileLimit,
    countOnly: optionalBoolean(args, 'countOnly') ?? false,
  };

  const first = await runSearch(ctx, request);
  if (!first.empty) return first.outcome;

  // Пусто — не повод тратить шаг на «попробую иначе»: пробуем сами (см. `searchFallbacks`).
  const tried: string[] = [];
  for (const variant of searchFallbacks(query, { isRegex, caseSensitive })) {
    const retry = await runSearch(ctx, { ...request, ...variant.values, note: variant.note });
    if (!retry.empty) return retry.outcome;
    tried.push(variant.label);
  }
  // Всё пусто — в ответе называем и то, что уже перебрали: иначе агент повторяет те же пробы.
  return tried.length === 0
    ? first.outcome
    : { ...first.outcome, detail: emptySearchDetail(query, { isRegex, glob, scope }, tried) };
}

/**
 * Совпадения поиска в виде текста. Без контекста — по строке на совпадение
 * (`путь:строка:столбец: текст`), с контекстом — блоками, как `grep -C`: строка
 * совпадения помечена `:`, соседние — `-`. Номера строк настоящие, поэтому их
 * сразу можно передать в `read` с диапазоном.
 */
function formatSearchHits(hits: readonly SearchHit[], root: string | null, context: number): string {
  if (hits.length === 0) return '';
  if (context <= 0) {
    // Столбец не печатаем: в следующий вызов его не передать (у `read` и
    // `edit` границы задаются строками), а в выдаче на 200 совпадений он стоит
    // пару сотен символов на каждой — тысячи на вызов.
    // Путь — заголовком файла, как и в выдаче с контекстом. Раньше он повторялся
    // в каждой строке: замер на этом проекте (50 совпадений в 27 файлах) дал
    // 1 489 → 1 317 токенов, а выигрыш растёт там, где совпадений много в одном
    // файле, — то есть в типичном случае «поиск символа в своём модуле».
    const rows: string[] = [];
    let previous: string | null = null;
    for (const hit of hits) {
      const file = relativePath(hit.path, root);
      if (file !== previous) {
        rows.push(file);
        previous = file;
      }
      rows.push(`  ${hit.line}: ${hit.text}`);
    }
    return rows.join('\n');
  }

  // Блоки контекста у соседних совпадений перекрываются: два совпадения в двух
  // строках друг от друга печатали одни и те же строки дважды. Собираем поэтому
  // не список блоков, а объединение диапазонов по файлу — как `grep -C`.
  interface Block {
    path: string;
    /** Строка → текст и признак «это совпадение» (совпадений в блоке может быть несколько). */
    lines: Map<number, { text: string; match: boolean }>;
    to: number;
  }
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const hit of hits) {
    const before = hit.before ?? [];
    const after = hit.after ?? [];
    const from = hit.line - before.length;
    const to = hit.line + after.length;
    const rel = relativePath(hit.path, root);
    // Продолжаем блок, если файл тот же и диапазоны соприкасаются: иначе между
    // ними дыра, и её надо печатать отдельным блоком.
    if (!current || current.path !== rel || from > current.to + 1) {
      current = { path: rel, lines: new Map(), to };
      blocks.push(current);
    }
    const block = current;
    for (const [index, text] of before.entries()) block.lines.set(from + index, { text, match: false });
    // Совпадение перекрывает контекст: его текст без отступов и с пометкой `:`.
    block.lines.set(hit.line, { text: hit.text, match: true });
    for (const [index, text] of after.entries()) {
      const line = hit.line + 1 + index;
      if (!block.lines.get(line)?.match) block.lines.set(line, { text, match: false });
    }
    block.to = Math.max(block.to, to);
  }

  let lastPath: string | null = null;
  return blocks
    .map((block) => {
      const numbered = [...block.lines.entries()].sort((left, right) => left[0] - right[0]);
      // Без выравнивания по ширине: пробелы на каждой строке контекста стоят
      // дороже, чем дают, — модель читает числа, а не колонку.
      const body = numbered.map(([line, entry]) => `${line}${entry.match ? ':' : '-'} ${entry.text}`);
      // Путь — заголовком файла: в строках блока он повторялся бы на каждой и
      // съедал место, которого ради контекста и не хватало.
      const head = block.path === lastPath ? [] : [block.path];
      lastPath = block.path;
      return [...head, ...body].join('\n');
    })
    .join('\n\n');
}

/** Сколько объявлений вернуть по умолчанию и сколько файлов-сводок показать. */

/**
 * Поиск по коду, когда имя известно примерно: сперва объявления символов через
 * языковой сервер, затем текстовые совпадения, свёрнутые по файлам.
 *
 * Порядок именно такой: «где определён» — главный ответ, а «где встречается» —
 * подсказка. Языковой сервер может быть не поднят (не настроен, ещё не
 * стартовал, не тот язык) — это не ошибка инструмента: тогда ищем текстом и
 * честно сообщаем об этом (см. `formatCodeSearch`).
 */
/**
 * Скелет файла: объявления с номерами строк. Нужен, чтобы понять устройство
 * файла, не читая его целиком: дальше агент берёт нужные строки диапазоном.
 * Текст читаем сами (в main есть рабочая папка), разбор делает языковой сервер.
 */
/**
 * Файлы по glob-маске. Отдельно от `search`: тут не читается содержимое,
 * поэтому обход дешёвый и результат — список путей.
 */
export async function findFiles(
  workspace: WorkspaceService,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const glob = optionalString(args, 'glob');
  const limit = optionalInteger(args, 'limit') ?? DEFAULT_FIND_FILES;

  const files = await workspace.findFiles(glob, limit);
  return {
    ok: true,
    summary: `${glob ? `«${glob}»: ` : ''}файлов: ${files.length}${files.length >= limit ? ' (показаны первые: сузьте маску или увеличьте limit)' : ''}`,
    detail: files.length ? clipText(ctx, 'list', files.join('\n')).text : 'Ничего не найдено',
  };
}
export async function sessionSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.sessions) return { ok: false, summary: 'Прошлые беседы недоступны: хранилища нет' };

  const query = (optionalString(args, 'query') ?? '').trim();
  if (!query) {
    return {
      ok: false,
      summary: 'Не задан запрос',
      detail: 'Инструменту нужны слова для поиска — например, "отпечаток indexer" или "сборка macOS".',
    };
  }

  const limit = optionalInteger(args, 'limit');
  const report: SessionSearchReport = await ctx.sessions.search(query, limit !== undefined ? { limit } : undefined);
  return {
    ok: true,
    summary: report.hits.length > 0 ? `бесед по запросу: ${report.hits.length}` : 'в прошлых беседах не нашлось',
    detail: formatSessionSearch(report),
  };
}

/**
 * `trace` — действие search: «что было в прогоне» по прошлой беседе. Нужно,
 * когда человек спрашивает «а почему вчера это заняло пять минут»: искать этот
 * ответ в переписке бесполезно, он жил в шагах, которые в ленту не попадают.
 */
export async function sessionTrace(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.sessions?.trace) {
    return {
      ok: false,
      summary: 'След прогона недоступен',
      detail: 'Журнал прогонов не ведётся или не подключён — читать его неоткуда.',
    };
  }
  // `query` обязательным больше не считается (`history` требует только `action`),
  // но старые вызовы его присылали — и беседу берём и оттуда: лишнее требование
  // к модели дешевле, чем второй обязательный аргумент.
  const uid = (optionalString(args, 'uid') ?? optionalString(args, 'query') ?? '').trim();
  if (!uid) {
    return {
      ok: false,
      summary: 'Не указана беседа',
      detail: 'Нужен `uid`: его видно в uri беседы, который отдаёт `action: sessions`.',
    };
  }
  const text = await ctx.sessions.trace(uid);
  return { ok: true, summary: 'след прогона беседы', detail: text };
}
