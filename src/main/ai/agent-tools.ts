import path from 'node:path';
import type {
  ApplyEditsHostResult,
  BrowserZoomMode,
  DiagnosticItem,
  DiagnosticsHostResult,
  DirEntry,
  GitCommitInfo,
  GitNetworkResult,
  GitStatus,
  SearchHit,
  TerminalCreateOptions,
  TerminalSession,
  ToolFileChange,
} from '../../shared/api';
import { formatBrowserSnapshot, type BrowserSnapshot } from '../../shared/browser';
import { digestHits, formatCodeSearch, rankSymbols, type SearchSymbol } from '../../shared/code-search';
import { formatDocsAnswer } from '../../shared/docs-index';
import { formatBlame, type BlameLine } from '../../shared/git-blame';
import type { MemoryNote, MemoryScope, RememberResult } from '../../shared/memory';
import { formatWebResults, type WebSearchHit } from '../../shared/web-search';
import { formatReadImageReply, formatReadImageSummary } from '../../shared/read-image';
import { testTargetProblem } from '../../shared/test-target';
import { limitPerFile, MAX_HITS_PER_FILE } from '../../shared/search-limit';
import { formatFetchedPage, type FetchedPage } from '../../shared/web-fetch';
import type { ApplyFailure, ApplyReport, FileEdit, TextEdit } from '../../shared/edits';
import type { PatchFile, PatchHunk } from '../../shared/patch';
import { formatLintReport, type LintOutcome } from '../../shared/lint';
import { formatLocations, type SymbolLocation } from '../../shared/lsp-locations';
import { formatOutline, type FileSymbol } from '../../shared/lsp-symbols';
import { formatMcpResources, isMcpToolName, type McpResourceInfo, type McpToolInfo } from '../../shared/mcp';
import { collapsePassedTests, compressToolOutput, looksLikeTestRun } from '../../shared/output-compress';
import type { ToolPresentedFile } from '../../shared/api';
import type { SkillEntry } from '../../shared/skills';
import { formatProjectMap } from '../../shared/project-map';
import { formatSessionSearch, type SessionSearchReport } from '../../shared/session-search';
import { parseSubagentTasks, type SubagentTask } from '../../shared/subagents';
import {
  formatAgentList,
  formatAgentWaits,
  parseInterruptRequest,
  parseMessageRequest,
  parseSpawnRequest,
  parseWaitRequest,
  type AgentMessageFrom,
  type AgentSnapshot,
  type AgentStopReason,
  type AgentWaitOutcome,
} from '../../shared/agents';
import type { AgentWaitResult } from './agents';
import { parseToolArguments } from '../../shared/tools';
import { isCondenseMarker } from '../../shared/context-fit';
import { missingArguments, toolSpec, wrongArguments } from '../../shared/tool-schema';
import { canonicalCall } from '../../shared/tool-aliases';
import { booleanArg, describeValue, integerArg, isAbsent } from '../../shared/tool-args';
import { scanProject } from '../project/scan';
import type { WorkspaceService } from '../workspace/workspace';
import { runShellCommand, type CommandResult, type RunOptions } from './run-command';
import { createSpillStream, spillHint, spillText } from './spill';
import type { JobHandle, JobRegistry, JobSnapshot } from './jobs';

/**
 * Исполнение инструментов агента.
 *
 * Чтение (list, read, search) и запуск команд делаются здесь же:
 * все пути проходят через `WorkspaceService`, а значит ограничены рабочей
 * папкой (включая проверку симлинков). Правки (`edit`) уходят в renderer
 * хостовым вызовом — там документная модель, undo и ревью пользователя.
 */

export interface ToolOutcome {
  ok: boolean;
  /** Короткая строка для карточки в UI. */
  summary: string;
  /** То, что уходит модели. Может быть длинным — усекается до `MAX_OUTPUT_CHARS`. */
  detail?: string;
  /** Фактически прочитанный диапазон строк (1-based, включительно): повтор не нужен. */
  read?: { path: string; from: number; to: number };
  /**
   * Картинки (data-URL), которые надо положить модели отдельным сообщением
   * прогона: в текст результата их положить нельзя — у OpenAI в `tool`-сообщении
   * допустим только текст. Поэтому они едут следующим сообщением пользователя
   * и только внутри прогона (см. `service.ts`).
   */
  images?: readonly string[];
  /** Файловые операции (создание/удаление/перенос): их показывает панель изменений чата. */
  changes?: ToolFileChange[];
  /**
   * Файлы-результаты (`show` с action present): в ленте это карточка с кнопками «Открыть».
   * Не `changes`: там «что изменилось», а здесь «вот что я сделал, посмотри».
   */
  presented?: ToolPresentedFile[];
  /**
   * Тела этого вызова уже не нужны в истории: их можно заменить пометкой
   * (см. `condenseAppliedCalls`). Это текст, который лёг в файл (правка, новый
   * файл): он остаётся в трассе прогона. Ставится только там, где тело действительно
   * своё отработало: отклонённая правка или правка, оставшаяся в буфере
   * редактора, ещё понадобится модели целиком.
   */
  applied?: boolean;
}

/**
 * Git-инструменты агента. Нужен только минимум: посмотреть статус и diff.
 * Полный `GitService` подходит сюда структурно (см. `diffText`).
 */
export interface GitTools {
  status(): Promise<GitStatus>;
  /** Diff файла; без пути — весь рабочий diff целиком («что я наменял»). */
  diffText(path?: string, staged?: boolean): Promise<string>;
  /** История коммитов текстом: hash, дата, автор, заголовок. */
  logText(limit?: number, path?: string): Promise<string>;
  /** Происхождение строк файла: кто, когда и каким коммитом их менял. */
  blame(filePath: string, range?: { startLine?: number; endLine?: number }): Promise<readonly BlameLine[]>;
  /** Записи: индексирование и коммит меняют состояние репозитория. */
  stage(paths: string[]): Promise<GitStatus>;
  unstage(paths: string[]): Promise<GitStatus>;
  commit(message: string, paths?: string[]): Promise<GitCommitInfo>;
  checkout(name: string, create?: boolean): Promise<GitStatus>;
  discard(paths: string[]): Promise<GitStatus>;
  /** Сеть: забрать, влить и отправить коммиты. */
  fetch(): Promise<GitNetworkResult>;
  pull(): Promise<GitNetworkResult>;
  push(options?: { setUpstream?: boolean; force?: boolean }): Promise<GitNetworkResult>;
}

/**
 * Терминал для агента: настоящий pty, а не одноразовый spawn. Сессия живёт
 * между шагами — можно поднять сервер и позже читать его вывод.
 * Полный `TerminalService` подходит сюда структурно.
 */
export interface TerminalAgent {
  list(): TerminalSession[];
  create(options: TerminalCreateOptions): Promise<TerminalSession>;
  write(id: string, data: string): void;
  read(id: string, from?: number): { data: string; offset: number; alive: boolean; exitCode?: number };
  kill(id: string): void;
}

/**
 * Поиск объявлений символов — его умеет языковой сервер («перейти к символу»),
 * и другого способа найти класс по имени в проекте нет. Полный `LspService`
 * подходит сюда структурно, как `GitTools` и `TerminalAgent`.
 */
export interface SymbolSearch {
  projectSymbols(query: string): Promise<readonly SearchSymbol[]>;
  /** Язык файла для запроса к серверу: редактор знает его точнее расширения. */
  languageFor?(path: string): string | null;
  /**
   * Скелет файла: объявления с номерами строк. Текст передаём снаружи — читает
   * его агент через `WorkspaceService`, то есть с проверкой путей.
   * `null` — сервер недоступен или не умеет; пустой список — объявлений нет.
   */
  outline?(path: string, languageId: string, text: string): Promise<readonly FileSymbol[] | null>;
  /**
   * Ссылки на символ: где он ещё встречается. Позиция — объявление символа
   * (1-based, как её отдаёт `workspace/symbol`). `null` — сервер не умеет искать
   * ссылки; пустой список — умеет, но мест не нашёл.
   */
  references?(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
  ): Promise<readonly SymbolLocation[] | null>;
  /** Переход к определению из позиции использования. `null` — сервер не умеет. */
  definition?(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
  ): Promise<readonly SymbolLocation[] | null>;
  /**
   * Правки переименования символа во всех местах использования. `null` — сервер
   * не умеет переименование; пустой список — умеет, но менять нечего.
   */
  rename?(
    path: string,
    languageId: string,
    text: string,
    line: number,
    column: number,
    newName: string,
  ): Promise<readonly FileEdit[] | null>;
}

/**
 * Веб-поиск для действия `search` инструмента `web`. Настройки, ключ и сеть живут в
 * `ai/service.ts` и `ai/web-search.ts`: сюда приходит уже готовый вызов, поэтому
 * инструмент остаётся проверяемым без сети.
 */
/**
 * Внешние инструменты (MCP). Их список приходит от чужих процессов, поэтому
 * проверяем его на каждом вызове: сервер мог не подняться или его выключили.
 */
export interface McpRunner {
  list(): Promise<readonly McpToolInfo[]>;
  call(exposedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Каталог ресурсов: то, чем серверы отдают документы, а не действия. */
  resources(): Promise<readonly McpResourceInfo[]>;
  /** Прочитать ресурс по адресу из каталога. */
  readResource(uri: string, serverId?: string): Promise<{ text: string; isError: boolean }>;
}

export interface SessionSearchRunner {
  /**
   * Найти беседы по словам: разбор и форма ответа — `shared/session-search.ts`.
   * `limit` — сколько бесед вернуть: по умолчанию пять, потолок задаёт
   * `MAX_SESSION_HITS_CAP`. Нужен, когда поиск промахнулся и есть что посмотреть.
   */
  search(query: string, options?: { limit?: number }): Promise<SessionSearchReport>;
}

export interface WebSearchRunner {
  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ hits: readonly WebSearchHit[]; providerLabel: string }>;
}

/**
 * Чтение страницы по ссылке для действия `fetch` инструмента `web`. Сеть живёт в
 * `ai/web-fetch.ts`, а сюда приходит готовый вызов — тот же уговор, что у `search`.
 */
export interface WebFetchRunner {
  fetch(url: string, options?: { signal?: AbortSignal; maxChars?: number }): Promise<FetchedPage>;
}

/**
 * Линтер проекта: проверка кода на замечания. Выбор движка и запуск живут в main
 * (`project/lint.ts`), сюда приходит готовый вызов — тот же уговор, что у `GitTools`
 * и `TerminalAgent`. Инструмент остаётся проверяемым без запуска линтеров.
 */
export interface Linter {
  /** Проверить файл, папку или весь проект (цель не задана). */
  lint(target?: string): Promise<LintOutcome>;
}

/**
 * Резолвер команды запуска тестов проекта: чем гонять тесты, решает main (там
 * процессы и карта проекта), а не агент — иначе половина прогонов падала бы на
 * «команда не найдена». `null` — тестов нет или запускать нечем.
 */
export interface TestRunner {
  /**
   * Команда запуска тестов. `target` — файл тестов или имя теста: прогон всего
   * набора на большом проекте стоит десятки тысяч строк вывода, а агент обычно
   * правил одну функцию. Не задано — весь набор, как раньше.
   */
  command(target?: string): Promise<{ command: string; label: string } | null>;
}

/**
 * Память проекта для инструмента `mind` (действия `remember` и `forget`). Хранилище живёт в main
 * (`ai/project-memory.ts`), сюда приходит готовый вызов: инструменты остаются
 * проверяемыми без файловой системы.
 */
export interface MemoryTools {
  remember(text: string, scope?: MemoryScope): Promise<RememberResult>;
  forget(query: string, scope?: MemoryScope): Promise<{ notes: readonly MemoryNote[]; removed: number }>;
}

/**
 * Навыки проекта для инструмента read_skill. Каталог — тот же, что ушёл в промпт:
 * иначе агент просил бы навык, которого нет, или пропускал бы новый.
 */
export interface SkillTools {
  list(): Promise<readonly SkillEntry[]>;
  read(name: string): Promise<{ entry: SkillEntry; body: string } | null>;
}

/**
 * Подзадача (`task`): отдельный агент со своим контекстом. Цикл подзадачи живёт
 * в `service.ts` — там есть провайдер и модель, которых здесь нет. Сюда приходит
 * готовый вызов: инструмент остаётся проверяемым без сети и Electron.
 */
export interface SubagentRunner {
  run(params: { description: string; prompt: string }): Promise<ToolOutcome>;
  /**
   * Несколько подзадач разом. Одновременность ограничивает сервис (см.
   * `MAX_PARALLEL`): каждая подзадача — свой прогон модели, то есть деньги.
   */
  runMany(tasks: readonly SubagentTask[]): Promise<ToolOutcome>;
  /**
   * Агент в фоне (`action: "spawn"`): запустить и вернуть номер, не дожидаясь отчёта.
   * Дальше с ним работают `list`, `wait`, `send` и `interrupt` — через реестр (`ctx.agents`).
   */
  spawn?(params: { description: string; prompt: string }): ToolOutcome;
}

/**
 * Живые агенты для инструмента `agents` (действия `list`, `wait`, `send`,
 * `interrupt`). Реестр живёт в main (`ai/agents.ts`), сюда приходит его
 * видимая часть: по ней инструменты проверяются без модели и без окна.
 */
export interface AgentTools {
  list(): AgentSnapshot[];
  send(id: string, text: string, from: AgentMessageFrom): { ok: boolean; reason?: string };
  interrupt(id: string, by: AgentStopReason): boolean;
  wait(ids: readonly string[], timeoutMs: number): Promise<AgentWaitResult>;
}

/**
 * Картинка, которую агент посмотрел (`read_image`). Готовит её main: путь
 * проверен рабочим каталогом, крупные файлы уменьшены, тип — тот, который
 * провайдер принимает. Инструмент остаётся проверяемым без Electron.
 */
export interface ReadImageResult {
  /** Тип содержимого ровно такой, каким он уйдёт модели (после уменьшения может смениться). */
  mime: string;
  /** Готовый data-URL: в таком виде картинку понимает и провайдер, и `<img>` в ленте. */
  dataUrl: string;
  /** Размеры в пикселях; 0 — определить не удалось (формат движок не разбирает). */
  width: number;
  height: number;
  /** Вес того, что уйдёт модели. */
  bytes: number;
  /** Исходник, если пришлось уменьшать; `null` — отправлен файл как есть. */
  source: { mime: string; width: number; height: number; bytes: number } | null;
}

export interface ReadImageRunner {
  load(filePath: string): Promise<ReadImageResult>;
}

/**
 * Браузер для инструментов `browser_*`: свой Chromium, управляемый по CDP.
 * Запуск и подключение живут в main (`browser/browser.ts`), сюда приходит готовый
 * вызов — инструменты остаются проверяемыми без браузера.
 */
export interface BrowserTools {
  /** Перейти на адрес; возвращает снимок страницы после загрузки. */
  open(url: string): Promise<BrowserSnapshot>;
  /** Снимок текущей страницы. */
  snapshot(): Promise<BrowserSnapshot>;
  /** Нажать элемент по номеру из снимка; возвращает новый снимок. */
  click(ref: string): Promise<BrowserSnapshot>;
  /** Ввести текст в поле; `submit` — отправить форму клавишей Enter. */
  type(ref: string, text: string, submit: boolean): Promise<BrowserSnapshot>;
  /** Выполнить выражение на странице и вернуть результат текстом. */
  evaluate(expression: string): Promise<string>;
  /**
   * Масштаб страницы. Есть только у встроенного браузера: там масштаб — состояние
   * вкладки, которое видит человек. Поэтому метод необязательный — без него
   * инструмент честно скажет, что здесь так нельзя.
   */
  zoom?(mode: BrowserZoomMode): Promise<{ ok: boolean; zoom?: number; reason?: string }>;
  /** Закрыть браузер и убрать временный профиль. */
  close(): Promise<void>;
  /** Идёт ли сессия: `false` — браузер ещё не поднимали (или уже закрыли). */
  readonly running?: boolean;
}

