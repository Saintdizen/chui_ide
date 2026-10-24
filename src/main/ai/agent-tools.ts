import path from 'node:path';
import type { DiagnosticItem, SearchHit } from '../../shared/api';
import type { SearchSymbol } from '../../shared/code-search';
import type { MemoryScope } from '../../shared/memory';
import type { SessionSearchReport } from '../../shared/session-search';
import type { SymbolLocation } from '../../shared/lsp-locations';
import { unknownAction } from './agent-present';
import { formatBrowserSnapshot, type BrowserSnapshot } from '../../shared/browser';
import { digestHits, formatCodeSearch, rankSymbols } from '../../shared/code-search';
import { formatDocsAnswer } from '../../shared/docs-index';
import { formatAllNotes } from '../../shared/memory';
import { formatWebResults } from '../../shared/web-search';
import { formatReadImageReply, formatReadImageSummary } from '../../shared/read-image';
import { confirmFile, coveredRequest, uncoverFiles } from '../../shared/read-coverage';
import { limitPerFile, MAX_HITS_PER_FILE } from '../../shared/search-limit';
import { formatFetchedPage } from '../../shared/web-fetch';
import { formatLintReport } from '../../shared/lint';
import { formatLocations } from '../../shared/lsp-locations';
import { formatOutline } from '../../shared/lsp-symbols';
import { formatMcpResources, isMcpToolName, type McpResourceInfo, type McpToolInfo } from '../../shared/mcp';
import { formatProjectMap } from '../../shared/project-map';
import { formatSessionSearch } from '../../shared/session-search';
import { parseSubagentTasks } from '../../shared/subagents';
import { parseToolArguments } from '../../shared/tools';
import { estimateTextTokens, isCondenseMarker } from '../../shared/context-fit';
import { fitOutput } from '../../shared/output-budget';
import { argumentsShape, describeShape, missingArguments, toolSpec, wrongArguments } from '../../shared/tool-schema';
import { canonicalCall } from '../../shared/tool-aliases';
import { describeValue } from '../../shared/tool-args';
import { scanProject } from '../project/scan';
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_TOKENS, MIN_OUTPUT_CHARS } from './output-budget';
import { clipText, spill } from './output-trim';
import { spillHint } from './spill';
import {
  missingForAction,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireString,
  stringList,
} from './tool-args';
import { relative, relativePath, terminalAction } from './agent-terminal';
import { editAction, fileAction, readEditsOutcome } from './agent-edit';
import { listDir } from './agent-list';
import { readAction } from './agent-read';
import { DEFAULT_FILES_ONLY_PATHS } from './tool-rules';
import { failureText } from './tool-rules';
import { runTests } from './tool-command';
import { showAction, unknownTool } from './agent-show';
import type { WorkspaceService } from '../workspace/workspace';
import type { LookupCall } from './agent-lookup';
import type { ToolContext, ToolOutcome } from './tool-context';

/** Типы контекста реэкспортируются: тесты и промпты берут их из таблицы инструментов. */
export type {
  MemoryTools,
  SandboxRunner,
  SymbolSearch,
  TerminalAgent,
  TestRunner,
  ToolContext,
  ToolOutcome,
} from './tool-context';

/** Больше этого одной страницы модели не отдаём: даже по просьбе. */
const MAX_FETCH_CHARS = 60_000;
const MAX_SEARCH_HITS = 200;
/**
 * Умолчания `limit`: в схеме только «сколько», а само число — здесь. Строчка
 * «(50; 35 с контекстом; 80 файлов)» читалась моделью на каждом шаге и весила
 * больше, чем весь остальной аргумент; поведение от этого не меняется — код и
 * раньше брал то же число, когда модель молчала. Числа сами — ниже, в константах.
 */
/**
 * Сколько совпадений отдаём, если модель не попросила иначе. Двести — потолок,
 * а не умолчание: замер на живом проекте (‘export function’) давал 21 000
 * символов ≈ 6 000 токенов за один вызов, и это при том, что первые десять
 * строк уже отвечают на вопрос.
 *
 * Пятьдесят стали двадцатью пятью по переписи: за 43 вызова поиска медиана
 * совпадений — 0, максимум 18, в 98 % случаев не больше десяти. Потолок в
 * двадцать пять не режет нужное, но вдвое укорачивает шумный запрос — тот
 * самый случай, ради которого умолчание и существует.
 */
const DEFAULT_SEARCH_HITS = 25;
/** С контекстом умолчание ниже: каждое совпадение — это блок из пяти строк. */
const DEFAULT_SEARCH_HITS_WITH_CONTEXT = 20;
/**
 * Сколько совпадений отдаём в `search code`, если модель не попросила иначе.
 * Объявления символов — что и где: сорока строк с запасом хватает на «в каком
 * файле это имя», и потолок тот же — это не выбор, а умолчание.
 */
const DEFAULT_CODE_SYMBOLS = 40;
/** Сколько разделов документации отдаём на один запрос `search: docs`. */
const DEFAULT_DOC_RESULTS = 8;
const MAX_DOC_RESULTS = DEFAULT_DOC_RESULTS;
/**
 * Сколько результатов поиска в сети отдаём, если модель не попросила иначе.
 * Десять ссылок — уже край: сколько дальше — решать по странице, а не по списку.
 */
const DEFAULT_WEB_RESULTS = 10;
const MAX_WEB_RESULTS = DEFAULT_WEB_RESULTS;
/**
 * Во сколько раз просим больше совпадений, чем отдадим. Потолок на файл
 * отбирает уже после поиска: без запаса шумный файл занял бы весь список, и
 * других файлов в выдаче не было бы вовсе.
 */
const SEARCH_OVERFETCH = 3;
/** Потолок для режима «только файлы»: там на файл одна строка, поэтому можно больше. */
const MAX_FIND_FILES = 2000;
/**
 * Сколько путей отдаёт `list`, если модель не попросила иначе. Двести
 * путей — это около 6 500 символов (≈1 850 токенов) на запрос «какие тут есть
 * файлы»; сотни хватает, чтобы увидеть край дерева, а остальное берётся сужением
 * маски.
 */
const DEFAULT_FIND_FILES = 100;

/**
 * Выполнить разобранную команду инструментом. Ошибка разбора или отсутствие файла
 * — это не отказ: команда уходит в шелл, как её написали.
 */
