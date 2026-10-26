/**
 * Д��спетчер инструментов: одна таблица на все действия.
 *
 * Здесь только `dispatchTool` и общие помощники — каждая группа инструментов
 * (поиск, код, языковой сервер, проверки, сеть и MCP, память) живёт в своём
 * модуле `agent-*.ts` и получает состояние через `ToolContext`, а не через
 * поля класса. Числа (потолки вывода и умолчания) — в `agent-limits.ts`.
 */

import { confirmFile, coveredRequest, uncoverFiles } from '../../shared/read-coverage';
import { isMcpToolName } from '../../shared/mcp';
import { parseSubagentTasks } from '../../shared/subagents';
import { parseToolArguments } from '../../shared/tools';
import { CHARS_PER_TOKEN, CHARS_PER_TOKEN_WIDE, estimateTextTokens, isCondenseMarker } from '../../shared/context-fit';
import { fitOutput } from '../../shared/output-budget';
import {
  argumentsShape,
  describeShape,
  missingArguments,
  missingFieldsDetail,
  toolSpec,
  wrongArguments,
} from '../../shared/tool-schema';
import { canonicalCall } from '../../shared/tool-aliases';
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_TOKENS, MIN_OUTPUT_CHARS, toolOutputChars } from './output-budget';
import { spill } from './output-trim';
import { spillHint } from './spill';
import { terminalAction } from './agent-terminal';
import { editAction, fileAction } from './agent-edit';
import { listDir } from './agent-list';
import { readAction } from './agent-read';
import { failureText } from './tool-rules';
import { runTests } from './tool-command';
import { showAction, unknownTool } from './agent-show';
import type { LookupCall } from './agent-lookup';
import type { ToolContext, ToolOutcome } from './tool-context';
import { checksAction } from './agent-checks';
import { readImage } from './agent-code';
import { lspAction } from './agent-lsp';
import { mindAction } from './agent-memory';
import { historyAction, listAction, projectMap, searchAction } from './agent-search';

/**
 * Реэкспорт для тестов и внешних потребителей: поиск уехал в
 * `agent-search.ts`, но публичная дверь остаётся здесь — иначе каждый тест
 * знал бы внутреннюю раскладку файлов.
 */
import { mcpAction, runExternalTool, webAction } from './agent-web';
import { browserAction } from './agent-browser';

export { searchFallbacks } from './agent-search';

export type {
  MemoryTools,
  SandboxRunner,
  SymbolSearch,
  TerminalAgent,
  TestRunner,
  ToolContext,
  ToolOutcome,
} from './tool-context';