/**
 * Песочница: команды выполняются в контейнере, а не на машине пользователя.
 * Запуск и поиск движка — в `main/sandbox/sandbox.ts`. Настройка включена, но
 * движка нет (`available === false`) — команда не выполняется вовсе: тихий откат
 * на хост дал бы ложное чувство изоляции.
 */
export interface SandboxRunner {
  /** Подпись для вывода: где именно шла команда. */
  readonly label: string;
  /** Можно ли выполнить команду: движок найден. */
  readonly available: boolean;
  /** Те же опции запуска, что у хостового пути: отмена и предел времени. */
  run(command: string, cwd: string, options?: RunOptions): Promise<CommandResult>;
}

export interface ToolContext {
  workspace: WorkspaceService;
  signal?: AbortSignal;
  /** Полный доступ: не спрашивать разрешения на правки. */
  autoApprove?: boolean;
  /** Полный доступ: не спрашивать разрешения ни на что — включая команды. */
  allowAll?: boolean;
  /**
   * Страховка полного доступа: даже при нём спрашивать перед необратимыми
   * командами. Идёт из `settings.ai.confirmDangerous`, по умолчанию включена.
   */
  confirmDangerous?: boolean;
  /** Правки в документах; нет обработчика — правки недоступны. */
  applyEdits?(edits: FileEdit[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /**
   * Правки по якорю. Якоря разрешает renderer: только у него есть текст
   * документа (в том числе несохранённый). Позиции он же и считает.
   */
  applyPatches?(patches: PatchFile[], autoApprove: boolean): Promise<ApplyEditsHostResult>;
  /** Спросить у пользователя разрешение на запуск команды. */
  confirmCommand?(command: string): Promise<boolean>;
  /**
   * Задать человеку вопрос и дождаться ответа (инструмент `ask`). Пустой ответ —
   * вопрос остался без ответа: прогон прервали или нажали «Отменить».
   */
  ask?(question: string, options?: readonly string[]): Promise<string>;
  /** Спросить разрешение на действие git (коммит, отправка, откат). */
  confirmGit?(action: string): Promise<boolean>;
  /** Пометки языка из редактора. */
  diagnostics?(path?: string): Promise<DiagnosticsHostResult>;
  /** Git рабочей папки: нужен инструментам git_read/git_write. */
  git?: GitTools;
  /** Открыть файл в редакторе (renderer): действие open инструмента show. */
  openFile?(path: string, line?: number, column?: number): Promise<boolean>;
  /** Терминальные сессии (pty): нужны инструментам terminal_*. */
  terminals?: TerminalAgent;
  /** Символы проекта и скелет файла (языковой сервер): lsp (action references|definition|outline). */
  symbols?: SymbolSearch;
  /** Линтер проекта: нужен действию lint инструмента checks. */
  linter?: Linter;
  /** Команда запуска тестов: нужна инструменту run_tests. */
  tests?: TestRunner;
  /** Прошлые беседы проекта: нужен инструменту `session_search`. */
  sessions?: SessionSearchRunner;
  /** Память проекта: нужна инструменту mind. */
  memory?: MemoryTools;
  /** Навыки проекта (`.chui/skills`): каталог идёт в промпт, тело — инструментом read_skill. */
  skills?: SkillTools;
  /** Картинки для модели (`read_image`): чтение и уменьшение живут в main (`ai/read-image.ts`). */
  readImage?: ReadImageRunner;
  /** Веб-поиск: подключён только при включённой настройке. */
  webSearch?: WebSearchRunner;
  /** Чтение страницы по ссылке: тоже только при включённой настройке. */
  webFetch?: WebFetchRunner;
  /** Внешние инструменты (MCP): есть только при настроенных серверах. */
  mcp?: McpRunner;
  /** Подзадачи (инструмент `task`): запускает service — у него есть провайдер. */
  subagent?: SubagentRunner;
  /**
   * Живые агенты: список, ожидание, сообщение, остановка. Реестр один на окно
   * (`ai/agents.ts`), поэтому видны и те агенты, что запущены прошлым — или фоновым —
   * прогоном.
   */
  agents?: AgentTools;
  /** Браузер: подключён только при включённой настройке. */
  browser?: BrowserTools;
  /** Спросить разрешение на действие в браузере (переход, клик, ввод, скрипт). */
  confirmBrowser?(action: string): Promise<boolean>;
  /** Песочница: подключена только при включённой настройке. */
  sandbox?: SandboxRunner;
  /**
   * Задания (`terminal` с `action: run` и `background: true`): долгие команды, которые не держат шаг.
   * Реестр живёт в main на всё окно — по нему же видно, что уже запущено.
   */
  jobs?: JobRegistry;
  /**
   * Куда складывать длинный вывод (см. `ai/spill.ts`). Не задано — обрезаем без
   * копии, как раньше: путь к файлу, которого не появится, обещать нельзя.
   */
  spillDir?: string;
  /**
   * Остаток бюджета вывода на шаг. Заводит агентный цикл на каждый шаг и
   * расходуют все инструменты шага вместе (см. `STEP_OUTPUT_CHARS`).
   *
   * Предел на вызов этой задаче не отвечает: три `read` в одном шаге честно
   * укладываются в свои 60 000 символов каждый и дают 180 000 — контекст уже
   * переполнен, а обрезка срабатывает только следующим шагом и выбрасывает ходы
   * целиком. Поэтому шаг платит из общего бюджета, а исчерпанное называется вслух.
   */
  stepBudget?: { left: number };
}

/**
 * Ограничение вывода одного вызова: без него один файл на 2 МБ съест весь
 * контекст модели. 45 000 символов — это примерно 12 000 токенов, которых
 * хватает на средний модуль целиком.
 */
export const MAX_OUTPUT_CHARS = 45_000;

/**
 * Сколько символов вывода шаг отдаёт модели всего. Предела на вызов мало: агент
 * читает по три файла за шаг, и это 135 000 символов — после чего обрезка истории
 * выбрасывает ходы целиком. Бюджет шага делает цену шага предсказуемой, а
 * `MIN_OUTPUT_CHARS` не даёт инструменту ответить пустотой.
 *
 * 60 000 — это три полных вызова или десяток небольших. Свежие результаты
 * инструментов провайдер оплачивает целиком (в кеш они попадают только со
 * следующего запроса), поэтому бюджет шага — самая дорогая часть истории.
 */
export const STEP_OUTPUT_CHARS = 60_000;

/**
 * Минимум на один вызов, даже когда бюджет шага уже исчерпан. Пустой ответ модель
 * поймёт как «инструмент ничего не вернул» и позовёт его снова; честнее отдать
 * начало (или хвост) с пометкой, что текст лежит в файле.
 */
const MIN_OUTPUT_CHARS = 1_500;
/**
 * Бюджет вывода шага под окно модели.
 *
 * 60 000 символов — это около 17 000 токенов, и на окне 32k один шаг съедал
 * половину: следующий же шаг упирался в переполнение, а промах стоит полного
 * запроса заново плюс выброшенные ходы. Поэтому бюджет — доля окна (12%), но не
 * больше прежнего потолка и не меньше 6 000 символов (иначе инструмент ответит
 * пустотой, и модель позовёт его снова).
 */
export function stepOutputChars(windowTokens: number): number {
  const share = Math.round(windowTokens * 0.12 * 3.5);
  return Math.max(MIN_OUTPUT_CHARS * 4, Math.min(STEP_OUTPUT_CHARS, share));
}
/** Больше этого одной страницы модели не отдаём: даже по просьбе. */
const MAX_FETCH_CHARS = 60_000;
const MAX_SEARCH_HITS = 200;
/**
 * Умолчания `limit`: в схеме только «сколько», а само число — здесь. Строчка
 * «(50; 35 с контекстом; 80 файлов)» читалась моделью на каждом шаге и весила
 * больше, чем весь остальной аргумент; поведение от этого не меняется — код и
 * раньше брал то же число, когда модель молчала. Те же числа для людей — в `TOOLS.md`.
 */
/**
 * Сколько совпадений отдаём, если модель не попросила иначе. Двести — потолок,
 * а не умолчание: замер на живом проекте (‘export function’) давал 21 000
 * символов ≈ 6 000 токенов за один вызов, и это при том, что первые десять
 * строк уже отвечают на вопрос.
 */
const DEFAULT_SEARCH_HITS = 50;
/** С контекстом умолчание ниже: каждое совпадение — это блок из пяти строк. */
const DEFAULT_SEARCH_HITS_WITH_CONTEXT = 35;
/**
 * Сколько совпадений отдаём в `search code`, если модель не попросила иначе.
 * Объявления символов — что и где: сорока строк с запасом хватает на «в каком
 * файле это имя», и потолок тот же — это не выбор, а умолчание.
 */
const DEFAULT_CODE_SYMBOLS = 40;
/** Сколько разделов документации отдаём на один запрос `search_docs`. */
const DEFAULT_DOC_RESULTS = 8;
const MAX_DOC_RESULTS = DEFAULT_DOC_RESULTS;
/**
 * Сколько результатов поиска в сети отдаём, если модель не попросила иначе.
 * Десять ссылок — уже край: сколько дальше — решать по странице, а не по списку.
 */
const DEFAULT_WEB_RESULTS = 10;
const MAX_WEB_RESULTS = DEFAULT_WEB_RESULTS;
/** Сколько коммитов отдаёт `git_read log`, если модель не попросила иначе. */
const DEFAULT_GIT_LOG = 20;
const MAX_GIT_LOG = 100;
/**
 * Во сколько раз просим больше совпадений, чем отдадим. Потолок на файл
 * отбирает уже после поиска: без запаса шумный файл занял бы весь список, и
 * других файлов в выдаче не было бы вовсе.
 */
const SEARCH_OVERFETCH = 3;
/** Потолок для режима «только файлы»: там на файл одна строка, поэтому можно больше. */
const MAX_FIND_FILES = 2000;
/**
 * Сколько путей отдаём в `search filesOnly`, если модель не попросила иначе.
 * Две тысячи строк — это около 11 900 символов (≈3 400 токенов) ради ответа
 * «где встречается»: по сотне путей уже видно, где искать, остальное добирается
 * сужением запроса или папки.
 */
const DEFAULT_FILES_ONLY_PATHS = 80;
const MAX_DIR_ENTRIES = 500;
/**
 * Сколько путей отдаёт `list`, если модель не попросила иначе. Двести
 * путей — это около 6 500 символов (≈1 850 токенов) на запрос «какие тут есть
 * файлы»; сотни хватает, чтобы увидеть край дерева, а остальное берётся сужением
 * маски.
 */
const DEFAULT_FIND_FILES = 100;
/**
 * С какого размера файл называем в `list`. Мелкие размеры — шум: за вызов
 * их бывает до 500, и «(412 Б)» у каждой записи стоит дороже, чем сообщает.
 */
const BIG_FILE_BYTES = 1024 * 1024;

/** Размер крупного файла в удобных единицах — только для таких и зовётся. */
function formatBigSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb.toFixed(1)} МБ`;
}
/** Сколько строк отдаёт read за один диапазонный вызов. */
const MAX_READ_LINES = 2000;
/**
 * Файл длиннее — читается не целиком, а головой и оглавлением. Отдать 60 000
 * символов начала — это ~15 000 токенов вслепую: конец файла всё равно не виден,
 * и модель просит следующие диапазоны наугад.
 */
const WHOLE_FILE_MAX_LINES = 400;
/** Сколько строк показываем из длинного файла и с какой просить продолжение. */
const LONG_FILE_HEAD_LINES = 200;

/** Максимум правок за один вызов: защита от вырожденного ответа модели. */
const MAX_EDITED_FILES = 50;
const MAX_EDITS_PER_FILE = 500;

/** Команда длиннее — это уже не команда, а попытка спрятать скрипт. */
const MAX_COMMAND_CHARS = 2000;
/**
 * Сколько символов команды повторять в ответе. Короткая команда полезна в
 * выводе (видно, что запускалось), длинная — нет: она уже есть в вызове.
 */
const ECHO_COMMAND_CHARS = 120;

/** Форма аргумента правки: её называем в ошибках — вызов чинится за один шаг. */
const EDITS_SHAPE =
  'нужен [{ path: "/абсолютный/путь/файл", edits: [{ oldText, newText }] }] — ' +
  'вместо старого текста можно четыре позиции: startLine, startColumn, endLine, endColumn';

/**
 * Необратимые команды — на них и срабатывает страховка полного доступа
 * (`settings.ai.confirmDangerous`). Список не защита от злого умысла, а страховка
 * от ошибки: цена промаха выше выигрыша от автоматизации. Ловим опасные глаголы
 * в любом месте строки (после `;`, `&&`, `|`), а не только в начале, и намеренно
 * склонны спросить лишний раз: страховка включается вручную, и промах в сторону
 * вопроса дешевле пропущенного `rm -rf`.
 */
const DANGEROUS_COMMAND = new RegExp(
  [
    String.raw`(^|[\s;&|])(sudo|doas|su)\s`,
    String.raw`(^|[\s;&|])(rm|rmdir|shred|wipefs|mkfs\S*|fdisk|sfdisk|parted|shutdown|reboot|poweroff|halt|killall|pkill)\s`,
    String.raw`(^|[\s;&|])dd\s+[^\n]*\bif=`,
    String.raw`>\s*\/dev\/(sd|nvme|hd|disk)`,
    String.raw`>\s*(\/etc\/|\/boot\/|\/usr\/|~?\/?\.ssh\/|~?\/?\.bashrc|~?\/?\.zshrc)`,
    String.raw`:\s*\(\s*\)\s*\{`,
    String.raw`chmod\s+-R\s+(777|666)\s+\/(\s|$)`,
    String.raw`chown\s+-R\s+\S+\s+\/(\s|$)`,
    String.raw`git\s+(push\s+[^\n]*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f[a-z]*d)`,
    String.raw`(curl|wget)\b[^\n|]*\|\s*(ba|z|fi|da)?sh\b`,
    `--no-preserve-root`,
  ].join('|'),
  'i',
);

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command);
}

/**
 * Спрашивать ли разрешение на команду. Обычный агент спрашивает всегда; при
 * полном доступе — только если включена страховка `confirmDangerous`
 * и команда необратима. По умолчанию страховка включена; человек может её
 * снять, и тогда полный доступ исполняет всё без вопросов.
 */
function needsConfirmation(ctx: ToolContext, command: string): boolean {
  if (!ctx.allowAll) return true;
  return ctx.confirmDangerous === true && isDangerousCommand(command);
}

/** Отказ «команду спросить не у кого»: окно редактора не подключено. */
function noCommandBridge(): ToolOutcome {
  return {
    ok: false,
    summary: 'Запуск команд недоступен: окно редактора не подключено',
    detail: 'Команду должен подтвердить человек, а моста подтверждений нет. Не повторяй вызов.',
  };
}

/** Человек не разрешил — одним текстом на всех путях запуска. */
function commandDenied(): ToolOutcome {
  return {
    ok: false,
    summary: 'Пользователь запретил выполнение команды',
    detail: 'Пользователь не разрешил выполнить эту команду. Не повторяй её — предложи другое решение.',
  };
}

/**
 * Спросить разрешение на команду: null — можно выполнять.
 *
 * Путей запуска три — `terminal` с `action: run` (в том числе с `background: true`),
 * `action: start` и `action: write` — и раньше каждый отвечал своими словами («запретил команду»,
 * «запретил ввод», «недоступен»). Модель не понимала, отличается ли отказ от
 * отказа, и пробовала снова. Теперь и вопрос, и отказ одни на всех.
 */
async function confirmRun(ctx: ToolContext, command: string, prompt = command): Promise<ToolOutcome | null> {
  if (!ctx.confirmCommand) return noCommandBridge();
  if (!needsConfirmation(ctx, command)) return null;
  const allowed = await ctx.confirmCommand(prompt);
  return allowed ? null : commandDenied();
}

/**
 * Текст отказа для модели: не только «что не так», но и совет.
 *
 * Раньше брался один `summary`, а `detail` выбрасывался — при том что советы
 * живут как раз в нём («это не текстовый файл — если нужны метаданные, возьми
 * list»). Модель видела «Ошибка: бинарный файл» и шла угадывать, а это не
 * токены, а потерянный шаг.
 */
export function failureText(outcome: ToolOutcome): string {
  const head = `Ошибка: ${outcome.summary}`;
  return outcome.detail ? `${head}\n${outcome.detail}` : head;
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
      return { ok: false, summary: `Не хватает аргумента: ${missing.join(', ')}` };
    }
    // Значение мимо `enum` — тот же класс ошибки, что забытое поле: `switch` ниже
    // ответит «действие неизвестно» и не назовёт варианты, а модель потратит шаг.
    const wrong = wrongArguments(spec.inputSchema, parsed.value);
    if (wrong.length > 0) {
      // Как и у нехватки поля: сначала значение, которое пришло от модели (иначе
      // отказ не объясняет, что не так), потом перечень — он же в `detail`.
      const values = wrong.map((issue) => `${issue.path} «${issue.value}»`).join(', ');
      const allowed = wrong.map((issue) => issue.allowed.join(', ')).join('; ');
      return {
        ok: false,
        summary: `Неизвестное значение аргумента: ${values}`,
        detail: `Допустимые значения: ${allowed}.`,
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

  return clipOutcome(ctx, name, await dispatchTool(ctx, name, parsed.value));
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
 * один вызов), `search` (docs), `git_read`, `checks` не
 * режутся вовсе. Пропустить потолок теперь не может ни один инструмент — в том
 * числе новый, который забыли об этом попросить.
 */
function clipOutcome(ctx: ToolContext, name: string, outcome: ToolOutcome): ToolOutcome {
  const detail = outcome.detail;
  // Короткое не трогаем: лишний файл копии и пометка «обрезано» дороже самого
  // ответа, а инструменты, которые сами блюдут бюджет, сюда просто не попадут.
  if (typeof detail !== 'string' || detail.length <= MAX_OUTPUT_CHARS) return outcome;
  const { text, truncated } = clipText(ctx, name, detail);
  return truncated ? { ...outcome, detail: text } : outcome;
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
      case 'read_skill':
        return await readSkill(ctx, args);
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
        return await editFiles(ctx, args);
      case 'web':
        return await webAction(ctx, args);
      case 'file':
        return await fileAction(ctx, args);
      case 'plan':
        return {
          ok: true,
          summary: requireString(args, 'action') === 'goal' ? 'цель обновлена' : 'план обновлён',
        };
      case 'ask':
        return await ask(ctx, args);
      case 'task':
        return await task(ctx, args);
      // Агенты в фоне одним инструментом: запуск и ожидание — `agents`, действия по
      // имени. Пять схем стоили дороже одной с `action`, а повторный вызов по одному
      // имени всё равно выполняется сразу.
      case 'agents':
        return await agentsAction(ctx, args);
      case 'mcp':
        return await mcpAction(ctx, args);
      // Три семейства ниже — одним инструментом с `action`: семь схем браузера и
      // пять терминала стоили модели дороже, чем их различие по смыслу. У git
      // имён два, а не одно: граница «чтение / запись» решает, где его позвать.
      case 'browser':
        return await browserAction(ctx, args);
      case 'mind':
        return await mindAction(ctx, args);
      case 'git_read':
        return await gitRead(ctx, args);
      case 'git_write':
        return await gitWrite(ctx, args);
      case 'show':
        return await showAction(ctx, args);
      case 'terminal':
        return await terminalAction(ctx, args);
      default:
        return { ok: false, summary: `Инструмент недоступен: ${name}` };
    }
  } catch (error) {
    return { ok: false, summary: error instanceof Error ? error.message : String(error) };
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
    return { ok: false, summary: 'Не задан вопрос', detail: 'Инструменту нужен непустой аргумент question.' };
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
    return ctx.subagent.run({ description: only.description, prompt: only.prompt });
  }
  return ctx.subagent.runMany(request.tasks);
}

/* ── живые агенты ────────────────────────────────────────────────────────
 *
 * Агент в фоне (`agents` с `action: "spawn"`) и работа с уже запущенными: список,
 * ожидание,
 * сообщение, остановка. Сами агенты и почта живут в реестре main (`ai/agents.ts`),
 * а цикл прогона — в `service.ts`; здесь только разбор аргументов и текст ответа.
 * Поэтому эти инструменты проверяются без модели и без окна.
 */

/** Номера всех известных агентов: по ним разбираются аргументы вызовов. */
function knownAgentIds(ctx: ToolContext): string[] {
  return (ctx.agents?.list() ?? []).map((agent) => agent.id);
}

/** Агент в фоне: запустить и отдать номер. Отчёт заберут `agents` с `action: "wait"` или человек. */
async function spawnAgent(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.subagent?.spawn) return { ok: false, summary: 'Агенты в фоне недоступны' };
  const request = parseSpawnRequest(args);
  if (request.error) return { ok: false, summary: 'Не задано задание', detail: request.error };
  return ctx.subagent.spawn({ description: request.description, prompt: request.prompt });
}

/** Кто работает и чем занят. */
function listAgents(ctx: ToolContext): ToolOutcome {
  if (!ctx.agents) return { ok: false, summary: 'Реестр агентов недоступен' };
  const agents = ctx.agents.list();
  const running = agents.filter((agent) => agent.status === 'running').length;
  return {
    ok: true,
    summary: agents.length === 0 ? 'агентов нет' : `агентов: ${agents.length}, работают: ${running}`,
    detail: formatAgentList(agents),
  };
}

/** Дождаться агентов и отдать отчёты. */
async function waitAgents(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.agents) return { ok: false, summary: 'Реестр агентов недоступен' };
  const request = parseWaitRequest(args, knownAgentIds(ctx));
  if (request.error) return { ok: false, summary: 'Не указан агент', detail: request.error };
  const ids = request.ids.slice(0, 5);
  const result = await ctx.agents.wait(ids, request.timeoutMs);
  const outcomes: AgentWaitOutcome[] = result.agents.map((agent) => ({
    agent,
    report: result.reports.get(agent.id) ?? null,
  }));
  const ready = outcomes.filter((outcome) => outcome.report !== null).length;
  return {
    ok: true,
    summary:
      outcomes.length === 0
        ? 'таких агентов нет'
        : ready === outcomes.length
          ? `отчётов: ${ready}`
          : `отчётов: ${ready}, ещё идут: ${outcomes.length - ready}`,
    detail: formatAgentWaits(outcomes, result.timedOut),
  };
}

/** Сказать агенту по делу: сообщение доедет перед его шагом. */
function sendToAgent(ctx: ToolContext, args: Record<string, unknown>, from: AgentMessageFrom): ToolOutcome {
  if (!ctx.agents) return { ok: false, summary: 'Реестр агентов недоступен' };
  const request = parseMessageRequest(args, knownAgentIds(ctx));
  if (request.error) return { ok: false, summary: 'Сообщение не отправлено', detail: request.error };
  const sent = ctx.agents.send(request.id!, request.text, from);
  if (!sent.ok) return { ok: false, summary: 'Сообщение не доставлено', detail: sent.reason };
  return { ok: true, summary: `сообщение агенту ${request.id} отправлено` };
}

/** Остановить одного агента, не трогая остальных. */
function interruptAgent(ctx: ToolContext, args: Record<string, unknown>, by: AgentStopReason): ToolOutcome {
  if (!ctx.agents) return { ok: false, summary: 'Реестр агентов недоступен' };
  const request = parseInterruptRequest(args, knownAgentIds(ctx));
  if (request.error) return { ok: false, summary: 'Агент не остановлен', detail: request.error };
  if (!ctx.agents.interrupt(request.id!, by)) {
    return {
      ok: false,
      summary: 'Агент уже не работает',
      detail: 'Останавливать нечего: агент уже закончил. Его отчёт читается через agents с action: "wait".',
    };
  }
  return { ok: true, summary: `агент ${request.id} остановлен` };
}

/**
 * Живые агенты одним инструментом с `action`.
 *
 * Пять отдельных имён (`spawn_agent` и четыре спутника) стоили пяти схем в каждом
 * запросе, а различались только первой
 * строкой описания. Разбор аргументов остался в прежних функциях — здесь только
 * выбор по действию, проверка обязательных полей и отказ на незнакомое.
 *
 * Ждущий агент не занимает прогон: `wait` блокирует только этот шаг, и таймаут — не
 * ошибка, а «ещё работают» (об этом говорит сам ответ).
 */
async function agentsAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'spawn':
      return missingForAction(args, ['prompt']) ?? (await spawnAgent(ctx, args));
    case 'list':
      return listAgents(ctx);
    case 'wait':
      return await waitAgents(ctx, args);
    case 'send':
      return missingForAction(args, ['id', 'text']) ?? sendToAgent(ctx, args, 'agent');
    case 'interrupt':
      return missingForAction(args, ['id']) ?? interruptAgent(ctx, args, 'model');
    default:
      return {
        ok: false,
        summary: `Неизвестное действие с агентами: ${action}`,
        detail: 'Допустимые: spawn, list, wait, send, interrupt.',
      };
  }
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
  if (!ctx.confirmBrowser) return { ok: false, summary: 'Браузер недоступен: окно редактора не подключено' };
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
 * Отказ, если для действия не хватает аргументов.
 *
 * Схема сверяет только поля, общие для всех действий (`action`), а `url` нужен
 * одному `open`, `ref` — `click`. Проверяем до обработчика: ответ называет место,
 * как и у остальных инструментов, а не «не задан аргумент» из глубины.
 */
function missingForAction(args: Record<string, unknown>, keys: readonly string[]): ToolOutcome | null {
  for (const key of keys) {
    const value = args[key];
    // `git_write` называет списком не только строки: `paths` — массив, и пустой
    // массив значит «аргумента нет», а не «проиндексировать всё».
    // Элемент массива — не всегда строка: у `edit` это объект (`patches[]`,
    // `edits[]`), и он тоже считается аргументом, иначе вызов с готовым
    // аргументом получал бы «нужен аргумент patches».
    const present = Array.isArray(value)
      ? value.some((item) =>
          typeof item === 'string' ? item.trim().length > 0 : typeof item === 'object' && item !== null,
        )
      : typeof value === 'string' && value.trim().length > 0;
    if (!present) {
      return {
        ok: false,
        summary: `Действию «${String(args.action)}» нужен аргумент «${key}»`,
        detail: `${String(args.action)} требует: ${keys.join(', ')}.`,
      };
    }
  }
  return null;
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
  if (!result.ok) return { ok: false, summary: result.reason ?? 'не удалось изменить масштаб' };
  const percent = Math.round((result.zoom ?? 1) * 100);
  return { ok: true, summary: `масштаб ${percent}%`, detail: `Страница показана с масштабом ${percent}%.` };
}

async function browserClose(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.browser) return { ok: false, summary: 'Браузер недоступен' };
  // Сессии нет — закрывать нечего: «браузер закрыт» здесь звучало бы как отчёт
  // о сделанном, хотя браузера ещё не было.
  if (ctx.browser.running === false) {
    return { ok: true, summary: 'браузер не запущен', detail: 'Сессии браузера нет — закрывать нечего.' };
  }
  await ctx.browser.close();
  return { ok: true, summary: 'браузер закрыт', detail: 'Процесс браузера остановлен, временный профиль удалён.' };
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

/**
 * Одно имя на один файл и на пачку.
 *
 * Различие только в кратности (`path` против `paths`), а две схемы стоили 234
 * токена. Дальше — прежние функции: у каждой свой разбор и свои потолки.
 */
async function readAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (Array.isArray(args.paths)) return await readFiles(ctx, args);
  if (isAbsent(args.path)) {
    return {
      ok: false,
      summary: 'Не сказано, что читать',
      detail: 'Нужен `path` для одного файла (можно с startLine/endLine) или `paths` — список из 2–5 файлов.',
    };
  }
  return await readFile(ctx, args);
}

async function listDir(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const requested = optionalString(args, 'path') ?? workspace.rootPath();
  if (!requested) return { ok: false, summary: 'Проект не открыт' };

  const root = workspace.rootPath();
  const entries = await workspace.readDir(requested);
  const shown = entries.slice(0, MAX_DIR_ENTRIES);
  const lines = shown.map((entry) => `${describe(entry, root)}`);
  if (entries.length > shown.length) lines.push(`… ещё ${entries.length - shown.length} записей`);

  return {
    ok: true,
    summary: `${relative(requested, root)}: ${entries.length} записей`,
    detail: lines.length ? lines.join('\n') : '(пусто)',
  };
}

/**
 * Строки с номерами — в том виде, в каком их видит модель: номер, черта, текст.
 * Один и тот же вид у диапазонного чтения и у головы длинного файла: номера
 * должны годиться в правку по позициям без пересчёта.
 */
function numberedLines(lines: readonly string[], from: number): string {
  // Без выравнивания: `padStart` добавляет пробелы к каждой строке файла, а
  // модель читает числа, а не колонку. На двух тысячах строк это около 4 000
  // символов на один вызов — больше, чем весит иное оглавление.
  return lines.map((line, index) => `${from + index} | ${line}`).join('\n');
}

/**
 * Оглавление длинного файла от языкового сервера: объявления с номерами строк.
 * Нет сервера или он не разобрал — пустая строка: голова файла всё равно полезна,
 * а выдумывать оглавление нельзя.
 */
async function fileOutlineText(ctx: ToolContext, target: string, text: string): Promise<string> {
  const symbols = ctx.symbols;
  if (!symbols?.outline) return '';
  const language = symbols.languageFor?.(target);
  if (!language) return '';
  try {
    const outline = await symbols.outline(target, language, text);
    if (!outline || outline.length === 0) return '';
    return formatOutline(relative(target, ctx.workspace.rootPath()), outline, {
      totalLines: text.length === 0 ? 0 : text.split('\n').length,
    }).detail;
  } catch {
    // Сервер не ответил — это не повод отказывать в чтении.
    return '';
  }
}

async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { workspace } = ctx;
  const target = requireString(args, 'path');
  const content = await workspace.readFile(target);
  const rel = relative(target, workspace.rootPath());
  // Бинарный файл в utf8 — это мусор, который зря жжёт контекст и ничего не
  // объясняет. Отказываем словами (тот же нулевой байт, по которому поиск
  // отличает бинарное от текстового).
  if (isBinary(content.text)) {
    return {
      ok: false,
      summary: `${rel}: бинарный файл`,
      detail: 'Это не текстовый файл — читать его бессмысленно. Если нужны метаданные, используй list.',
    };
  }
  const allLines = content.text.length === 0 ? [] : content.text.split('\n');
  const total = allLines.length;

  // Границы диапазона. Число строки приходит и строкой («2» — модели шлют и так),
  // и тогда его надо принять. А вот если значение ПРИШЛО и не разбирается (2.5, «abc»),
  // молчать нельзя: отбрасывание аргумента читало бы весь файл вместо запрошенного
  // куска — лишний расход контекста и ответ не про то, что просили.
  const startLine = integerArg(args.startLine);
  const endLine = integerArg(args.endLine);
  if (startLine === undefined && !isAbsent(args.startLine)) {
    throw new Error(`startLine: нужен целый номер строки, получено ${describeValue(args.startLine)}`);
  }
  if (endLine === undefined && !isAbsent(args.endLine)) {
    throw new Error(`endLine: нужен целый номер строки, получено ${describeValue(args.endLine)}`);
  }

  // Без диапазона: небольшой файл — целиком, длинный — головой и оглавлением.
  // Отдать 60 000 символов начала длинного файла — это ~15 000 токенов вслепую:
  // конец всё равно не виден, а модель просит диапазоны наугад.
  if (startLine === undefined && endLine === undefined) {
    if (total > WHOLE_FILE_MAX_LINES) {
      const head = allLines.slice(0, LONG_FILE_HEAD_LINES);
      const outline = await fileOutlineText(ctx, target, content.text);
      const tail =
        `… (файл длинный: строк всего ${total}, показаны первые ${head.length}). ` +
        `Дальше — read с startLine с ${head.length + 1}` +
        `${outline ? ' или нужный раздел из оглавления выше' : ' или lsp (action: outline)'}.`;
      const body = `${numberedLines(head, 1)}\n\n${outline ? `Оглавление:\n${outline}\n\n` : ''}${tail}`;
      const { text } = clipText(ctx, 'read', body);
      return {
        ok: true,
        summary: `${rel}: ${total} строк, показаны первые ${head.length}`,
        detail: text,
        // Прочитанным считается только показанное: остальное модель не видела.
        read: { path: target, from: 1, to: head.length },
      };
    }
    const { text, truncated } = clipText(ctx, 'read', content.text);
    return {
      ok: true,
      summary: `${rel}: ${total} строк${truncated ? ' (обрезано)' : ''}`,
      detail: text.length ? text : '(пустой файл)',
      ...(truncated || total === 0 ? {} : { read: { path: target, from: 1, to: total } }),
    };
  }

  if (total === 0) {
    return { ok: true, summary: `${rel}: пустой файл`, detail: '(пустой файл)' };
  }

  const from = Math.max(1, startLine ?? 1);
  // Конец за концом файла зажимаем: «3–99999» — это «от третьей строки до конца»,
  // и отказывать тут незачем. А вот начало за концом — другое дело: значит, о файле
  // думают неверно (он короче), и молча отдать пустоту было бы вредно.
  const to = Math.min(total, endLine ?? total);
  if (from > total) {
    return {
      ok: false,
      summary: `${rel}: начало диапазона ${from} за концом файла (в файле строк: ${total})`,
      detail:
        `Строки ${from} нет: файл короче, чем ожидалось (в нём ${total}). ` +
        `Перечитай файл целиком (read без диапазона) или посмотри скелет (lsp, action: outline) ` +
        `и возьми существующий диапазон в пределах 1–${total}.`,
    };
  }
  if (to < from) {
    return {
      ok: false,
      summary: `${rel}: конец диапазона ${to} раньше начала ${from}`,
      detail: 'Поменяй границы местами: startLine — первая строка диапазона, endLine — последняя.',
    };
  }

  // Диапазон тоже ограничиваем: модель может попросить «весь файл» через 1–∞.
  const last = Math.min(to, from + MAX_READ_LINES - 1);
  const slice = allLines.slice(from - 1, last);
  const body = numberedLines(slice, from);
  const clipped = last < to ? `\n… (показаны строки ${from}–${last} из ${to}; продолжай с ${last + 1})` : '';

  // Диапазон тоже режем по символам: 2000 строк по ~40 символов — это ~80 КБ,
  // вчетверо больше общего потолка вывода. Без этого одно чтение диапазона
  // съедало окно модели сильнее, чем чтение целого файла без диапазона.
  const { text: trimmed } = clipText(ctx, 'read', body);
  // Весь запрошенный кусок ушёл целиком — только тогда его можно считать прочитанным.
  const whole = trimmed === body;

  return {
    ok: true,
    summary: `${rel}: строки ${from}–${last} из ${total}`,
    detail: `${trimmed}${clipped}`,
    ...(whole ? { read: { path: target, from, to: last } } : {}),
  };
}

/** Сколько файлов и сколько символов отдаёт `read` за один вызов. */
const MAX_READ_FILES = 10;
/**
 * Общий потолок пачки. Пять файлов по 12 000 символов — это уже 30 000, половина
 * бюджета шага на один вызов. При 60 000 пара больших файлов отдавала около
 * 6 800 токенов за шаг и отбивала у модели охоту читать дальше: дешевле
 * прочитать один, чем всю пачку сразу.
 */
const MAX_READ_FILES_TOTAL_CHARS = 30_000;
/**
 * Потолок на один файл в пачке. Десять файлов за раз инструмент и существует:
 * если каждый отдаёт по 3 000 символов, пачка доходит до общего потолка ровно
 * тогда, когда она ещё полезна. Цена пачки из двух больших файлов — 7 300
 * токенов за вызов (замер), а вопрос обычно решает середина первого файла:
 * остальное дешевле взять `read` с диапазоном по номеру строки.
 */
const READ_FILES_PER_FILE_CHARS = 6_000;

/**
 * Пакетное чтение: 2–5 файлов за один шаг. Каждый файл получает те же номера
 * строк, что и `read`, но общий вывод ограничен — иначе пятёрка больших
 * файлов вытеснит из контекста всё остальное.
 */
async function readFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { workspace } = ctx;
  const raw = args.paths;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Не задан аргумент «paths»: нужен непустой массив путей');
  }
  const paths = raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (paths.length === 0) throw new Error('В «paths» нет ни одного корректного пути');
  if (paths.length > MAX_READ_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${paths.length} (максимум ${MAX_READ_FILES})`);
  }

  const root = workspace.rootPath();
  const parts: string[] = [];
  const failed: string[] = [];
  let total = 0;
  let read = 0;

  for (const target of paths) {
    const rel = relative(target, root);
    if (total >= MAX_READ_FILES_TOTAL_CHARS) {
      parts.push(`### ${rel}\n… (пропущен: общий лимит вывода исчерпан)`);
      continue;
    }
    try {
      const content = await workspace.readFile(target);
      if (isBinary(content.text)) {
        failed.push(`${rel}: бинарный файл`);
        continue;
      }
      const lines = content.text.length === 0 ? [] : content.text.split('\n');
      // Потолок на файл режем по границе строки, а не посередине: обрывок
      // строки в правку не годится, а по номеру последней видно, откуда читать
      // дальше. Полный текст не пропадает — адрес назван в пометке.
      let shown = lines.length;
      let cut = false;
      let body = lines.map((line, index) => `${index + 1} | ${line}`).join('\n');
      if (body.length > READ_FILES_PER_FILE_CHARS) {
        cut = true;
        shown = 1;
        let size = 0;
        for (let index = 0; index < lines.length; index += 1) {
          size += lines[index]!.length + 3;
          if (size > READ_FILES_PER_FILE_CHARS) break;
          shown = index + 1;
        }
        body = lines
          .slice(0, shown)
          .map((line, index) => `${index + 1} | ${line}`)
          .join('\n');
      }
      const { text, truncated } = clipText(ctx, 'read', body);
      const rest = cut ? `\n… (показаны строки 1–${shown} из ${lines.length} — дальше read с диапазоном)` : '';
      const marks = [truncated ? 'обрезано' : '', cut ? `первые ${shown}` : ''].filter(Boolean);
      const chunk = `### ${rel} (${lines.length} строк${marks.length ? `, ${marks.join(', ')}` : ''})\n${text || '(пустой файл)'}${rest}`;
      parts.push(chunk);
      total += chunk.length;
      read += 1;
    } catch (error) {
      failed.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const failure of failed) parts.push(`### ошибка\n${failure}`);

  const summaryParts = [`прочитано файлов: ${read}`];
  if (failed.length > 0) summaryParts.push(`ошибок: ${failed.length}`);
  if (total >= MAX_READ_FILES_TOTAL_CHARS) summaryParts.push('вывод обрезан');

  return {
    ok: failed.length < paths.length,
    summary: summaryParts.join(', '),
    detail: parts.join('\n\n'),
  };
}