export async function lookupOutcome(ctx: ToolContext, call: LookupCall): Promise<ToolOutcome | null> {
  try {
    const outcome =
      call.tool === 'read'
        ? await readAction(ctx, call.args)
        : call.tool === 'list'
          ? await listDir(ctx.workspace, call.args)
          : await searchAction(ctx, call.args);
    // Повторная читалка того же файла: текст уже в ветке выше. Проверяем после
    // чтения, потому что только оно знает границы (`cat` их не называет), и до
    // `rememberRead` — иначе совпадёт само с собой.
    if (outcome.read && ctx.coveredReads) {
      const previous = ctx.coveredReads.get(outcome.read.path) ?? [];
      if (previous.some((range) => range.suspect || range.stamp !== undefined)) {
        confirmFile(ctx.coveredReads, outcome.read.path, outcome.read.stamp);
      }
      const covered = coveredRequest(
        'read',
        JSON.stringify({
          path: outcome.read.path,
          startLine: outcome.read.from,
          endLine: outcome.read.to,
        }),
        ctx.coveredReads,
      );
      if (covered) {
        return {
          ok: true,
          summary: `${call.label} → read · уже прочитано`,
          detail: `${covered.path}: строки ${covered.from}–${covered.to} уже есть выше в ветке — не повторяю.`,
        };
      }
    }
    // Пачка (`paths`): `coveredRequest` знает только один `path`, а повтор пачки с одним
    // новым файлом оплачивал старые целиком. `uncoverFiles` возвращает сужение, только
    // когда оно осмысленно; здесь важнее сам факт «сужать нечего» — все файлы уже были.
    if (call.tool === 'read' && ctx.coveredReads && outcome.reads && outcome.reads.length > 0) {
      const still = uncoverFiles(JSON.stringify(call.args), ctx.coveredReads);
      if (!still) {
        return {
          ok: true,
          summary: `${call.label} → read · уже прочитано`,
          detail: `Все файлы пачки (${outcome.reads.length}) уже есть выше в ветке — не повторяю.`,
        };
      }
    }
    if (call.countOnly && call.tool === 'search') {
      // `grep -c` отдаёт число совпадений и ничего больше. Считаем по тому, что
      // вернул поиск: потолок на файл (`MAX_HITS_PER_FILE`) мог срезать лишнее,
      // поэтому значение берём у `matches`, а не из текста результата.
      const found = outcome.matches ?? 0;
      return {
        ok: true,
        summary: `${call.label} → search · ${outcome.matches ?? '?'} совпадений`,
        detail: found === 0 ? '0' : `${found}`,
      };
    }
    return {
      ...outcome,
      summary: `${call.label} → ${call.tool} · ${outcome.summary}`,
    };
  } catch {
    return null;
  }
}

export async function runTool(ctx: ToolContext, name: string, rawArguments: string): Promise<ToolOutcome> {
  // Старое имя из сохранённой беседы (`read_file`, `spawn_agent`) не должно
  // упираться в тупик: инструмент есть, он просто называется иначе.
  const canonical = canonicalCall(name, rawArguments);
  name = canonical.name;
  const parsed = parseToolArguments(canonical.arguments);
  if (!parsed.ok) return { ok: false, summary: parsed.message };

  // Обязательные поля схемы — до исполнения: иначе забытый аргумент вернётся
  // глубокой ошибкой из реализации, и модель примется угадывать форму вызова.
  // У внешних (MCP) схемы нет в `AGENT_TOOLS`, их проверяет сам сервер.
  const spec = toolSpec(name);
  if (spec) {
    const missing = missingArguments(spec.inputSchema, parsed.value);
    if (missing.length > 0) {
      // Форма — в том же отказе: без неё потерянное поле ищут в неверном месте
      // (плоский `edit` вместо обёртки `edits: [{path, edits}]`). Сама схема — тоже:
      // инструменты из ростера (п.45) едут одной строкой, и их формы у модели нет
      // вовсе — пересказывать её прозой значит потерять имена полей и типы.
      return {
        ok: false,
        summary: `Не хватает аргумента: ${missing.join(', ')}. Форма: ${describeShape(spec.inputSchema)}`,
        detail: `Аргументы ${name}: ${argumentsShape(spec.inputSchema)}`,
      };
    }
    // Значение мимо `enum` — тот же класс ошибки, что забытое поле: `switch` ниже
    // ответит «действие неизвестно» и не назовёт варианты, а модель потратит шаг.
    // Схема `file` больше не объявляет `create`/`replace` (дубли `edit` и `search`+`edit`),
    // но старые беседы зовут их по имени — реализация жива, поэтому мимо `enum`
    // пропускаем ровно эти два действия.
    const wrong = wrongArguments(spec.inputSchema, parsed.value).filter(
      (issue) =>
        !(name === 'file' && issue.path === 'action' && (issue.value === 'create' || issue.value === 'replace')),
    );
    if (wrong.length > 0) {
      // Как и у нехватки поля: сначала значение, которое пришло от модели (иначе
      // отказ не объясняет, что не так), потом перечень — он же в `detail`.
      const values = wrong.map((issue) => `${issue.path} «${issue.value}»`).join(', ');
      const allowed = wrong.map((issue) => issue.allowed.join(', ')).join('; ');
      return {
        ok: false,
        summary: `Неизвестное значение аргумента: ${values}`,
        detail: `Допустимые значения: ${allowed}.\nАргументы ${name}: ${argumentsShape(spec.inputSchema)}`,
      };
    }
  }

  // Тело правки или команда, пришедшая пометкой сжатия, — не текст модели, а
  // остаток истории: файл получил бы эту строку, а инструмент отчитался бы
  // «создан». Отказ с объяснением дешевле молчаливой порчи и лечится повтором.
  const stale = staleCondensedBody(parsed.value);
  if (stale) {
    return {
      ok: false,
      summary:
        `Аргумент «${stale}» пришёл пометкой сжатия вместо текста — в файл она не пойдёт. ` +
        'Повтори вызов с настоящим содержимым.',
    };
  }

  const before = ctx.stepBudget
    ? {
        left: ctx.stepBudget.left,
        tokensLeft: ctx.stepBudget.tokensLeft ?? Math.ceil(ctx.stepBudget.left / 3.5),
      }
    : undefined;
  if (ctx.stepBudget) ctx.stepBudget.exhausted = false;
  return clipOutcome(ctx, name, await dispatchTool(ctx, name, parsed.value), before);
}