export type { McpResourceInfo, McpToolInfo } from '../../shared/mcp';

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
      // (плоский `edit` вместо обёртки `edits: [{path, edits}]`). Но только та её
      // часть, что относится к пропущенным полям: раньше сюда уезжала СХЕМА
      // ЦЕЛИКОМ (`argumentsShape`), и ошибка на один аргумент стоила сотен
      // токенов в контексте, где половина полей была не про дело.
      return {
        ok: false,
        summary: `Не хватает аргумента: ${missing.join(', ')}. Форма: ${describeShape(spec.inputSchema)}`,
        detail: missingFieldsDetail(name, spec.inputSchema, missing),
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
  // Свой потолок у инструмента: `list` на 18 000 символов не нужен никогда, а
  // `read` нужен пачкой файлов. Меняем ТОЛЬКО символы: токенный предел остаётся
  // прежним, иначе `fitOutput` начнёт резать по токенам раньше, чем по символам,
  // и у русского текста с номерами строк выйдет вдвое короче, чем просили.
  //
  // Отказу достаётся общий предел, а не инструментный. Потолки `run_tests: 12_000`,
  // `checks: 8_000` ставились под объём вывода, который читают с конца; отказ — это
  // текст, который надо прочитать ЦЕЛИКОМ и коротко, а его начало и есть самое
  // важное: `01_deploy.test.ts ✗` стоит в первой строке вывода при 2 000 падений.
  // К тому же обрезка отказу не помогает: услуга всё равно позовёт `failureText`
  // ещё раз (см. ниже), то есть платится дважды, а обрезка ещё и съедала место
  // у подсказки, где лежит копия.
  const own = outcome.ok ? toolOutputChars(name) : MAX_OUTPUT_CHARS;
  const chars = Math.min(own, Math.max(MIN_OUTPUT_CHARS, before?.left ?? MAX_OUTPUT_CHARS));
  // MAX_OUTPUT_TOKENS записан в единицах УЗКОЙ ставки (5 200 ~ 18 000 / 3.5): ровно так
  // его читает тот, кто решает «влезло ли» (outputRoom -> readPrefix). А fitOutput ниже
  // считает по составу: кириллица идёт по CHARS_PER_TOKEN_WIDE (2). Две цены на один текст,
  // и русский read проходил первую проверку, а здесь терял восемь строк головы вместе с
  // адресом продолжения (замер 26.10: 112 из 120). Выравниваем единицы.
  const wideCap = Math.ceil((MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN) / CHARS_PER_TOKEN_WIDE);
  const limit = {
    chars,
    tokens: Math.min(wideCap, Math.max(Math.ceil(MIN_OUTPUT_CHARS / 3.5), before?.tokensLeft ?? wideCap)),
  };
  // Хвост выводят все срезы, которые читают с конца: не только одноразовый
  // `terminal`, но и `terminalOutput` — за ним приходят именно за хвостом живой
  // сессии. У `terminal` сверху при этом остаются две первые строки (они часто
  // и есть причина падения), у чтения сессии — нет: там нужен только хвост.
  const tailFirst = name === 'terminal' || name === 'terminalOutput';
  const withHead = name === 'terminal';
  let detail = original;
  if (fitOutput(original, limit) !== original) {
    const file = spill(ctx, name, original);
    const note = `\n… (вывод обрезан${exhausted ? ' — бюджет вывода на шаг исчерпан' : ''}${file ? `; ${spillHint(file)}` : ''})`;
    const head = withHead ? `${original.split('\n').slice(0, 2).join('\n').slice(0, 400)}\n` : '';
    const room = {
      chars: limit.chars - note.length - head.length,
      tokens: limit.tokens - estimateTextTokens(note + head),
    };
    const fitted = fitOutput(original, room, tailFirst);
    // Код и списки не обрываем посреди строки, если есть хотя бы одна полная.
    const newline = tailFirst ? fitted.indexOf('\n') : fitted.lastIndexOf('\n');
    const body = newline < 0 ? fitted : tailFirst ? fitted.slice(newline + 1) : fitted.slice(0, newline);
    detail = head + body + note;
  }
  if (ctx.stepBudget && before) {
    // Единожды учитываем весь результат, включая заголовки и ссылку на копию.
    ctx.stepBudget.left = exhausted ? 0 : Math.max(0, before.left - detail.length);
    // Оба бюджета ведутся в единицах УЗКОЙ ставки (см. wideCap выше): то, что fitOutput
    // оценил по составу, при списании переводим обратно — иначе кириллица спишется вдвое.
    const spent = Math.ceil((estimateTextTokens(detail) * CHARS_PER_TOKEN_WIDE) / CHARS_PER_TOKEN);
    ctx.stepBudget.tokensLeft = exhausted ? 0 : Math.max(0, before.tokensLeft - spent);
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
      // Семейства ниже — одним инструментом с `action`: семь схем браузера стоили
      // модели дороже, чем их различие по смыслу. Терминал из этого ряда выбыл:
      // восемь действий одной схемой весили 370 токенов на каждом шаге — каждой
      // правке — за поля, к делу не относящиеся.
      case 'browser':
        return await browserAction(ctx, args);
      case 'mind':
        return await mindAction(ctx, args);
      case 'show':
        return await showAction(ctx, args);
      case 'terminal':
      case 'terminalOpen':
      case 'terminalOutput':
      case 'terminalWrite':
      case 'terminalStop':
      case 'terminalList':
        return await terminalAction(ctx, name, args);
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

/**
 * `ask` — остановить прогон и спросить человека. Агент сам вопрос не придумывает и
 * ничего не решает за него: без ответа он честно останавливается. Ответ уходит модели
 * результатом вызова, и прогон продолжается тем же ходом (в отличие от подтверждений,
 * где от ответа зависит лишь одно действие). Моста нет — инструмент не предлагается.
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