/* ── замена по проекту ──────────────────────────────────────────────────── */
/** Сколько файлов показывает сводка замены: остальные — числом. */
const MAX_REPLACE_SUMMARY_FILES = 20;

/**
 * Массовая замена по файлам проекта. Идёт в main, как и остальные файловые
 * операции: логика замены чистая (`shared/replace.ts`) и уже проверена.
 * Изменённые файлы возвращаются в `changes` — панель изменений чата их покажет.
 */
async function replaceInFiles(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const replacement = typeof args.replacement === 'string' ? args.replacement : '';
  const result = await workspace.replace({
    query,
    replacement,
    isRegex: optionalBoolean(args, 'isRegex') ?? false,
    caseSensitive: optionalBoolean(args, 'caseSensitive') ?? false,
    glob: optionalString(args, 'glob'),
  });

  if (result.replaced === 0) {
    return {
      ok: true,
      summary: 'ничего не заменено',
      detail: `Вхождений «${query}» не найдено${args.glob ? ` по маске ${args.glob}` : ''}.`,
    };
  }

  const root = workspace.rootPath();
  const shown = result.files.slice(0, MAX_REPLACE_SUMMARY_FILES);
  const lines = shown.map((file) => relative(file, root));
  if (result.files.length > shown.length) lines.push(`… ещё файлов: ${result.files.length - shown.length}`);

  return {
    ok: true,
    summary: `заменено вхождений: ${result.replaced} · файлов: ${result.files.length}`,
    detail: lines.join('\n'),
    changes: result.files.map((file) => ({ path: file, kind: 'modified' as const, replaced: result.replaced })),
  };
}