/**
 * Поля, в которых пометка сжатия означает испорченный вызов, а не текст.
 *
 * Ровно те поля, которые сжимает `CONDENSE_FIELDS`: тела правок (`oldText`,
 * `newText`, `contents`, `content`, `code`). `command`, `script` и
 * `replacement` убраны вместе со сжатием команд: такие аргументы в историю
 * больше не превращаются в пометку, а проверка на мёртвом поле только
 * вводила бы в заблуждение — будто повтор `terminal` ломается.
 */
const BODY_FIELDS = ['contents', 'content', 'newText', 'oldText', 'code'] as const;

/**
 * В образце стоит только пометка: её написала сама модель, а не сжатие.
 *
 * Так пишут «дописать абзац»: образец — конец файла, остальное — в новой
 * версии. Настоящее сжатие ставит пометки в ОБА поля пары, и только тогда
 * пометка в образце значит «этот текст уже на диске».
 */
function handWrittenMarker(args: Record<string, unknown>, where: string): boolean {
  if (!/oldText$/i.test(where)) return false;
  // Сосед по паре: только он говорит, сам ли модель нарисовала пометку.
  const peer = readPath(args, where.replace(/oldText$/i, 'newText'));
  if (peer === undefined) return true;
  return `${peer}`.trim() !== '';
}

/** Пройти по пути вида `edits[0].edits[1].newText`. */
function readPath(root: unknown, path: string): unknown {
  let node = root;
  for (const raw of path.split('.')) {
    const match = /^([^[\]]*)(?:\[(\d+)\])?$/.exec(raw);
    if (!match) return undefined;
    if (match[1]) {
      if (typeof node !== 'object' || node === null) return undefined;
      node = (node as Record<string, unknown>)[match[1]];
    }
    if (match[2] !== undefined) {
      if (!Array.isArray(node)) return undefined;
      node = node[Number(match[2])];
    }
  }
  return node;
}