/**
 * Поиск одним именем: источники различались только первой строкой описания, а
 * стоили своей схемы каждый. Действие по умолчанию — `text`: так старые вызовы и
 * привычка «искать в проекте» остаются без лишнего слова.
 */
async function searchAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = (optionalString(args, 'action') ?? '').trim() || 'text';
  switch (action) {
    case 'text':
      return await search(ctx, args);
    case 'code':
      return await codebaseSearch(ctx, args);
    case 'docs':
      return await searchDocs(ctx, args);
    case 'sessions':
      return await sessionSearch(ctx, args);
    default:
      return unknownAction(action, 'search: text, code, docs, sessions.');
  }
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
      maxResults: filesOnly ? MAX_FIND_FILES : limit * SEARCH_OVERFETCH,
    },
    ctx.signal,
  );
  const root = workspace.rootPath();

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
      ok: true,
      summary: `совпадения в файлах: ${unique.length}${result.truncated || rest > 0 ? ' (список обрезан)' : ''} · просканировано: ${result.scanned}`,
      detail: files.length ? clipText(ctx, 'search', files.join('\n')).text + tail : 'Ничего не найдено',
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
    ok: true,
    summary: `${limited.hits.length} совпадений${notes.length ? ` (${notes.join(', ')})` : ''} · просканировано файлов: ${result.scanned}`,
    detail: detail.length ? clipText(ctx, 'search', detail).text + tail : 'Ничего не найдено',
  };
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
    return { ok: false, summary: 'Языковой сервер не подключён: скелет файла недоступен' };
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

  const { summary, detail } = formatOutline(rel, symbols, { totalLines: total });
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
    { query: compact, isRegex: false, caseSensitive: false, maxResults: MAX_SEARCH_HITS },
    ctx.signal,
  );
  const files = digestHits(
    hits.hits.map((hit) => ({ path: relativePath(hit.path, root), line: hit.line, text: hit.text })),
    MAX_CODE_FILES,
  );

  const shaped = formatCodeSearch({
    query,
    // Пути — как во всех инструментах: относительно рабочей папки, иначе модель
    // видит длинный абсолютный путь и не понимает, что файл рядом.
    symbols: rankSymbols(found, query, limit).map((symbol) => ({ ...symbol, path: relativePath(symbol.path, root) })),
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
 * Прочитать навык целиком. Каталог (имя и одна строка) агент уже видел в промпте,
 * поэтому здесь — тело и ничего больше.
 *
 * Ошибка возвращается с подсказкой, а не тупиком: модель должна суметь исправить
 * вызов за один шаг — увидев, какие имена вообще есть.
 */
async function readSkill(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.skills) return { ok: false, summary: 'Навыки недоступны' };
  const name = requireString(args, 'name');
  const found = await ctx.skills.read(name);
  if (!found) {
    const known = (await ctx.skills.list()).map((skill) => skill.name);
    return {
      ok: false,
      summary: `Навыка «${name}» нет`,
      detail: known.length > 0 ? `Есть такие: ${known.join(', ')}` : 'В проекте нет ни одного навыка.',
    };
  }
  return { ok: true, summary: `Навык ${found.entry.name}`, detail: found.body };
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
    return { ok: false, summary: 'Языковой сервер не подключён: поиск ссылок недоступен' };
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
    return { ok: false, summary: 'Языковой сервер не подключён: переход к определению недоступен' };
  }

  const root = ctx.workspace.rootPath();
  const pathArg = resolvePathArg(ctx, optionalString(args, 'path'));
  const line = optionalInteger(args, 'line');

  // Позиционный переход: файл и строка с использованием известны — решает сервер.
  if (pathArg && line) {
    if (!ctx.symbols.definition) {
      return { ok: false, summary: 'Языковой сервер не подключён: переход по позиции недоступен' };
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
    return { ok: false, summary: 'Языковой сервер не подключён: переименование символа недоступно' };
  }
  if (!ctx.applyEdits) {
    return { ok: false, summary: 'Правки сейчас недоступны: окно редактора не подключено' };
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
    return { ok: true, summary: `переименовывать нечего: ${target.name}`, detail: 'Сервер не вернул правок.' };
  }

  const files = edits.map((file) => ({ ...file, path: path.resolve(file.path) }));
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
  const report = formatLintReport({ tool: outcome.tool, target, problems: outcome.problems });
  return { ok: true, summary: report.summary, detail: report.detail };
}

/**
 * Запуск тестов проекта: команду (pytest, vitest, jest, `node --test`) собирает
 * main — агент не должен угадывать раннер. Запуск спрашивает подтверждение, как
 * и команда в терминале: тесты выполняют код проекта. Вывод отдаём хвостом — он важнее
 * начала, а падение (упавший тест — код выхода не 0) это результат, а не сбой.
 */
async function runTests(ctx: ToolContext, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const target = optionalString(args, 'target')?.trim();
  if (target) {
    const problem = testTargetProblem(target);
    if (problem) return { ok: false, summary: problem };
  }
  if (!ctx.tests) return { ok: false, summary: 'Запуск тестов недоступен' };
  if (!ctx.confirmCommand) return { ok: false, summary: 'Запуск тестов недоступен: окно редактора не подключено' };

  const resolved = await ctx.tests.command(target);
  if (!resolved) {
    return {
      ok: false,
      summary: 'Тесты проекта не найдены',
      detail:
        'В проекте нет тестов или известного раннера: у Python это pytest с файлами `test_*.py`, ' +
        'у Node — vitest, jest или встроенный `node --test`. Отдельный файл можно запустить через terminal (action run).',
    };
  }

  if (needsConfirmation(ctx, resolved.command)) {
    const allowed = await ctx.confirmCommand(resolved.command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил запуск тестов',
        detail: 'Пользователь не разрешил запустить тесты. Не повторяй вызов — предложи другой ход.',
      };
    }
  }

  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  if (ctx.sandbox && !ctx.sandbox.available) return sandboxUnavailable(ctx.sandbox);
  // Полная копия вывода: ниже остаётся только хвост, а отброшенное начало иначе
  // не достать ничем, кроме повторного запуска — а он даёт уже другой вывод.
  const spillStream = ctx.spillDir ? createSpillStream(ctx.spillDir, 'run_tests') : null;
  const options: RunOptions = spillStream
    ? { signal: ctx.signal, spill: (chunk) => spillStream.write(chunk) }
    : { signal: ctx.signal };
  const result = ctx.sandbox
    ? await ctx.sandbox.run(resolved.command, root, options)
    : await runShellCommand(resolved.command, root, options);
  // Файл оставляем только тогда, когда вывод действительно не поместился в потолок.
  const full = spillStream?.close(result.truncated) ?? null;
  const condensed = foldPassedTests(ctx, 'run_tests', condenseOutput(result.output));
  const output = full ? trimCommandTail(ctx, condensed, full) : clipTail(ctx, 'run_tests', condensed);
  const notes = [result.timedOut ? 'превышено время' : '', result.truncated ? 'вывод обрезан' : ''].filter(Boolean);
  // Ненулевой код — это упавшие тесты, а не ошибка инструмента: ответ ok, но с кодом.
  const passed = result.code === 0 && !result.timedOut;

  return {
    ok: passed,
    summary: `тесты (${resolved.label}): код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `${commandLine(ctx, resolved.command)}\n${output.length ? output : '(пустой вывод)'}${spillNote(full)}`,
  };
}

/**
 * Строка команды для вывода: видно, что именно выполнялось и где. В песочнице
 * это ещё и подсказка человеку, что код шёл в контейнере, а не на его машине.
 */
function commandLine(ctx: ToolContext, command: string, relative = ''): string {
  const where = relative ? ` [${relative}]` : '';
  // Длинную команду не повторяем: она уже есть в вызове выше — модель сама её
  // написала, и человек видит её в карточке. Замер на живом прогоне: в ответах
  // `terminal` эхо команды занимало 34% символов, а heredoc на две тысячи
  // символов возвращался целиком, ничего не сообщая.
  const lines = command.split('\n');
  const shown =
    lines.length === 1 && command.length <= ECHO_COMMAND_CHARS
      ? command
      : `${lines[0]!.slice(0, ECHO_COMMAND_CHARS)}… (команда из ${lines.length} строк)`;
  return ctx.sandbox ? `$ (в ${ctx.sandbox.label})${where} ${shown}` : `$${where} ${shown}`;
}

/**
 * Папка запуска команды: `cwd` из аргументов, иначе корень проекта.
 *
 * Путь проверяется рабочей папкой (`workspace.stat`): запустить команду за
 * пределами проекта не выйдет, а `..` и симлинки границу не обходят. Отдельно
 * возвращается путь относительно корня: он нужен контейнеру, где смонтирован
 * только корень.
 */
async function commandCwd(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ root: string; path: string; relative: string } | null> {
  const root = ctx.workspace.rootPath();
  if (!root) return null;
  const raw = optionalString(args, 'cwd');
  if (!raw) return { root, path: root, relative: '' };
  const stat = await ctx.workspace.stat(raw);
  if (stat.kind !== 'directory') throw new Error(`Аргумент «cwd» — не папка: ${raw}`);
  const relative = relativePath(stat.path, root);
  return { root, path: stat.path, relative: relative === '.' ? '' : relative };
}

/**
 * Команда для контейнера: проекта там только корень, поэтому подпапка — `cd`.
 * Кавычки обязательны: в имени папки может быть пробел, и `sh -c` разберёт его
 * как границу аргумента.
 */
function insideProject(relative: string, command: string): string {
  if (!relative) return command;
  return `cd ${quoteSh(relative)} && ${command}`;
}

/** Строка в одинарных кавычках для `sh -c`: внутри них ничего не раскрывается. */
function quoteSh(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Песочница включена, а движка нет: команду не выполняем и прямо говорим, что на
 * хост она не переключится. Тихий откат был бы худшим исходом — человек считал бы,
 * что чужой код идёт в изоляции, а он шёл бы на его машине.
 */
function sandboxUnavailable(sandbox: SandboxRunner): ToolOutcome {
  return {
    ok: false,
    summary: 'Песочница включена, но движок контейнеров не найден',
    detail:
      `Команды должны идти в ${sandbox.label}, но docker (или podman) в PATH нет. ` +
      'На хост команда НЕ выполняется. Скажи об этом пользователю: пусть установит движок ' +
      'или выключит песочницу в настройках.',
  };
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
    return { ok: false, summary: 'Диагностика недоступна: окно редактора не подключено' };
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
 * Разбор ответа renderer о правках: что применилось, что не удалось и что осталось
 * только в буфере редактора.
 *
 * Последнее важно называть вслух: main читает файлы с диска, и без оговорки агент
 * счёл бы незаписанный текст уже применённым — а ошибку нашёл бы не в правке,
 * а в следующем чтении («текст не тот, что я написал»).
 */
function readEditsOutcome(
  decision: ApplyEditsHostResult,
  label: (file: string) => string,
): { applied: ApplyReport[]; failed: ApplyFailure[]; tail: string; detail: string; ok: boolean } {
  const applied = decision.result?.reports ?? [];
  const failed = decision.result?.failed ?? [];
  const unwritten = decision.unwritten ?? [];
  const lines = [
    ...applied.map((report) => `ok ${label(report.path)}: применено правок — ${report.applied}`),
    ...failed.map((failure) => `ошибка ${label(failure.path)}: ${failure.message}`),
    // Буфер и диск разошлись: правка видна в редакторе, а в файле её нет.
    ...unwritten.map((file) => `буфер ${label(file)}: на диск не записано — правку сохранит человек`),
  ];
  return {
    applied,
    failed,
    tail: unwritten.length > 0 ? `, не записано на диск: ${unwritten.length}` : '',
    detail: lines.join('\n') || 'Правки не применены',
    ok: failed.length === 0,
  };
}

/** Найденные правки: по якорю и по позициям — дальше это два разных моста renderer. */
interface ParsedEdits {
  anchors: PatchFile[];
  positions: FileEdit[];
}

const EDITOR_MISSING: ToolOutcome = {
  ok: false,
  summary: 'Правки сейчас недоступны: окно редактора не подключено',
};

/**
 * `edit` — правка файлов одним инструментом и одной формой входа. Место
 * называется либо якорем (`oldText`: точный фрагмент, единственный в файле),
 * либо четырьмя позициями в стиле LSP; замену несёт `newText`. Адресаций две,
 * потому что первая не может промахнуться, а вторая не требует искать текст
 * вовсе, — но форма входа одна: иначе в каждом запросе ехали бы две схемы.
 *
 * Дальше пути прежние: якоря разрешает renderer (только у него есть текст
 * документа, в том числе несохранённый), позиции применяет документная модель.
 * Ревью, undo и панель изменений у обоих одни и те же.
 */
async function editFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const parsed = parseEdits(args.edits);
  const names = [...parsed.anchors, ...parsed.positions].map((file) => path.basename(file.path));

  const decisions: ApplyEditsHostResult[] = [];
  if (parsed.anchors.length > 0) {
    if (!ctx.applyPatches) return EDITOR_MISSING;
    decisions.push(await ctx.applyPatches(parsed.anchors, ctx.autoApprove === true));
  }
  if (parsed.positions.length > 0) {
    if (!ctx.applyEdits) return EDITOR_MISSING;
    decisions.push(await ctx.applyEdits(parsed.positions, ctx.autoApprove === true));
  }

  if (decisions.some((decision) => decision.rejected)) {
    return {
      ok: false,
      summary: `Пользователь отклонил правки: ${names.join(', ')}`,
      detail: 'Пользователь отклонил правки. Не повторяй этот вызов — предложи другое решение.',
    };
  }

  const merged = mergeDecisions(decisions);
  const outcome = readEditsOutcome(merged, (file) => path.basename(file));
  const unwritten = merged.unwritten?.length ?? 0;

  return {
    ok: outcome.ok,
    summary: `применено файлов: ${outcome.applied.length}${outcome.failed.length ? `, с ошибками: ${outcome.failed.length}` : ''}${outcome.tail}`,
    detail: outcome.detail,
    // Тела правок можно забыть только когда они действительно легли в файлы:
    // отклонённая или оставшаяся в буфере правка модели ещё понадобится.
    ...(outcome.ok && unwritten === 0 ? { applied: true } : {}),
  };
}

/**
 * Разбор аргумента `edit`. Модель — недоверенный источник, поэтому структура
 * проверяется вручную: битая правка дальше в документную модель попасть не
 * должна. Форму выбирает сама правка: все четыре позиции — правка по позициям
 * (`oldText` рядом с ними остаётся сверкой), иначе нужен якорь `oldText`.
 */
function parseEdits(value: unknown): ParsedEdits {
  // Одиночный файл без обёртки в массив — та же правка: ронять вызов из-за
  // лишних квадратных скобок незачем.
  const single = typeof value === 'object' && value !== null && !Array.isArray(value);
  const list: unknown = single ? [value] : value;
  if (!Array.isArray(list)) throw new Error(`Аргумент «edits» должен быть массивом: ${EDITS_SHAPE}`);
  if (list.length === 0) throw new Error('Не передано ни одной правки');
  if (list.length > MAX_EDITED_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${list.length} (максимум ${MAX_EDITED_FILES})`);
  }

  const parsed: ParsedEdits = { anchors: [], positions: [] };
  list.forEach((item, index) => {
    const file = parseEditFile(item, index);
    if (file.anchor) parsed.anchors.push(file.anchor);
    if (file.position) parsed.positions.push(file.position);
  });
  return parsed;
}