/** Имя поля, где вместо содержимого стоит пометка сжатия, или `null`. */
function staleCondensedBody(args: Record<string, unknown>): string | null {
  // Тела правок лежат вложенно: `edit` присылает `edits[].edits[].newText`,
  // `file` (action create) — плоский `contents`. Обход общий, глубина ограничена: схемы
  // инструментов не глубже четырёх уровней, а бесконечный обход тут не нужен.
  const walk = (value: unknown, path: string, depth: number): string | null => {
    if (depth > 4) return null;
    // Внутрь пометки не заглядываем: она сама — текст, а не дерево аргументов.
    if (typeof value === 'string') return null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const found = walk(value[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const where = path ? `${path}.${key}` : key;
      if ((BODY_FIELDS as readonly string[]).includes(key) && isCondenseMarker(inner)) {
        if (!handWrittenMarker(args, where)) return where;
      }
      const found = walk(inner, where, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(args, '', 0);
}

/**
 * Потолок вывода, общий для всех инструментов: одно место вместо надежды на
 * каждый.
 *
 * Бюджет шага (`stepBudget`) и предел на вызов соблюдали только чтение файлов и
 * вывод команд — остальные инструменты отдавали как есть. Замер на живом
 * проекте: `search` с контекстом возвращал 45 000 символов (≈14 600 токенов за
 * один вызов), `search` (docs), `checks` не
 * режутся вовсе. Пропустить потолок теперь не может ни один инструмент — в том
 * числе новый, который забыли об этом попросить.
 */
function clipOutcome(
  ctx: ToolContext,
  name: string,
  outcome: ToolOutcome,
  before?: { left: number; tokensLeft: number },
): ToolOutcome {
  const exhausted = ctx.stepBudget?.exhausted === true || before?.left === 0 || before?.tokensLeft === 0;
  const source = outcome.ok ? (outcome.detail ?? outcome.summary) : failureText(outcome);
  const original =
    exhausted && !source.includes('бюджет вывода на шаг исчерпан')
      ? `${source}\n… (бюджет вывода на шаг исчерпан)`
      : source;
  const limit = {
    chars: Math.min(MAX_OUTPUT_CHARS, Math.max(MIN_OUTPUT_CHARS, before?.left ?? MAX_OUTPUT_CHARS)),
    tokens: Math.min(
      MAX_OUTPUT_TOKENS,
      Math.max(Math.ceil(MIN_OUTPUT_CHARS / 3.5), before?.tokensLeft ?? MAX_OUTPUT_TOKENS),
    ),
  };
  let detail = original;
  if (fitOutput(original, limit) !== original) {
    const file = spill(ctx, name, original);
    const note = `\n… (вывод обрезан${exhausted ? ' — бюджет вывода на шаг исчерпан' : ''}${file ? `; ${spillHint(file)}` : ''})`;
    const head = name === 'terminal' ? `${original.split('\n').slice(0, 2).join('\n').slice(0, 400)}\n` : '';
    const room = {
      chars: limit.chars - note.length - head.length,
      tokens: limit.tokens - estimateTextTokens(note + head),
    };
    const fitted = fitOutput(original, room, name === 'terminal');
    // Код и списки не обрываем посреди строки, если есть хотя бы одна полная.
    const newline = name === 'terminal' ? fitted.indexOf('\n') : fitted.lastIndexOf('\n');
    const body = newline < 0 ? fitted : name === 'terminal' ? fitted.slice(newline + 1) : fitted.slice(0, newline);
    detail = head + body + note;
  }
  if (ctx.stepBudget && before) {
    // Единожды учитываем весь результат, включая заголовки и ссылку на копию.
    ctx.stepBudget.left = exhausted ? 0 : Math.max(0, before.left - detail.length);
    ctx.stepBudget.tokensLeft = exhausted ? 0 : Math.max(0, before.tokensLeft - estimateTextTokens(detail));
  }
  if (detail === source) return outcome;
  // При отказе service вызовет failureText ещё раз: не дублируем заголовок ошибки.
  const result: ToolOutcome = outcome.ok
    ? { ...outcome, detail }
    : {
        ...outcome,
        summary: detail.startsWith('Ошибка: ') ? detail.slice('Ошибка: '.length) : detail,
        detail: undefined,
      };
  if (detail === original) return result;
  // Финальная страховка могла убрать куски пачки: скрытый текст не считается прочитанным.
  const { read: _read, reads: _reads, ...rest } = result;
  return rest;
}

/** Аргументы уже разобраны: дальше — только исполнение и потолок вывода. */
async function dispatchTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    // Внешние инструменты (MCP) идут мимо оператора `switch`: их имена приходят
    // из настроек и заранее неизвестны.
    if (isMcpToolName(name)) return await runExternalTool(ctx, name, args);

    switch (name) {
      // Одно имя на папку и на поиск по маске: обе формы угадываются по аргументу
      // (`glob` — маска, без него — содержимое папки), а две схемы стоили 186 токенов.
      case 'list':
        return await listAction(ctx, args);
      // Одно имя на один файл и на пять: различие — только `path` против `paths`.
      case 'read':
        return await readAction(ctx, args);
      case 'search':
        return await searchAction(ctx, args);
      case 'history':
        return await historyAction(ctx, args);
      case 'read_image':
        return await readImage(ctx, args);
      case 'lsp':
        return await lspAction(ctx, args);
      case 'checks':
        return await checksAction(ctx, args);
      case 'run_tests':
        return await runTests(ctx, args);
      case 'project_map':
        return await projectMap(ctx.workspace);

      case 'edit':
        return await editAction(ctx, args);
      case 'web':
        return await webAction(ctx, args);
      case 'file':
        return await fileAction(ctx, args);
      case 'task':
        return await task(ctx, args);
      case 'mcp':
        return await mcpAction(ctx, args);
      // Семейства ниже — одним инструментом с `action`: семь схем браузера и
      // пять терминала стоили модели дороже, чем их различие по смыслу.
      case 'browser':
        return await browserAction(ctx, args);
      case 'mind':
        return await mindAction(ctx, args);
      case 'show':
        return await showAction(ctx, args);
      case 'terminal':
        return await terminalAction(ctx, args);
      default:
        return unknownTool(name);
    }
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }
}

/* ── подзадача (sub-agent) ────────────────────────────────────────────── */

/* ── вопрос человеку ────────────────────────────────────────── */

/** Больше пяти вариантов — это уже список, а не выбор: кнопки теряют смысл. */
const MAX_ASK_OPTIONS = 5;
/** Вопрос длиннее — уже не вопрос, а простыня: читать её некогда. */
const MAX_QUESTION_CHARS = 2000;

/**
 * `ask` — остановить прогон и спросить человека. Агент сам вопрос не придумывает и
 * ничего не решает за него: без ответа он честно останавливается. Ответ уходит модели
 * результатом вызова, и прогон продолжается тем же ходом (в отличие от подтверждений,
 * где от ответа зависит лишь одно действие). Моста нет — инструмент не предлагается.
 */
async function ask(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.ask) return { ok: false, summary: 'Вопрос недоступен: окно чата не подключено' };

  const question = (optionalString(args, 'question') ?? '').trim();
  if (!question) {
    return {
      ok: false,
      summary: 'Не задан вопрос',
      detail: 'Инструменту нужен непустой аргумент question.',
    };
  }

  const options = stringList(args.options).slice(0, MAX_ASK_OPTIONS);
  const answer = (
    await ctx.ask(question.slice(0, MAX_QUESTION_CHARS), options.length > 0 ? options : undefined)
  ).trim();

  if (!answer) {
    return {
      ok: false,
      summary: 'Ответа нет',
      detail:
        'Человек не ответил: вопрос отклонили или прервали прогон. Не повторяй этот же вопрос — ' +
        'продолжай доступными средствами или заверши с тем, что уже есть.',
    };
  }
  return { ok: true, summary: answer, detail: answer };
}

/**
 * Делегировать подзадачу отдельному агенту со своим контекстом. Цикл подзадачи
 * живёт в `service.ts` (там провайдер и модель), поэтому здесь — только разбор
 * аргументов и перевод её отчёта в обычный результат инструмента. Подзадача
 * видит проект теми же инструментами чтения, а её чтения в беседу не попадают:
 * до основного агента доезжает только отчёт.
 */
async function task(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.subagent) return { ok: false, summary: 'Подзадачи недоступны' };

  const request = parseSubagentTasks(args);
  if (request.error) return { ok: false, summary: 'Не заданы подзадачи', detail: request.error };

  // Одна подзадача идёт прежним путём: лишний слой пула не нужен, а ответ
  // остаётся ровно тем же, что и раньше, — отчётом одного агента.
  if (request.tasks.length === 1) {
    const only = request.tasks[0]!;
    return ctx.subagent.run({
      description: only.description,
      prompt: only.prompt,
    });
  }
  return ctx.subagent.runMany(request.tasks);
}

/* ── браузер ────────────────────────────────────────────────────────────── */

/**
 * Действие в браузере меняет чужую страницу (переход, нажатие, ввод, скрипт):
 * обычный режим спрашивает разрешение, полный доступ — нет. Чтение снимка
 * подтверждения не требует: это осмотр, а не действие.
 *
 * Сравнение с командами терминала тут не в пользу осторожности: браузер мы
 * запускаем сами, с одноразовым профилем в temp, и он не видит ни файлов
 * проекта, ни сессий человека. А вот страница может сделать что угодно от его
 * имени — поэтому вопрос всё равно нужен, но только в обычном режиме.
 */
async function permitBrowser(ctx: ToolContext, action: string): Promise<ToolOutcome | null> {
  if (!ctx.confirmBrowser)
    return {
      ok: false,
      summary: 'Браузер недоступен: окно редактора не подключено',
    };
  if (ctx.allowAll) return null;
  const allowed = await ctx.confirmBrowser(action);
  if (allowed) return null;
  return {
    ok: false,
    summary: 'Пользователь отклонил действие в браузере',
    detail: 'Пользователь не разрешил это действие. Не повторяй его — предложи другой ход.',
  };
}

/** Снимок страницы в ответ инструмента: текст собирает `shared/browser.ts`. */
function snapshotOutcome(snapshot: BrowserSnapshot, summary: string): ToolOutcome {
  return { ok: true, summary, detail: formatBrowserSnapshot(snapshot) };
}