/** Правка внутри файла: либо якорь, либо диапазон — вместе они не ходят. */
type EditItem = { anchor: PatchHunk } | { position: TextEdit };

/**
 * Один файл. Якоря и позиции в одном файле — это два разных пути правки (якоря
 * разрешает renderer, позиции применяет документная модель), поэтому файл
 * отдаётся одному из них целиком: смесь чинится разделением вызова.
 */
function parseEditFile(value: unknown, index: number): { anchor?: PatchFile; position?: FileEdit } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`edits[${index}]: ожидался объект — ${EDITS_SHAPE}`);
  }

  const raw = value as Record<string, unknown>;
  const filePath = raw.path;
  // Форму называем прямо: «не задан path» само по себе не говорит, куда его класть.
  // Самая частая ошибка — замена вместо файла: в элементе oldText и newText, а
  // обёртки с путём нет. Об этом и говорим, иначе модель пришлёт то же снова.
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    const hunk = typeof raw.oldText === 'string' || typeof raw.newText === 'string';
    const hint = hunk ? ' В элементе лежат сами замены (oldText/newText), а не файл.' : '';
    throw new Error(`edits[${index}]: не задан path.${hint} ${EDITS_SHAPE}`);
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`edits[${index}].path: нужен абсолютный путь, получено «${filePath}»`);
  }

  const edits = raw.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(`edits[${index}].edits: нужен непустой массив правок. ${EDITS_SHAPE}`);
  }
  if (edits.length > MAX_EDITS_PER_FILE) {
    throw new Error(`edits[${index}].edits: слишком много правок (${edits.length}), максимум ${MAX_EDITS_PER_FILE}`);
  }

  const items = edits.map((edit, editIndex) => parseEditItem(edit, index, editIndex));
  const anchors = items.filter((item): item is { anchor: PatchHunk } => 'anchor' in item);
  const positions = items.filter((item): item is { position: TextEdit } => 'position' in item);

  if (anchors.length > 0 && positions.length > 0) {
    throw new Error(`edits[${index}]: в одном файле и якоря (oldText), и позиции — раздели на два вызова`);
  }
  if (positions.length > 0) {
    const fileEdit: FileEdit = { path: filePath, edits: positions.map((item) => item.position) };
    if (typeof raw.expectedVersion === 'number') fileEdit.expectedVersion = raw.expectedVersion;
    return { position: fileEdit };
  }
  return { anchor: { path: filePath, patches: anchors.map((item) => item.anchor) } };
}

/** Одна правка: `newText` и адрес — якорь или все четыре позиции. */
function parseEditItem(value: unknown, fileIndex: number, editIndex: number): EditItem {
  const where = `edits[${fileIndex}].edits[${editIndex}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: ожидался объект`);
  }

  const raw = value as Record<string, unknown>;
  const newText = raw.newText;
  if (typeof newText !== 'string') throw new Error(`${where}.newText: нужна строка`);

  const oldText = raw.oldText;
  if (oldText !== undefined && typeof oldText !== 'string') throw new Error(`${where}.oldText: нужна строка`);

  const keys = ['startLine', 'startColumn', 'endLine', 'endColumn'] as const;
  const given = keys.filter((key) => raw[key] !== undefined);
  if (given.length === keys.length) {
    const edit: TextEdit = {
      startLine: editPosition(raw, 'startLine', where),
      startColumn: editPosition(raw, 'startColumn', where),
      endLine: editPosition(raw, 'endLine', where),
      endColumn: editPosition(raw, 'endColumn', where),
      newText,
    };
    // Якорь рядом с позициями — сверка, а не адрес: промах по номеру строки
    // тогда просто не пройдёт.
    if (typeof oldText === 'string') edit.oldText = oldText;
    return { position: edit };
  }
  if (given.length > 0) {
    throw new Error(`${where}: позиции заданы не все — нужны startLine, startColumn, endLine, endColumn`);
  }
  if (typeof oldText !== 'string' || oldText.length === 0) {
    throw new Error(`${where}: нужен oldText (якорь) или все четыре позиции. ${EDITS_SHAPE}`);
  }
  return { anchor: { oldText, newText } };
}

/** Позиция правки: целое число ≥ 1, как в LSP. */
function editPosition(raw: Record<string, unknown>, key: string, where: string): number {
  const number = raw[key];
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    throw new Error(`${where}.${key}: нужно целое число ≥ 1`);
  }
  return number;
}

/** Ответы двух мостов — один: отчёт о файлах складывается, «не записано» тоже. */
function mergeDecisions(decisions: readonly ApplyEditsHostResult[]): ApplyEditsHostResult {
  const [only] = decisions;
  if (decisions.length === 1 && only) return only;
  return {
    rejected: decisions.some((decision) => decision.rejected),
    result: {
      reports: decisions.flatMap((decision) => decision.result?.reports ?? []),
      failed: decisions.flatMap((decision) => decision.result?.failed ?? []),
    },
    unwritten: decisions.flatMap((decision) => decision.unwritten ?? []),
  };
}

/* ── запуск команд ──────────────────────────────────────────────────────── */