/** «Страница: Заголовок» — короткая сводка для карточки вызова. */
function pageSummary(snapshot: BrowserSnapshot): string {
  const title = snapshot.title.trim() || snapshot.url;
  return `${title} · элементов: ${snapshot.elements.length}`;
}

/**
 * Действия браузера одним инструментом.
 *
 * Семь отдельных имён стоили семи схем в каждом запросе, а различались только
 * первой строкой описания. Разбор аргументов остался в прежних функциях —
 * здесь только выбор по `action` и отказ на незнакомое действие.
 */
async function browserAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'snapshot':
      return await browserSnapshot(ctx);
    case 'close':
      return await browserClose(ctx);
    case 'zoom':
      return missingForAction(args, ['mode']) ?? (await browserZoom(ctx, args));
    case 'open':
      return missingForAction(args, ['url']) ?? (await browserOpen(ctx, args));
    case 'click':
      return missingForAction(args, ['ref']) ?? (await browserClick(ctx, args));
    case 'type':
      return missingForAction(args, ['ref', 'text']) ?? (await browserType(ctx, args));
    case 'evaluate':
      return missingForAction(args, ['expression']) ?? (await browserEvaluate(ctx, args));
    default:
      return {
        ok: false,
        summary: `Неизвестное действие браузера: ${action}`,
        detail: 'Допустимые: open, snapshot, click, type, evaluate, zoom, close.',
      };
  }
}

async function browserOpen(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const url = requireString(args, 'url').trim();
  const denied = await permitBrowser(ctx, `открыть ${url}`);
  if (denied) return denied;

  const snapshot = await ctx.browser.open(url);
  return snapshotOutcome(snapshot, pageSummary(snapshot));
}

async function browserSnapshot(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const snapshot = await ctx.browser.snapshot();
  return snapshotOutcome(snapshot, pageSummary(snapshot));
}

async function browserClick(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const ref = requireString(args, 'ref').trim();
  const denied = await permitBrowser(ctx, `нажать элемент ${ref} на странице`);
  if (denied) return denied;

  const snapshot = await ctx.browser.click(ref);
  return snapshotOutcome(snapshot, `нажат ${ref} · ${pageSummary(snapshot)}`);
}

async function browserType(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const ref = requireString(args, 'ref').trim();
  const text = requireString(args, 'text');
  const submit = optionalBoolean(args, 'submit') ?? false;
  const denied = await permitBrowser(ctx, `ввести текст в поле ${ref}${submit ? ' и отправить форму' : ''}`);
  if (denied) return denied;

  const snapshot = await ctx.browser.type(ref, text, submit);
  return snapshotOutcome(snapshot, `введено в ${ref}${submit ? ' и отправлено' : ''} · ${pageSummary(snapshot)}`);
}

async function browserEvaluate(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  const expression = requireString(args, 'expression');
  const denied = await permitBrowser(ctx, `выполнить на странице: ${expression.slice(0, 120)}`);
  if (denied) return denied;

  const result = await ctx.browser.evaluate(expression);
  return { ok: true, summary: 'выражение выполнено', detail: result };
}

/**
 * Масштаб страницы. Подтверждения не спрашивает: страница не меняется, а масштаб
 * обратим одной кнопкой — и всё равно виден человеку в шапке.
 */
async function browserZoom(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  if (!ctx.browser.zoom) {
    return {
      ok: false,
      summary: 'масштаб доступен только во встроенном браузере',
      detail: 'Сейчас агент работает в отдельном Chromium. Встроенный браузер включается в настройках AI.',
    };
  }
  const mode = requireString(args, 'mode').trim();
  if (mode !== 'in' && mode !== 'out' && mode !== 'fit' && mode !== 'actual') {
    return { ok: false, summary: 'mode должен быть in, out, fit или actual' };
  }

  const result = await ctx.browser.zoom(mode);
  if (!result.ok)
    return {
      ok: false,
      summary: result.reason ?? 'не удалось изменить масштаб',
    };
  const percent = Math.round((result.zoom ?? 1) * 100);
  return {
    ok: true,
    summary: `масштаб ${percent}%`,
    detail: `Страница показана с масштабом ${percent}%.`,
  };
}

async function browserClose(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  // Сессии нет — закрывать нечего: «браузер закрыт» здесь звучало бы как отчёт
  // о сделанном, хотя браузера ещё не было.
  if (ctx.browser.running === false) {
    return {
      ok: true,
      summary: 'браузер не запущен',
      detail: 'Сессии браузера нет — закрывать нечего.',
    };
  }
  await ctx.browser.close();
  return {
    ok: true,
    summary: 'браузер закрыт',
    detail: 'Процесс браузера остановлен, временный профиль удалён.',
  };
}

/**
 * Карта проекта: обход дерева без чтения содержимого. Тот же скан, что у окна
 * (`project.scan`), поэтому карта в промпте и ответ инструмента не разъезжаются.
 * Считается на каждый вызов: файлы за время работы могли появиться, а свежая
 * карта стоит одного `readdir` по именам.
 */
async function projectMap(workspace: WorkspaceService): Promise<ToolOutcome> {
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
async function listAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
async function searchAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
async function historyAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
  if (opts.isRegex) hints.push('regex включён — возможно, его и надо выключить');
  if (where.length > 0) hints.push('маска или папка могли сузить зря');
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
const MAX_CODE_FILES = 25;

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
async function fileOutline(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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

async function codebaseSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
async function searchDocs(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
async function readImage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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

/* ── ссылки и переход к определению (языковой сервер) ───────────────────── */

/** Сколько объявлений учитываем при выборе цели: важно ближайшее по имени, а не все. */
const MAX_SYMBOL_CANDIDATES = 20;

/** Путь аргумента, приведённый к абсолютному внутри рабочей папки; null — аргумента нет. */
function resolvePathArg(ctx: ToolContext, value: string | undefined): string | null {
  if (!value) return null;
  const root = ctx.workspace.rootPath();
  if (!root) return null;
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return absolute;
}

/** Один и тот же файл: пути могут отличаться разделителем или регистром диска. */
function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * Ближайшее объявление символа по имени. Сервер отдаёт список совпадений, а нам
 * нужна одна цель — та, чьи ссылки смотреть или от которой перейти к определению;
 * `rankSymbols` ставит точные совпадения и короткие имена вперёд.
 */
async function resolveSymbol(ctx: ToolContext, name: string, pathFilter: string | null): Promise<SearchSymbol | null> {
  if (!ctx.symbols) return null;
  const found = await ctx.symbols.projectSymbols(name).catch(() => [] as readonly SearchSymbol[]);
  const ranked = rankSymbols(found, name, MAX_SYMBOL_CANDIDATES);
  if (pathFilter) {
    // Сравниваем приведённые пути, а не строки: языковой сервер может написать
    // тот же файл другим разделителем или регистром диска.
    const inFile = ranked.find((symbol) => samePath(symbol.path, pathFilter));
    if (inFile) return inFile;
  }
  return ranked[0] ?? null;
}

/** Текст и язык файла — их требует запрос к серверу по позиции. */
async function documentOf(
  ctx: ToolContext,
  target: string,
): Promise<{ text: string; language: string } | { error: ToolOutcome }> {
  const language = ctx.symbols?.languageFor?.(target);
  if (!language) {
    return {
      error: {
        ok: false,
        summary: `${relative(target, ctx.workspace.rootPath())}: язык не распознан`,
        detail: 'Для этого расширения языкового сервера нет — ссылки и переход недоступны.',
      },
    };
  }
  const content = await ctx.workspace.readFile(target);
  return { text: content.text, language };
}

/**
 * Ссылки на символ: где он ещё встречается. Сперва находим объявление по имени
 * (`workspace/symbol`), затем просим сервер о ссылках в этой позиции. Позиция
 * объявления известна точно, а курсора у агента нет — поэтому и по имени, а не
 * по позиции.
 */
async function findReferences(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.symbols?.references) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: поиск ссылок недоступен',
    };
  }

  const name = requireString(args, 'symbol').trim();
  const root = ctx.workspace.rootPath();
  const target = await resolveSymbol(ctx, name, resolvePathArg(ctx, optionalString(args, 'path')));
  if (!target) {
    return {
      ok: true,
      summary: `объявление «${name}» не найдено`,
      detail:
        'Языковой сервер не нашёл объявления с таким именем. Уточни имя (или напиши его словами, ' +
        'например «read file») либо посмотри search с action code.',
    };
  }

  const doc = await documentOf(ctx, target.path);
  if ('error' in doc) return doc.error;

  const includeDeclaration = optionalBoolean(args, 'includeDeclaration') ?? true;
  const locations = await ctx.symbols.references(
    target.path,
    doc.language,
    doc.text,
    target.line,
    target.column,
    includeDeclaration,
  );
  if (locations === null) {
    return {
      ok: false,
      summary: `${target.name}: сервер этого языка не ищет ссылки`,
      detail:
        'Языковой сервер не умеет `textDocument/references`. Ищи вхождения через search — но ' +
        'текстовый поиск ловит и комментарии с одноимёнными переменными.',
    };
  }

  const subject = `ссылки на ${target.name} (объявлен в ${relative(target.path, root)})`;
  const report = formatLocations(subject, locations, (target) => relativePath(target, root));
  return { ok: true, summary: report.summary, detail: report.detail };
}

/**
 * Переход к определению: по имени (где символ объявлен) или из позиции
 * использования (переход делает сервер). Имя — обычный случай: у агента нет
 * курсора, а позицию он берёт из тех же ссылок.
 */
async function goToDefinition(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Аргументы проверяем ДО сервера: пустой вызов без них — это ошибка вызова, а не
  // «языковой сервер не подключён». Раньше ответ говорил про сервер, и модель шла
  // чинить не то.
  const hasName = (optionalString(args, 'symbol') ?? '').trim().length > 0;
  const hasPosition = args.path !== undefined && args.line !== undefined;
  if (!hasName && !hasPosition) {
    return {
      ok: false,
      summary: 'Нужен symbol или path вместе с line',
      detail: 'Передай имя символа (`symbol`) либо файл и строку с использованием (`path` и `line`).',
    };
  }
  if (!ctx.symbols) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: переход к определению недоступен',
    };
  }

  const root = ctx.workspace.rootPath();
  const pathArg = resolvePathArg(ctx, optionalString(args, 'path'));
  const line = optionalInteger(args, 'line');

  // Позиционный переход: файл и строка с использованием известны — решает сервер.
  if (pathArg && line) {
    if (!ctx.symbols.definition) {
      return {
        ok: false,
        summary: 'Языковой сервер не подключён: переход по позиции недоступен',
      };
    }
    const doc = await documentOf(ctx, pathArg);
    if ('error' in doc) return doc.error;

    const column = optionalInteger(args, 'column') ?? 1;
    const locations = await ctx.symbols.definition(pathArg, doc.language, doc.text, line, column);
    if (locations === null) {
      return {
        ok: false,
        summary: 'Сервер этого языка не умеет переход к определению',
        detail: 'Попробуй назвать символ аргументом `symbol` — тогда объявление ищется по имени.',
      };
    }
    const subject = `определение из ${relative(pathArg, root)}:${line}`;
    const report = formatLocations(subject, locations, (target) => relativePath(target, root));
    return { ok: true, summary: report.summary, detail: report.detail };
  }

  // Переход по имени: сервер отдаёт объявления символа прямо по имени.
  const name = optionalString(args, 'symbol');
  if (!name) {
    return {
      ok: false,
      summary: 'Нужен symbol или path вместе с line',
      detail: 'Передай имя символа (`symbol`) либо файл и строку с использованием (`path` и `line`).',
    };
  }

  const found = await ctx.symbols.projectSymbols(name).catch(() => [] as readonly SearchSymbol[]);
  const locations: SymbolLocation[] = rankSymbols(found, name, MAX_SYMBOL_CANDIDATES).map((symbol) => ({
    path: symbol.path,
    line: symbol.line,
    column: symbol.column,
  }));
  const report = formatLocations(`определение ${name}`, locations, (target) => relativePath(target, root));
  return { ok: true, summary: report.summary, detail: report.detail };
}

/**
 * Переименование символа с учётом семантики: сервер находит объявление по имени,
 * возвращает правки во всех местах использования (включая другие файлы) — их
 * применяет документная модель renderer, тем же путём, что правка по позициям, поэтому
 * работает undo и ревью. Это не `replace_in_files`: та бьёт по подстроке и не
 * знает границ символа, а здесь имя меняется только там, где оно — этот символ.
 */