/**
 * Команда в проекте — единственное, что меняет систему за пределами документов,
 * поэтому она всегда идёт через подтверждение. `background: true` — та же команда,
 * но шаг она не держит: возвращается номер задания, а вывод читается действием
 * `output`. Раньше это были три имени (`run_terminal`, `run_output`, `run_stop`),
 * и каждое стоило своей схемы в каждом запросе.
 */
async function terminalRun(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  return optionalBoolean(args, 'background') === true
    ? await terminalRunBackground(ctx, args)
    : await terminalRunForeground(ctx, args);
}

/**
 * Отпускать ли текст команды из истории после исполнения.
 *
 * Только у успешной и только у длинной: короткую модель перепишет по памяти, а
 * у упавшей текст нужен целиком — по нему правят и её запускают заново. Порог
 * в четыреста символов: heredoc на две тысячи в живом прогоне давал 40 663
 * символа аргументов из 56 658 — треть всей истории.
 */
function didWork(result: { code: number | null; timedOut?: boolean }, command: string): boolean {
  if (result.code !== 0 || result.timedOut) return false;
  return command.length >= 400 || command.includes('\n');
}

/** Обычный запуск: шаг ждёт команду и возвращает её вывод. */
async function terminalRunForeground(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const command = requireString(args, 'command').trim();
  if (command.length > MAX_COMMAND_CHARS) {
    // Не только «нельзя», но и «как надо»: замер на живом прогоне дал пять
    // потерянных шагов на heredoc, каждый — заново написанный текст. Длинная
    // логика должна жить в файле, а не в команде.
    throw new Error(
      `Команда длиннее ${MAX_COMMAND_CHARS} символов (${command.length}): такое не проходит ` +
        'через терминал. Положи текст в файл инструментом `file` (action create) или `edit` и запусти файл — ' +
        'или сократи команду.',
    );
  }
  // Предел времени — необязательный аргумент: у большинства команд хватает
  // значения по умолчанию, а заведомо долгой (сборка, установка) нужно больше.
  const timeoutSeconds = optionalInteger(args, 'timeout');
  const timeoutMs = timeoutSeconds !== undefined ? Math.min(Math.max(timeoutSeconds, 1), 1800) * 1000 : undefined;
  const runOptions = { signal: ctx.signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  const cwd = await commandCwd(ctx, args);
  if (!cwd) return { ok: false, summary: 'Проект не открыт' };

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  const refusal = await confirmRun(ctx, command);
  if (refusal) return refusal;

  if (ctx.sandbox && !ctx.sandbox.available) return sandboxUnavailable(ctx.sandbox);
  // В песочнице та же команда идёт в контейнер: агент об этом не просит отдельно,
  // режим задаёт человек настройкой.
  const spillStream = ctx.spillDir ? createSpillStream(ctx.spillDir, 'terminal') : null;
  const options: RunOptions = spillStream ? { ...runOptions, spill: (chunk) => spillStream.write(chunk) } : runOptions;
  // В песочнице монтируется только корень проекта, поэтому подпапка — это `cd`
  // внутри контейнера, а не второй том.
  const result = ctx.sandbox
    ? await ctx.sandbox.run(insideProject(cwd.relative, command), cwd.root, options)
    : await runShellCommand(command, cwd.path, options);
  // Файл оставляем только тогда, когда вывод действительно не поместился в потолок.
  const full = spillStream?.close(result.truncated) ?? null;
  // Причёсываем и держим хвост: один `npm install` иначе завалит контекст логом.
  const condensed = foldPassedTests(ctx, 'terminal', condenseOutput(result.output));
  const output = full ? trimCommandTail(ctx, condensed, full) : clipTail(ctx, 'terminal', condensed);
  const notes: string[] = [];
  if (result.timedOut) notes.push('превышено время выполнения');
  if (result.truncated) notes.push('вывод обрезан');

  return {
    ok: result.code === 0 && !result.timedOut,
    summary: `код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `${commandLine(ctx, command, cwd.relative)}\n${output.length ? output : '(пустой вывод)'}${spillNote(full)}`,
    ...(didWork(result, command) ? { applied: true } : {}),
  };
}

/* ── долгие команды: задания ─────────────────────────────────────────────── */

/** Предел времени задания — тот же, что у команды: больше 30 минут незачем. */
const MAX_JOB_TIMEOUT_SECONDS = 1800;

/**
 * Запуск с `background: true` — та же команда, но шаг она не держит.
 *
 * Возвращается номер задания, а не вывод: сборка на пять минут иначе держала бы
 * агента всё это время, и он не мог бы даже сказать, что там происходит. Вывод
 * читается действием `output`.
 */
async function terminalRunBackground(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };

  const command = requireString(args, 'command').trim();
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }
  const timeoutSeconds = optionalInteger(args, 'timeout');
  const cwd = await commandCwd(ctx, args);
  if (!cwd) return { ok: false, summary: 'Проект не открыт' };

  // Подтверждение то же, что у обычного запуска: команда есть команда, и то, что
  // она уходит в фон, ничего не смягчает.
  const refusal = await confirmRun(ctx, command);
  if (refusal) return refusal;

  // Задание — это процесс на хосте. В песочнице контейнер живёт на время команды,
  // и «фон» в нём пришлось бы держать открытым, поэтому честно отказываем.
  if (ctx.sandbox) {
    return {
      ok: false,
      summary: 'В песочнице фоновая команда не поддерживается',
      detail:
        `Песочница включена (${ctx.sandbox.label}), а контейнер живёт ровно на время команды. ` +
        'Запусти команду через terminal (action run) без background и с бо́льшим пределом времени либо выключи песочницу.',
    };
  }

  const limitMs =
    timeoutSeconds !== undefined ? Math.min(Math.max(timeoutSeconds, 1), MAX_JOB_TIMEOUT_SECONDS) * 1000 : undefined;

  let job: JobHandle;
  try {
    job = ctx.jobs.start({
      command,
      cwd: cwd.path,
      ...(ctx.spillDir ? { spillDir: ctx.spillDir } : {}),
      ...(limitMs !== undefined ? { timeoutMs: limitMs } : {}),
    });
  } catch (error) {
    return { ok: false, summary: error instanceof Error ? error.message : String(error) };
  }

  const snapshot = job.snapshot();
  return {
    ok: true,
    summary: `задание ${snapshot.id}: ${command} (идёт в фоне)`,
    detail: [
      `id: ${snapshot.id}`,
      `команда: ${command}`,
      'состояние: идёт',
      '',
      `Читай вывод через terminal { action: "output", id: "${snapshot.id}" }, снять — action "cancel".`,
      'Не запускай эту же команду второй раз: задание уже работает.',
    ].join('\n'),
  };
}

/** Строка о состоянии задания: что с ним и чем кончилось. */
function jobState(snapshot: JobSnapshot): string {
  if (snapshot.status === 'running') return 'идёт';
  if (snapshot.status === 'stopping') return 'останавливается';
  const code = snapshot.code ?? '—';
  const notes: string[] = [];
  if (snapshot.timedOut) notes.push('превышено время');
  if (snapshot.signal) notes.push(`сигнал ${snapshot.signal}`);
  return `${snapshot.status === 'completed' ? 'готово' : 'упало'}, код ${code}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * `output` — состояние задания и новый вывод. Без `id` — список заданий:
 * чтобы не гадать, что вообще запущено, после перезапуска хода.
 */
function terminalOutput(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };

  const id = optionalString(args, 'id')?.trim();
  if (!id) {
    const all = ctx.jobs.list();
    if (all.length === 0) return { ok: true, summary: 'заданий нет', detail: 'Ни одного запуска в фоне не было.' };
    const lines = all.map((snapshot) => `${snapshot.id}: ${jobState(snapshot)} — ${snapshot.command}`);
    return { ok: true, summary: `заданий: ${all.length}`, detail: lines.join('\n') };
  }

  const job = ctx.jobs.get(id);
  if (!job) {
    return {
      ok: false,
      summary: `задание ${id} не найдено`,
      detail:
        'Такого задания нет: номер берётся из ответа terminal с action run и background: true, а завершённые ' +
        'убираются, когда набирается много новых. Запусти команду заново, если результат нужен.',
    };
  }

  const from = optionalInteger(args, 'from');
  const result = job.read(from);
  const snapshot = result.snapshot;
  const output = result.data.length > 0 ? clipTail(ctx, 'terminal', condenseOutput(result.data)) : '';
  // Смещение отдаём всегда: по нему следующее чтение не повторит прочитанное.
  const notes = [`offset: ${result.offset}`, `состояние: ${jobState(snapshot)}`];
  if (snapshot.file) notes.push(`полностью — в файле ${snapshot.file}`);

  const running = snapshot.status === 'running' || snapshot.status === 'stopping';
  return {
    ok: snapshot.status !== 'failed',
    summary: `${snapshot.id}: ${jobState(snapshot)}${output ? ` · нового вывода: ${output.split('\n').length} строк` : ''}`,
    detail: [
      ...notes,
      '',
      output || (running ? '(пока ничего не напечатано)' : '(вывод пуст)'),
      ...(running
        ? [`Потом дочитай: terminal { action: "output", id: "${snapshot.id}", from: ${result.offset} }`]
        : []),
    ].join('\n'),
  };
}

/** `cancel` — снять задание: брошенная сборка продолжает жечь процессор. */
function terminalCancel(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };
  const id = requireString(args, 'id');
  const job = ctx.jobs.get(id);
  if (!job) return { ok: false, summary: `задание ${id} не найдено` };

  const before = job.snapshot();
  if (before.status !== 'running' && before.status !== 'stopping') {
    return {
      ok: true,
      summary: `${id}: уже ${jobState(before)}`,
      detail: 'Останавливать нечего — задание завершилось.',
    };
  }
  job.stop();
  return {
    ok: true,
    summary: `${id}: остановлено`,
    detail: 'Процесс убит вместе с дочерними. Вывод, который успел прийти, можно дочитать действием output.',
  };
}

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
  if (!ctx.mcp) return { ok: false, summary: `Внешний инструмент недоступен: ${exposedName}` };

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
      return { ok: false, summary: 'Внешний вызов требует подтверждения, но окно не подключено' };
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
    const page = await ctx.webFetch.fetch(url, { signal: ctx.signal, maxChars });
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

/** История коммитов: read-only контекст «что тут менялось». */
async function gitLog(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const limit = Math.min(optionalInteger(args, 'limit') ?? DEFAULT_GIT_LOG, MAX_GIT_LOG);
  const target = optionalString(args, 'path');
  const text = (await ctx.git.logText(limit, target)).trim();

  if (!text) {
    return { ok: true, summary: 'история пуста', detail: 'У репозитория нет коммитов.' };
  }

  const lines = text.split('\n').filter(Boolean);
  return {
    ok: true,
    summary: `коммитов: ${lines.length}${target ? ` по ${path.basename(target)}` : ''}`,
    detail: text,
  };
}

/* ── создание, удаление и перемещение ───────────────────────────────────── */

/** Новый файл. Существующий не перетираем — для этого есть правка. */
async function createFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  // Пустая строка — законное содержимое, а вот ОТСУТСТВИЕ поля — нет: раньше оно
  // тихо превращалось в пустой файл, и инструмент отчитывался «создан (0 строк)».
  // Опечатка в имени поля или потерянный аргумент давали не ошибку, а пустоту.
  if (typeof args.contents !== 'string') {
    throw new Error('Не задан аргумент «contents» (содержимое нового файла)');
  }
  const contents = args.contents;
  const created = await workspace.createFile(target, contents);
  const lines = contents.length === 0 ? 0 : contents.split('\n').length;
  return {
    ok: true,
    summary: `создан ${relative(created, workspace.rootPath())} (${lines} строк)`,
    detail: `Создан файл ${created}.`,
    changes: [{ path: created, kind: 'created', lines }],
    // Содержимое уже в файле: в истории его можно заменить пометкой.
    applied: true,
  };
}

/** Удаление только в корзину: безвозвратное rm из IDE — слишком дорогая ошибка. */
async function deleteFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = requireString(args, 'path');
  await workspace.trash(target);
  return {
    ok: true,
    summary: `в корзину: ${relative(target, workspace.rootPath())}`,
    detail: `Удалено (в корзину): ${target}.`,
    changes: [{ path: target, kind: 'deleted' }],
  };
}

/** Перемещение/переименование. Целевой путь не должен существовать. */
async function moveFile(workspace: WorkspaceService, args: Record<string, unknown>): Promise<ToolOutcome> {
  const from = requireString(args, 'from');
  const to = requireString(args, 'to');
  const moved = await workspace.rename(from, to);
  const root = workspace.rootPath();
  return {
    ok: true,
    summary: `${relative(from, root)} → ${relative(moved, root)}`,
    detail: `Перемещено: ${from} → ${moved}.`,
    changes: [{ path: moved, kind: 'moved', from }],
  };
}

/* ── git ────────────────────────────────────────────────────────────────── */

/** Буква изменения — как в списке git: M, A, D, R, U (новый), ! (конфликт). */
function gitLetter(change: GitStatus['files'][number]['change']): string {
  switch (change) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return 'U';
    case 'conflicted':
      return '!';
    default:
      return '?';
  }
}

const MAX_GIT_FILES = 200;

/* ── git: двенадцать действий под двумя именами ─────────────────────────── */

/**
 * Действия git — одним инструментом, но под двумя именами.
 *
 * Чтение и запись здесь не «два действия одного инструмента», а две степени
 * доверия: от неё зависит, предложить ли инструмент в режиме «План», подзадаче и
 * набору «Только чтение». Один `git` отдал бы `push` набору, который обещает
 * ничего не менять, — поэтому имён два, а действия внутри.
 */
async function gitRead(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'status':
      return await gitStatus(ctx);
    case 'diff':
      return await gitDiff(ctx, args);
    case 'log':
      return await gitLog(ctx, args);
    case 'blame':
      return missingForAction(args, ['path']) ?? (await gitBlame(ctx, args));
    default:
      return {
        ok: false,
        summary: `Неизвестное действие чтения git: ${action}`,
        detail: 'Допустимые: status, diff, log, blame.',
      };
  }
}

async function gitWrite(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'stage':
      return missingForAction(args, ['paths']) ?? (await gitStage(ctx, args));
    case 'unstage':
      return missingForAction(args, ['paths']) ?? (await gitUnstage(ctx, args));
    case 'discard':
      return missingForAction(args, ['paths']) ?? (await gitDiscard(ctx, args));
    case 'commit':
      return missingForAction(args, ['message']) ?? (await gitCommit(ctx, args));
    case 'checkout':
      return missingForAction(args, ['name']) ?? (await gitCheckout(ctx, args));
    case 'fetch':
      return await gitNetwork(ctx, 'fetch');
    case 'pull':
      return await gitNetwork(ctx, 'pull');
    case 'push':
      return await gitPush(ctx, args);
    default:
      return {
        ok: false,
        summary: `Неизвестное действие git: ${action}`,
        detail: 'Допустимые: stage, unstage, commit, checkout, discard, fetch, pull, push.',
      };
  }
}

/** Состояние репозитория: ветка, синхронизация и список изменённых файлов. */
async function gitStatus(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const status = await ctx.git.status();
  const repo = status.repository;
  if (!repo) {
    return { ok: true, summary: 'не git-репозиторий', detail: 'Проект не лежит внутри git-репозитория.' };
  }

  const where = repo.branch
    ? `ветка ${repo.branch}`
    : repo.detached
      ? `отделённый HEAD ${repo.head ?? ''}`.trim()
      : 'репозиторий без коммитов';
  const sync = [repo.ahead > 0 ? `впереди ${repo.ahead}` : '', repo.behind > 0 ? `позади ${repo.behind}` : '']
    .filter(Boolean)
    .join(', ');

  if (status.files.length === 0) {
    return { ok: true, summary: `${where}: изменений нет`, detail: 'Рабочее дерево чистое.' };
  }

  const shown = status.files.slice(0, MAX_GIT_FILES);
  const lines = shown.map(
    (file) => `${gitLetter(file.change)} ${file.staged ? '[индекс]' : '[ ]     '} ${file.relative}`,
  );
  if (status.files.length > shown.length) lines.push(`… ещё файлов: ${status.files.length - shown.length}`);

  return {
    ok: true,
    summary: `${where}: ${status.files.length} изменённых файлов${sync ? ` (${sync})` : ''}`,
    detail: lines.join('\n'),
  };
}

/**
 * Diff в формате git: `+`/`-` строки, как в терминале. Без пути — весь рабочий
 * diff целиком: «покажи, что я наменял» иначе превращалось в перебор файлов по
 * одному, а это вызов и шаг на каждый.
 */
async function gitDiff(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const target = optionalString(args, 'path')?.trim();
  const staged = optionalBoolean(args, 'staged') ?? false;
  const diff = await ctx.git.diffText(target, staged);
  const where = target ? relative(target, ctx.workspace.rootPath()) : 'рабочее дерево';
  const scope = staged ? ' (индекс)' : '';

  if (!diff.trim()) {
    return { ok: true, summary: `${where}: нет изменений${scope}`, detail: 'git не показал различий.' };
  }

  const { text, truncated } = clipText(ctx, 'git diff', diff);
  // Без пути diff бывает большим: сводку строим по числу файлов, а не по одному.
  const files = target ? '' : ` · файлов: ${new Set(diff.matchAll(/^diff --git a\/(.+?) b\//gm)).size}`;
  return {
    ok: true,
    summary: `diff ${where}${scope}${files}${truncated ? ' (обрезано)' : ''}`,
    detail: text,
  };
}

/**
 * Происхождение строк файла: кто, когда и каким коммитом их менял. Отвечает на
 * «почему тут так» — по автору и сообщению коммита часто видно замысел, которого
 * в коде уже нет. Чтение: ничего не меняет. `startLine`/`endLine` сужают вывод.
 */
async function gitBlame(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const target = requireString(args, 'path');
  const startLine = optionalInteger(args, 'startLine');
  const endLine = optionalInteger(args, 'endLine');
  const lines: readonly BlameLine[] = await ctx.git.blame(target, { startLine, endLine });
  const rel = relative(target, ctx.workspace.rootPath());
  const report = formatBlame(rel, lines);
  return { ok: true, summary: report.summary, detail: report.detail };
}

/* ── git: правки репозитория ────────────────────────────────────────────── */

/**
 * Действия git, которые меняют состояние репозитория. В обычном режиме агент
 * спрашивает на каждое; при полном доступе — только на эти: откат теряет работу
 * безвозвратно, переключение ветки переписывает файлы, отправка и вливание
 * затрагивают удалённый репозиторий и чужие коммиты.
 *
 * Имена здесь — действия `git_write` (в вызовах `permitGit`), а не имена
 * инструментов: спрашивать или нет, решает действие, а не инструмент.
 */
const DANGEROUS_GIT_ACTIONS = new Set(['git_discard', 'git_push', 'git_pull', 'git_checkout']);

/** Тот же уговор, что у команд: обычный режим спрашивает всегда, полный — только за опасное. */
function needsGitConfirmation(ctx: ToolContext, name: string): boolean {
  if (!ctx.allowAll) return true;
  return ctx.confirmDangerous === true && DANGEROUS_GIT_ACTIONS.has(name);
}

/** Пути аргумента `paths`, проверенные на принадлежность рабочей папке (без обращения к диску). */
function gitPaths(ctx: ToolContext, args: Record<string, unknown>): string[] {
  const value = args.paths;
  if (!Array.isArray(value)) throw new Error('Не задан аргумент «paths»');
  const root = ctx.workspace.rootPath();
  if (!root) throw new Error('Проект не открыт');

  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    // Относительный путь (как в выводе `git status`) считаем от корня проекта,
    // а не от рабочего каталога main: агенту привычнее пути из своего проекта.
    const absolute = path.isAbsolute(item) ? path.resolve(item) : path.resolve(root, item);
    const rel = path.relative(root, absolute);
    // Граница та же, что у чтения и правок: файл должен лежать внутри проекта.
    // Диск не читаем намеренно — откат бывает и у удалённого файла.
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Путь вне рабочей папки: ${item}`);
    }
    paths.push(absolute);
  }
  if (paths.length === 0) throw new Error('Не задан аргумент «paths»');
  return paths;
}

/**
 * Спросить разрешение на действие git. Нет моста подтверждений — действия git
 * агенту недоступны (такие инструменты и не предлагаются: см. `canRun`).
 */
async function permitGit(ctx: ToolContext, name: string, action: string): Promise<ToolOutcome | null> {
  if (!ctx.confirmGit) return { ok: false, summary: 'Действия git недоступны: окно редактора не подключено' };
  if (!needsGitConfirmation(ctx, name)) return null;
  const allowed = await ctx.confirmGit(action);
  if (allowed) return null;
  return {
    ok: false,
    summary: 'Пользователь отклонил действие git',
    detail: 'Пользователь не разрешил это действие git. Не повторяй его — предложи другой ход.',
  };
}

async function gitStage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };
  const paths = gitPaths(ctx, args);
  const denied = await permitGit(ctx, 'git_stage', `git add ${paths.length} ${pluralFiles(paths.length)}`);
  if (denied) return denied;

  await ctx.git.stage(paths);
  return {
    ok: true,
    summary: `проиндексировано: ${paths.length}`,
    detail: paths.map((target) => relative(target, ctx.workspace.rootPath())).join('\n'),
  };
}

async function gitUnstage(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };
  const paths = gitPaths(ctx, args);
  const denied = await permitGit(ctx, 'git_unstage', `git reset -- ${paths.length} ${pluralFiles(paths.length)}`);
  if (denied) return denied;

  await ctx.git.unstage(paths);
  return {
    ok: true,
    summary: `убрано из индекса: ${paths.length}`,
    detail: paths.map((target) => relative(target, ctx.workspace.rootPath())).join('\n'),
  };
}

async function gitCommit(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const message = requireString(args, 'message').trim();
  const paths = Array.isArray(args.paths) ? gitPaths(ctx, args) : undefined;
  const denied = await permitGit(ctx, 'git_commit', `git commit -m "${message}"`);
  if (denied) return denied;

  const info: GitCommitInfo = await ctx.git.commit(message, paths);
  return { ok: true, summary: `коммит ${info.hash}`, detail: info.summary };
}

async function gitCheckout(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const name = requireString(args, 'name').trim();
  const create = optionalBoolean(args, 'create') ?? false;
  const denied = await permitGit(ctx, 'git_checkout', create ? `git checkout -b ${name}` : `git checkout ${name}`);
  if (denied) return denied;

  const status = await ctx.git.checkout(name, create);
  return {
    ok: true,
    summary: `${create ? 'создана и текущая' : 'текущая'} ветка: ${status.repository?.branch ?? name}`,
    detail: `git ${create ? 'checkout -b' : 'checkout'} ${name}`,
  };
}

async function gitDiscard(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };
  const paths = gitPaths(ctx, args);
  const denied = await permitGit(ctx, 'git_discard', `git restore / вернуть в корзину: ${paths.length}`);
  if (denied) return denied;

  await ctx.git.discard(paths);
  return {
    ok: true,
    summary: `откачено файлов: ${paths.length}`,
    detail: 'Правки отменены: отслеживаемые файлы вернулись к последнему коммиту, новые удалены.',
  };
}

/** Общее для fetch/pull: обе — сетевые операции без пути, разница только в команде. */
async function gitNetwork(ctx: ToolContext, kind: 'fetch' | 'pull'): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };
  const name = kind === 'fetch' ? 'git_fetch' : 'git_pull';
  const denied = await permitGit(ctx, name, `git ${kind}`);
  if (denied) return denied;

  const result: GitNetworkResult = kind === 'fetch' ? await ctx.git.fetch() : await ctx.git.pull();
  return { ok: result.ok, summary: `git ${kind}: ${result.ok ? 'готово' : 'сбой'}`, detail: result.message };
}

async function gitPush(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const setUpstream = optionalBoolean(args, 'setUpstream') ?? false;
  const force = optionalBoolean(args, 'force') ?? false;
  const action = `git push${force ? ' --force-with-lease' : ''}${setUpstream ? ' -u origin' : ''}`;
  const denied = await permitGit(ctx, 'git_push', action);
  if (denied) return denied;

  const result: GitNetworkResult = await ctx.git.push({ setUpstream, force });
  return { ok: result.ok, summary: `git push: ${result.ok ? 'отправлено' : 'сбой'}`, detail: result.message };
}

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
          'Заметок стало слишком много. Убери устаревшие через `mind` (action: "forget"), а затем запиши нужную снова — ' +
          'иначе новая заметка потеряется среди старых.',
      };
    }
    return { ok: false, summary: 'Пустая заметка', detail: 'Передай непустой текст в аргументе `text`.' };
  }

  const where = scope === 'global' ? 'в глобальной памяти' : 'в памяти проекта';
  return {
    ok: true,
    summary: result.added ? 'заметка записана' : 'такая заметка уже есть',
    detail: 'Заметок ' + where + ' теперь: ' + result.notes.length + '.',
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
      detail: 'В этой области нет заметок с «' + query + '». Посмотри список, чтобы уточнить формулировку.',
    };
  }

  return {
    ok: true,
    summary: 'убрано заметок: ' + result.removed,
    detail: 'Осталось заметок: ' + result.notes.length + '.',
  };
}

/**
 * Память одним инструментом: `remember` и `forget` — два глагола об одном
 * хранилище, а стоили двух схем в каждом запросе. Поля у них разные, поэтому
 * схема общая, а недостающее называется до обработчика — как у `git_write`.
 */
async function mindAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'remember':
      return missingForAction(args, ['text']) ?? (await remember(ctx, args));
    case 'forget':
      return missingForAction(args, ['query']) ?? (await forget(ctx, args));
    default:
      return {
        ok: false,
        summary: `Неизвестное действие: ${action}`,
        detail: 'mind: remember, forget.',
      };
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

/** Файлы и папки: создание, перемещение, удаление и замела по проекту меняют диск одинаково. */
async function fileAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  if (action === 'create') return missingForAction(args, ['path']) ?? (await createFile(ctx.workspace, args));
  if (action === 'move') return missingForAction(args, ['from', 'to']) ?? (await moveFile(ctx.workspace, args));
  if (action === 'delete') return missingForAction(args, ['path']) ?? (await deleteFile(ctx.workspace, args));
  if (action === 'replace') {
    return missingForAction(args, ['query']) ?? (await replaceInFiles(ctx.workspace, args));
  }
  return unknownAction(action, 'file: create, move, delete, replace.');
}

/** Ресурсы MCP: каталог и чтение — две половины одного похода. */
async function mcpAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  if (action === 'list') return await listMcpResources(ctx, args);
  if (action === 'read') return missingForAction(args, ['uri']) ?? (await readMcpResource(ctx, args));
  return unknownAction(action, 'mcp: list, read.');
}

/** Незнакомое действие слитого инструмента: ответ называет допустимые. */
function unknownAction(action: string, detail: string): ToolOutcome {
  return { ok: false, summary: `Неизвестное действие: ${action}`, detail };
}

/** «1 файл», «2 файла», «5 файлов» — для подписи действия в подтверждении. */
function pluralFiles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла';
  return 'файлов';
}

/* ── открытие файла в редакторе ─────────────────────────────────────────── */

async function showAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // Показ одним именем: открыть файл и предложить результат кнопками — две
  // стороны одного «вот здесь», а стоили двух схем каждая.
  const action = requireString(args, 'action').trim();
  if (action === 'open') return missingForAction(args, ['path']) ?? (await openFile(ctx, args));
  if (action === 'present') return await presentFiles(ctx, args);
  return unknownAction(action, 'show: open, present.');
}

/** Открывает файл в renderer: вкладка и позиция — дело интерфейса, не ФС. */
async function openFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.openFile) {
    return { ok: false, summary: 'Открытие файла недоступно: окно редактора не подключено' };
  }

  const target = requireString(args, 'path');
  const line = optionalInteger(args, 'line');
  const column = optionalInteger(args, 'column');
  await ctx.openFile(target, line, column);

  const rel = relative(target, ctx.workspace.rootPath());
  return { ok: true, summary: `открыт ${rel}${line ? `:${line}` : ''}`, detail: 'Файл открыт в редакторе.' };
}

/* ── терминальные сессии (pty) ──────────────────────────────────────────── */

/** ANSI-последовательности и возврат каретки модели не нужны: оставляем текст. */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC-титул
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI-цвета и курсор
    .replace(/\r/g, '');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Отменено'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Отменено'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Терминальная сессия — это процесс на хосте: контейнер живёт ровно на время
 * команды, поэтому «интерактивный терминал в песочнице» не бывает. Пока
 * песочница включена, начинать сессию и печатать в неё нельзя — иначе команда
 * уходила бы на машину человека мимо песочницы (команда и команда в фоне этот режим
 * уже соблюдают). Остановить уже запущенную сессию можно: `action: stop` команду
 * не выполняет.
 */
function sandboxRefusesTerminal(ctx: ToolContext): ToolOutcome | null {
  if (!ctx.sandbox) return null;
  return {
    ok: false,
    summary: 'В песочнице терминальная сессия не поддерживается',
    detail:
      `Песочница включена (${ctx.sandbox.label}), а терминальная сессия — процесс на хосте. ` +
      'Запускай команды через terminal (action run; долгие — с background: true): они идут в контейнер.',
  };
}

/** Действия терминала одним инструментом: разбор аргументов — в прежних функциях. */
async function terminalAction(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = requireString(args, 'action').trim();
  switch (action) {
    case 'list':
      return terminalList(ctx);
    case 'start':
      return await terminalStart(ctx, args);
    case 'read':
      return missingForAction(args, ['id']) ?? terminalRead(ctx, args);
    case 'write':
      return missingForAction(args, ['id', 'data']) ?? (await terminalWrite(ctx, args));
    case 'stop':
      return missingForAction(args, ['id']) ?? terminalStop(ctx, args);
    case 'run':
      return missingForAction(args, ['command']) ?? (await terminalRun(ctx, args));
    case 'output':
      return terminalOutput(ctx, args);
    case 'cancel':
      return missingForAction(args, ['id']) ?? terminalCancel(ctx, args);
    default:
      return {
        ok: false,
        summary: `Неизвестное действие терминала: ${action}`,
        detail: 'Допустимые: list, start, read, write, stop, run, output, cancel.',
      };
  }
}

function terminalList(ctx: ToolContext): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const sessions = ctx.terminals.list();
  if (sessions.length === 0) {
    return {
      ok: true,
      summary: 'открытых терминалов нет',
      detail: 'Список пуст. Открой сессию через terminal (action start).',
    };
  }
  const lines = sessions.map((session) => `${session.id} · ${session.shell} · ${session.cwd} (pid ${session.pid})`);
  return { ok: true, summary: `терминалов: ${sessions.length}`, detail: lines.join('\n') };
}

const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 30;
/** Сколько ждём первый вывод после старта/команды, прежде чем вернуть управление. */
const TERMINAL_SETTLE_MS = 700;

async function terminalStart(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const refuses = sandboxRefusesTerminal(ctx);
  if (refuses) return refuses;

  const cwd = await commandCwd(ctx, args);
  const command = optionalString(args, 'command');
  if (command && command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  if (command) {
    const refusal = await confirmRun(ctx, command);
    if (refusal) return refusal;
  }

  const session = await ctx.terminals.create({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS, cwd: cwd?.path });
  if (command) ctx.terminals.write(session.id, `${command}\r`);

  await delay(TERMINAL_SETTLE_MS, ctx.signal);
  const { data, offset, alive } = ctx.terminals.read(session.id, 0);
  // Причёсывание снимает пустые простыни, обрезка держит хвост: у сборки и логов
  // важен последний вывод, а один большой cat иначе съедает всё окно модели.
  const output = clipTail(ctx, 'terminal_start', condenseOutput(stripAnsi(data)));

  return {
    ok: true,
    summary: `сессия ${session.id}${command ? `: ${command}` : ''}`,
    detail: [
      `id: ${session.id}`,
      `cwd: ${session.cwd}`,
      `offset: ${offset}`,
      `alive: ${alive}`,
      '',
      output || '(пока пусто)',
    ].join('\n'),
  };
}

function terminalRead(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  const from = optionalInteger(args, 'from') ?? 0;
  const { data, offset, alive, exitCode } = ctx.terminals.read(id, from);
  // Как в terminal_start: хвост важнее начала, пустые простыни сжимаем.
  const output = clipTail(ctx, 'terminal_read', condenseOutput(stripAnsi(data)));

  return {
    ok: true,
    summary: `${id}: ${output ? `${output.split('\n').length} строк нового вывода` : 'нового вывода нет'}${alive ? '' : ' (процесс завершён)'}`,
    detail: [
      `offset: ${offset}`,
      `alive: ${alive}${exitCode !== undefined ? ` (код ${exitCode})` : ''}`,
      '',
      output || '(нового вывода нет)',
    ].join('\n'),
  };
}

async function terminalWrite(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const refuses = sandboxRefusesTerminal(ctx);
  if (refuses) return refuses;

  const id = requireString(args, 'id');
  const data = requireString(args, 'data');

  // Ввод в терминал может быть чем угодно — страховка ловит необратимое и здесь.
  const refusal = await confirmRun(ctx, data, `[${id}] ${data.replace(/\n/g, '⏎')}`);
  if (refusal) return refusal;

  ctx.terminals.write(id, data);
  return {
    ok: true,
    summary: `отправлено в ${id}`,
    detail: `В сессию ${id} отправлено символов: ${data.length}. Прочитай вывод через terminal (action read).`,
  };
}

function terminalStop(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  ctx.terminals.kill(id);
  return { ok: true, summary: `${id} остановлен`, detail: `Сессия ${id} остановлена.` };
}

/* ── вспомогательное ────────────────────────────────────────────────────── */

function describe(entry: DirEntry, root: string | null): string {
  const suffix = entry.kind === 'directory' ? '/' : '';
  // Размер печатаем только там, где он что-то решает: «(412 Б)» у каждой
  // записи — это шум, который едет в контекст модели в каждом `list` и
  // ничего не сообщает (до 500 записей за вызов). Крупный файл — другое дело:
  // по нему видно, что читать его целиком не стоит.
  const size = entry.kind === 'file' && entry.size >= BIG_FILE_BYTES ? ` (${formatBigSize(entry.size)})` : '';
  // Ссылку видно отдельно: агент должен знать, что путь — не обычная запись, а
  // ссылка (и куда ведёт). Битую помечаем словом: по ней ничего не прочитать.
  const link = entry.symlink ? ` → ${entry.symlink.target}${entry.symlink.broken ? ' (битая)' : ''}` : '';
  return `${relativePath(entry.path, root)}${suffix}${size}${link}`;
}

function relative(target: string, root: string | null): string {
  return relativePath(target, root);
}

/**
 * Путь относительно корня проекта в каноническом виде — прямыми слэшами.
 *
 * Разделитель не оставляем «как есть»: на Windows `path.relative` вернул бы
 * обратные слэши, и один и тот же путь выглядел бы по-разному до и после —
 * в выводе `search`, `list` и в самом проекте (`workspace.ts` уже отдаёт
 * относительные пути POSIX-вида). Путь в ответе модели должен быть один и тот же
 * на любой системе: по нему она ходит в следующие инструменты.
 */
function relativePath(target: string, root: string | null): string {
  if (!root) return target;
  const rel = path.relative(root, target);
  return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
}

/**
 * Свернуть перечисление прошедших тестов, положив полный вывод в файл-копию.
 *
 * Сотни строк `✓ имя теста 3ms` модели не сообщают ничего сверх итоговой строки,
 * но платятся целиком: свежий ответ инструмента не попадает в кеш промпта, в
 * отличие от префикса. Свёрнутое не теряется — адрес копии стоит в пометке.
 * Применяется только там, где рядом есть итог прогона (`looksLikeTestRun`):
 * в произвольном выводе команды строка с `✓` может быть данными.
 */
function foldPassedTests(ctx: ToolContext, kind: string, text: string): string {
  if (!looksLikeTestRun(text)) return text;
  const folded = collapsePassedTests(text);
  if (folded.hidden === 0) return text;
  const file = spill(ctx, kind, text);
  const where = file ? `; ${spillHint(file)}` : '';
  return `${folded.text}\n… (свёрнуто отметок о прошедших: ${folded.hidden}${where})`;
}

/**
 * Причесать вывод процесса. Правила живут в `shared/output-compress.ts` — там же,
 * где сжатие перед отправкой модели (`ai/service.ts`): одному выводу незачем
 * выглядеть по-разному в зависимости от того, кто его получил. Здесь важен ещё и
 * `truncateTail` ниже: у вывода команд хвост информативнее начала.
 */
function condenseOutput(text: string): string {
  return compressToolOutput(text);
}

/**
 * Обрезка с конца: у вывода терминала и команд важнее последние строки — начало
 * (приветствие, старая сборка) модели уже не нужно. Оставляем хвост и говорим,
 * сколько символов отброшено, чтобы она знала, что видит не весь вывод.
 */
function truncateTail(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `… (отброшено символов в начале: ${dropped})\n${text.slice(dropped)}`;
}

/**
 * Хвостовая обрезка вывода команды с учётом бюджета шага. Копия вывода пишется
 * потоком (`spillStream`), поэтому второй файл не нужен — но бюджет шага общий,
 * и команда с мегабайтом лога не должна обходить его только потому, что копию ей
 * сделали заранее.
 */
function trimCommandTail(ctx: ToolContext, text: string, full: string | null): string {
  const room = outputRoom(ctx);
  const tail = text.length <= room ? text : truncateTail(text, room);
  spendRoom(ctx, Math.min(text.length, room));
  return tail.length < text.length && ctx.stepBudget !== undefined && ctx.stepBudget.left <= 0
    ? `… (бюджет вывода на шаг исчерпан${full ? `, ${spillHint(full)}` : ''})\n${tail}`
    : tail;
}

/**
 * Обрезка с копией: отброшенное уходит в файл, модели — путь к нему.
 *
 * Пометка «вывод обрезан» без адреса была тупиком: агент знал, что чего-то не
 * видит, но не мог это достать и перезапускал команду — а второй запуск даёт
 * уже другой вывод. `read` с диапазоном умеет прочитать такой файл, поэтому
 * достаточно назвать путь.
 */
function clipText(ctx: ToolContext, kind: string, text: string): { text: string; truncated: boolean } {
  const room = outputRoom(ctx);
  if (text.length <= room) {
    spendRoom(ctx, text.length);
    return { text, truncated: false };
  }
  const file = spill(ctx, kind, text);
  spendRoom(ctx, room);
  return { text: `${text.slice(0, room)}\n${clipNote(ctx, file, 'вывод обрезан')}`, truncated: true };
}

/** То же для хвостовой обрезки: начало отброшено, но его можно прочитать. */
function clipTail(ctx: ToolContext, kind: string, text: string, limit = MAX_OUTPUT_CHARS): string {
  const room = Math.min(limit, outputRoom(ctx, limit));
  if (text.length <= room) {
    spendRoom(ctx, text.length);
    return text;
  }
  const dropped = text.length - room;
  const file = spill(ctx, kind, text);
  spendRoom(ctx, room);
  const note = file ? `, ${spillHint(file)}` : '';
  const spent = ctx.stepBudget !== undefined && ctx.stepBudget.left <= 0 ? ' — бюджет вывода на шаг исчерпан' : '';
  return `… (отброшено символов в начале: ${dropped}${note}${spent})\n${text.slice(dropped)}`;
}

/**
 * Сколько символов этот вызов может отдать модели: свой предел, но не больше
 * остатка бюджета шага. Без бюджета (проверки, одиночный вызов) — просто предел.
 */
function outputRoom(ctx: ToolContext, wanted = MAX_OUTPUT_CHARS): number {
  if (!ctx.stepBudget) return wanted;
  const left = Math.max(ctx.stepBudget.left, MIN_OUTPUT_CHARS);
  return Math.max(MIN_OUTPUT_CHARS, Math.min(wanted, left));
}

/** Списать отданное из бюджета шага. */
function spendRoom(ctx: ToolContext, chars: number): void {
  if (!ctx.stepBudget) return;
  ctx.stepBudget.left = Math.max(0, ctx.stepBudget.left - chars);
}

/** Пометка «обрезано» с адресом копии и признаком исчерпанного бюджета шага. */
function clipNote(ctx: ToolContext, file: string | null, what: string): string {
  const spent = ctx.stepBudget !== undefined && ctx.stepBudget.left <= 0 ? ' — бюджет вывода на шаг исчерпан' : '';
  return file ? `… (${what}${spent}; ${spillHint(file)})` : `… (${what}${spent})`;
}

/** Положить текст в файл, если каталог задан. Без каталога поведение прежнее. */
function spill(ctx: ToolContext, kind: string, text: string): string | null {
  return ctx.spillDir ? spillText(ctx.spillDir, kind, text) : null;
}

/** Строка о полной копии вывода: дописывается к хвосту команды. */
function spillNote(file: string | null): string {
  return file ? `\n(${spillHint(file)})` : '';
}

/**
 * Бинарный ли это файл. Признак один и тот же по всему проекту — нулевой байт
 * (так же его отличает `search` и кэш содержимого). Декодированный в utf8
 * бинарник превращается в мусор с U+FFFD, и по нему не видно причины.
 */
function isBinary(text: string): boolean {
  return text.includes('\u0000');
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Не задан аргумент «${key}»`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Список строк из аргумента: массив — как есть, одиночная строка — один элемент.
 * Модель иной раз шлёт единственный вариант строкой — терять его из-за этого нельзя.
 * Пустое и нестроковое отбрасываем: битая метка в кнопке хуже её отсутствия.
 */
function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0);
}