async function renameSymbol(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.symbols?.rename) {
    return {
      ok: false,
      summary: 'Языковой сервер не подключён: переименование символа недоступно',
    };
  }
  if (!ctx.applyEdits) {
    return {
      ok: false,
      summary: 'Правки сейчас недоступны: окно редактора не подключено',
    };
  }

  const name = requireString(args, 'symbol').trim();
  const newName = requireString(args, 'newName').trim();
  if (name === newName) {
    return { ok: false, summary: 'Новое имя совпадает со старым' };
  }

  const root = ctx.workspace.rootPath();
  const target = await resolveSymbol(ctx, name, resolvePathArg(ctx, optionalString(args, 'path')));
  if (!target) {
    return {
      ok: true,
      summary: `объявление «${name}» не найдено`,
      detail:
        'Языковой сервер не нашёл объявления с таким именем. Уточни имя либо посмотри search (action code). ' +
        'Для массовой замены подстроки есть `file` (action replace), но он не знает семантики.',
    };
  }

  const doc = await documentOf(ctx, target.path);
  if ('error' in doc) return doc.error;

  const edits = await ctx.symbols.rename(target.path, doc.language, doc.text, target.line, target.column, newName);
  if (edits === null) {
    return {
      ok: false,
      summary: `${target.name}: сервер этого языка не умеет переименование`,
      detail:
        'Языковой сервер не поддерживает `textDocument/rename`. Для замены подстроки используй `file` (action replace).',
    };
  }
  if (edits.length === 0) {
    return {
      ok: true,
      summary: `переименовывать нечего: ${target.name}`,
      detail: 'Сервер не вернул правок.',
    };
  }

  const files = edits.map((file) => ({
    ...file,
    path: path.resolve(file.path),
  }));
  const decision = await ctx.applyEdits(files, ctx.autoApprove === true);
  if (decision.rejected) {
    return {
      ok: false,
      summary: `Пользователь отклонил переименование: ${name} → ${newName}`,
      detail: 'Пользователь отклонил правки. Не повторяй вызов — предложи другой ход.',
    };
  }

  const outcome = readEditsOutcome(decision, (file) => relative(file, root));

  return {
    ok: outcome.ok,
    summary: `${name} → ${newName}: файлов ${outcome.applied.length}${outcome.failed.length ? `, с ошибками ${outcome.failed.length}` : ''}${outcome.tail}`,
    detail: outcome.detail,
    // Переименование — тоже правка: если она легла только в буфер, тела правок
    // не забываем; чтение с диска вернёт старое имя, и правку придётся повторить.
    ...(outcome.ok && outcome.tail === '' ? { applied: true } : {}),
  };
}

/**
 * Проверка кода линтером проекта. Путь необязателен: без него проверяем проект
 * целиком. Названную цель прогоняем через `workspace.stat` — это заодно проверка,
 * что путь внутри рабочей папки (та же граница, что у чтения и правок).
 */
async function runLinter(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.linter) return { ok: false, summary: 'Линтер недоступен' };
  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  const requested = optionalString(args, 'path');
  if (requested) await ctx.workspace.stat(requested);
  const outcome = await ctx.linter.lint(requested);
  if (!outcome.tool) {
    return {
      ok: false,
      summary: 'Линтер не найден',
      detail:
        'В окружении проекта нет подходящего линтера: у Python это ruff, у Node — eslint или biome. ' +
        'Поставь его или проверь код вручную. Не читай файлы заново ради той же проверки.',
    };
  }

  const target = requested ? relativePath(requested, root) : '.';
  const report = formatLintReport({
    tool: outcome.tool,
    target,
    problems: outcome.problems,
  });
  return { ok: true, summary: report.summary, detail: report.detail };
}

/**
 * Файлы по glob-маске. Отдельно от `search`: тут не читается содержимое,
 * поэтому обход дешёвый и результат — список путей.
 */
async function findFiles(
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

/* ── диагностика ────────────────────────────────────────────────────────── */

const MAX_DIAGNOSTICS = 60;

/** Пометки языка собирает renderer: они живут в редакторе, а не на диске. */
async function diagnostics(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.diagnostics) {
    return {
      ok: false,
      summary: 'Диагностика недоступна: окно редактора не подключено',
    };
  }

  const target = optionalString(args, 'path');
  const result = await ctx.diagnostics(target);
  const items = result.items.slice(0, MAX_DIAGNOSTICS);

  if (result.items.length === 0) {
    return {
      ok: true,
      summary: target ? `Ошибок нет: ${path.basename(target)}` : 'Ошибок нет',
      detail: 'Пометок языка нет. Если ждал ошибку — проверь, что файл открыт в редакторе.',
    };
  }

  const root = ctx.workspace.rootPath();
  const lines = items.map((item) => `${formatDiagnostic(item, root)}`);
  if (result.items.length > items.length) lines.push(`… ещё пометок: ${result.items.length - items.length}`);

  const errors = result.items.filter((item) => item.severity === 'error').length;
  const warnings = result.items.length - errors;

  return {
    ok: true,
    summary: `ошибок: ${errors}, предупреждений: ${warnings}`,
    detail: lines.join('\n'),
  };
}

function formatDiagnostic(item: DiagnosticItem, root: string | null): string {
  const where = relativePath(item.path, root);
  return `${where}:${item.line}:${item.column} [${item.severity}] ${item.message}${item.source ? ` (${item.source})` : ''}`;
}

/* ── правки документов ──────────────────────────────────────────────────── */

/**
 * Разбор командного поиска: `cat`, `head -n N`, `sed -n 'A,Bp'`, `grep` и их
 * конвейеры. Понять, что это чтение, и отдать структурному инструменту дешевле
 * для всех сторон: появляются номера строк и потолок вывода, отпадает
 * подтверждение, и `cd <папка> &&` больше не нужен.
 *
 * Разбор нарочно узкий: одна простая команда без перенаправлений, подстановок и
 * незнакомых флагов. Всё, что не узнано, возвращается как `null` — такое уходит
 * в шелл, как его и написали. Ошибиться здесь дороже, чем не сэкономить.
 */

/**
 * Вызов внешнего инструмента (MCP).
 *
 * Две проверки перед исполнением. Первая: инструмент всё ещё существует — сервер
 * мог не подняться или его выключили в настройках, а модель работает со списком,
 * собранным в начале прогона. Вторая: если сервер не пометил инструмент как
 * «только чтение», спрашиваем человека — внешний инструмент может изменить что
 * угодно, и подтверждение здесь то же, что для команд терминала.
 */
async function runExternalTool(
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

/* ── создание, удаление и перемещение ───────────────────────────────────── */

/* ── память проекта ─────────────────────────────────────────────────────── */

/** Область памяти из аргументов: по умолчанию — память проекта. */
function readScope(args: Record<string, unknown>): MemoryScope {
  return args.scope === 'global' ? 'global' : 'workspace';
}

/**
 * Записать заметку в память. Память переживает беседу и её сжатие — сюда уходит
 * то, о чём договорились насовсем: предпочтения, решения, «как запускать». Личные
 * предпочтения (язык ответов и прочее), годные в любом проекте, идут в глобальную
 * область (`scope: "global"`). Не дублируем точные повторы и честно отказываем,
 * когда заметок стало слишком много: терять новую из-за переполнения молча нельзя.
 */
async function remember(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.memory) return { ok: false, summary: 'Память недоступна' };

  const text = requireString(args, 'text');
  const scope = readScope(args);
  const result = await ctx.memory.remember(text, scope);

  if (!result.ok) {
    if (result.reason === 'full') {
      return {
        ok: false,
        summary: 'Память заполнена',
        detail:
          'Заметок стало слишком много. Посмотри их все (`mind` action: "notes"), убери устаревшие через `mind` ' +
          '(action: "forget"), а затем запиши нужную снова — иначе новая заметка потеряется среди старых.',
      };
    }
    return {
      ok: false,
      summary: 'Пустая заметка',
      detail: 'Передай непустой текст в аргументе `text`.',
    };
  }

  const where = scope === 'global' ? 'в глобальной памяти' : 'в памяти проекта';
  return {
    ok: true,
    summary: result.added ? 'заметка записана' : 'такая заметка уже есть',
    detail: `Заметок ${where} теперь: ${result.notes.length}.`,
  };
}

/** Убрать заметки (в области `scope`), в которых встречается подстрока. */
async function forget(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.memory) return { ok: false, summary: 'Память недоступна' };

  const query = requireString(args, 'query');
  const scope = readScope(args);
  const result = await ctx.memory.forget(query, scope);
  if (result.removed === 0) {
    return {
      ok: true,
      summary: 'подходящих заметок нет',
      detail: `В этой области нет заметок с «${query}». Посмотри список, чтобы уточнить формулировку.`,
    };
  }

  return {
    ok: true,
    summary: `убрано заметок: ${result.removed}`,
    detail: `Осталось заметок: ${result.notes.length}.`,
  };
}

/**
 * Вся память области: в промпт едет только хвост (`MEMORY_PROMPT_CHARS`), и при
 * переполнении агент видит 12 заметок из 40. Без этого действия `forget` бьёт
 * наугад, а отказ `remember` («память заполнена») не показывает, что уже занято.
 */
async function memoryNotes(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.memory) return { ok: false, summary: 'Память недоступна' };
  const scope = readScope(args);
  const notes = await ctx.memory.notes(scope);
  return {
    ok: true,
    summary: notes.length > 0 ? `заметок: ${notes.length}` : 'память пуста',
    detail: formatAllNotes(notes, scope),
  };
}

/**
 * Память одним инструментом: `remember`, `forget` и `notes` — три глагола об
 * одном хранилище, а стоили трёх схем в каждом запросе. Поля у них разные,
 * поэтому схема общая, а недостающее называется до обработчика — как у `edit`.
 */
async function mindAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'remember':
      return missingForAction(args, ['text'], 'mind') ?? (await remember(ctx, args));
    case 'forget':
      return missingForAction(args, ['query'], 'mind') ?? (await forget(ctx, args));
    case 'notes':
      return await memoryNotes(ctx, args);
    case 'ask':
      return await ask(ctx, args);
    // План и цель — состояние беседы, а не файлы: на диске ничего не меняется,
    // запись делает renderer по самому вызову.
    case 'steps':
      return { ok: true, summary: 'план обновлён' };
    case 'goal':
      return { ok: true, summary: 'цель обновлена' };
    // Утверждение плана перехватывает `service.ts` до вызова обработчика: там
    // решается смена режима. Здесь — только если перехвата не было.
    case 'exit_plan':
      return {
        ok: false,
        summary: 'Утверждать нечего: режим плана не включён',
      };
    default:
      return unknownAction(action, 'mind: remember, forget, notes, ask, steps, goal, exit_plan.');
  }
}

/** Языковой сервер: ссылки, объявление и скелет файла — одно состояние, одни права. */
async function lspAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'references':
      return missingForAction(args, ['symbol']) ?? (await findReferences(ctx, args));
    case 'definition':
      return await goToDefinition(ctx, args);
    case 'outline':
      return missingForAction(args, ['path']) ?? (await fileOutline(ctx, args));
    case 'rename':
      return missingForAction(args, ['symbol', 'newName']) ?? (await renameSymbol(ctx, args));
    default:
      return unknownAction(action, 'lsp: references, definition, outline, rename.');
  }
}

/** Проверки: пометки редактора и линтер — оба про «что не так с кодом». */
async function checksAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'diagnostics':
      return await diagnostics(ctx, args);
    case 'lint':
      return await runLinter(ctx, args);
    default:
      return unknownAction(action, 'checks: diagnostics, lint.');
  }
}

/** Сеть: поиск и чтение страницы — два шага одного пути. */
async function webAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  if (action === 'search') return missingForAction(args, ['query']) ?? (await webSearch(ctx, args));
  if (action === 'fetch') return missingForAction(args, ['url']) ?? (await webFetch(ctx, args));
  return unknownAction(action, 'web: search, fetch.');
}

/** Ресурсы MCP: каталог и чтение — две половины одного похода. */
async function mcpAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  if (action === 'list') return await listMcpResources(ctx, args);
  if (action === 'read') return missingForAction(args, ['uri']) ?? (await readMcpResource(ctx, args));
  return unknownAction(action, 'mcp: list, read.');
}

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
      detail: describeValue(error),
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
async function sessionSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
async function sessionTrace(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
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