/**
 * Необязательный флаг. `"true"` и `1` — тоже «да»: строкой флаг приходит не реже,
 * чем числом (см. `shared/tool-args.ts`), а потерянный флаг меняет смысл вызова —
 * `staged: "true"` без разбора читался бы как обычный diff рабочего дерева.
 */
function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return booleanArg(args[key]);
}

/**
 * Необязательное целое. Число может прийти строкой («2») — модели и провайдеры
 * шлют и так, и терять из-за этого аргумент нельзя: без номера строки инструмент
 * делает не то, что просили. Неразбираемое значение — `undefined`, и дальше
 * каждый инструмент решает сам (там, где промах дорог, — отказывает с текстом).
 */
function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  return integerArg(args[key]);
}

/**
 * `mcp` (action list) — каталог ресурсов MCP: адреса, имена, типы.
 *
 * Ресурс — не действие, а документ: сервер объявляет у себя адреса, и их читают.
 * Каталог отдаём целиком (с потолком внутри `formatMcpResources`): модель иначе
 * придумывает uri по аналогии, а сервер отвечает «нет такого ресурса».
 */
async function listMcpResources(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.mcp) return { ok: false, summary: 'MCP-серверы не подключены' };

  const only = (optionalString(args, 'server') ?? '').trim();
  let all: readonly McpResourceInfo[];
  try {
    all = await ctx.mcp.resources();
  } catch (error) {
    return { ok: false, summary: 'Каталог ресурсов недоступен', detail: describeValue(error) };
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
    return { ok: false, summary: 'Не задан адрес ресурса', detail: 'Инструменту нужен непустой аргумент uri.' };
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
 * `session_search` — что уже обсуждали в прошлых беседах проекта.
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
 * `present` — действие show: объявить готовый результат.
 *
 * Агент и раньше писал «файл готов, он лежит в docs/тз.md», и человек шёл искать
 * его в дереве. Карточка в ленте делает то же самое одним нажатием: путь и кнопка
 * «Открыть». Файл при этом не читается и не меняется — инструмент только объявляет.
 *
 * Проверяем существование: объявить несуществующий файл — это ложь, на которую
 * человек потратит время. Пути идут через `WorkspaceService`, поэтому за пределы
 * проекта карточка не выведет.
 */
async function presentFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const raw = Array.isArray(args.paths) ? args.paths : typeof args.path === 'string' ? [args.path] : [];
  const paths = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (paths.length === 0) {
    return {
      ok: false,
      summary: 'Не указаны файлы',
      detail: 'Инструменту нужен непустой список paths — файлы, которые человек должен открыть.',
    };
  }

  const note = (optionalString(args, 'note') ?? '').trim();
  const presented: ToolPresentedFile[] = [];
  const missing: string[] = [];

  for (const item of paths.slice(0, MAX_PRESENTED_FILES)) {
    try {
      const stat = await ctx.workspace.stat(item);
      if (stat.kind === 'directory') {
        missing.push(`${item} (это папка, а не файл)`);
        continue;
      }
      presented.push({ path: stat.path, ...(note ? { note } : {}) });
    } catch {
      // Файла нет или путь вне проекта: говорим прямо, а не показываем кнопку-обманку.
      missing.push(item);
    }
  }

  const skipped =
    paths.length > MAX_PRESENTED_FILES
      ? ` Ещё ${paths.length - MAX_PRESENTED_FILES} не показаны: потолок ${MAX_PRESENTED_FILES}.`
      : '';
  if (presented.length === 0) {
    return {
      ok: false,
      summary: 'Нечего показать: файлов не нашлось',
      detail:
        `Не нашлись: ${missing.join(', ')}. Проверь пути — объявлять надо существующие файлы внутри проекта.` + skipped,
    };
  }

  const names = presented.map((file) => file.path);
  return {
    ok: true,
    summary: presented.length === 1 ? `результат: ${path.basename(names[0]!)}` : `результатов: ${presented.length}`,
    detail: [
      `Готово, показано человеку в ленте: ${names.join(', ')}`,
      missing.length > 0 ? `Не нашлись (не показаны): ${missing.join(', ')}` : '',
      skipped,
      'Ссылки в тексте ответа не нужны: файлы уже перед человеком кнопками.',
    ]
      .filter(Boolean)
      .join('\n'),
    presented,
  };
}

/** Сколько файлов объявляем за раз: это «вот результат», а не список всего проекта. */
const MAX_PRESENTED_FILES = 8;
