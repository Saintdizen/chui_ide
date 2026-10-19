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
import { formatRunCode, runCodeToolAllowed, type RunCodeOutcome } from '../../shared/run-code';
import type { ApplyFailure, ApplyReport, FileEdit, TextEdit } from '../../shared/edits';
import { parsePatchFiles, type PatchFile } from '../../shared/patch';
import { formatLintReport, type LintOutcome } from '../../shared/lint';
import { formatLocations, type SymbolLocation } from '../../shared/lsp-locations';
import { formatOutline, type FileSymbol } from '../../shared/lsp-symbols';
import { formatMcpResources, isMcpToolName, type McpResourceInfo, type McpToolInfo } from '../../shared/mcp';
import { compressToolOutput } from '../../shared/output-compress';
import type { SkillEntry } from '../../shared/skills';
import { formatProjectMap } from '../../shared/project-map';
import { formatSessionSearch, type SessionSearchReport } from '../../shared/session-search';
import { parseToolArguments } from '../../shared/tools';
import { booleanArg, describeValue, integerArg, isAbsent } from '../../shared/tool-args';
import { scanProject } from '../project/scan';
import type { WorkspaceService } from '../workspace/workspace';
import { runShellCommand, type CommandResult, type RunOptions } from './run-command';
import { createSpillStream, spillHint, spillText } from './spill';
import type { JobHandle, JobRegistry, JobSnapshot } from './jobs';

/**
 * Исполнение инструментов агента.
 *
 * Чтение (list_dir, read_file, search) и запуск команд делаются здесь же:
 * все пути проходят через `WorkspaceService`, а значит ограничены рабочей
 * папкой (включая проверку симлинков). Правки (`apply_edit`) уходят в renderer
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
   * Тела правок этого вызова уже в файле: в истории их можно заменить пометкой
   * (см. `condenseAppliedCalls`). Ставится только там, где запись действительно
   * состоялась — отклонённая правка или правка, оставшаяся в буфере редактора,
   * ещё понадобится модели целиком.
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
 * Веб-поиск для инструмента `web_search`. Настройки, ключ и сеть живут в
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
  /** Найти беседы по словам: разбор и форма ответа — `shared/session-search.ts`. */
  search(query: string): Promise<SessionSearchReport>;
}

export interface WebSearchRunner {
  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ hits: readonly WebSearchHit[]; providerLabel: string }>;
}

/**
 * Чтение страницы по ссылке для инструмента `web_fetch`. Сеть живёт в
 * `ai/web-fetch.ts`, а сюда приходит готовый вызов — тот же уговор, что у `web_search`.
 */
export interface WebFetchRunner {
  fetch(url: string, options?: { signal?: AbortSignal; maxChars?: number }): Promise<FetchedPage>;
}

/**
 * Вызов инструмента изнутри программы `run_code`: что вернуть самой программе.
 * Это те же `ok`, `summary` и текст, что видит модель у обычного вызова, — иначе
 * программе пришлось бы разбирать ещё один формат.
 */
export type RunCallHandler = (name: string, args: unknown) => Promise<{ ok: boolean; summary: string; text: string }>;

/**
 * Программа (`run_code`). Запуск, права и обрыв живут в `ai/run-code.ts`; main же
 * решает, что программа может звать: `onCall` — это тот же `runTool` с тем же
 * контекстом, поэтому подтверждения и запись правок идут обычным путём.
 */
export interface RunCodeRunner {
  run(
    source: string,
    options: { signal?: AbortSignal; timeoutMs?: number; onCall: RunCallHandler },
  ): Promise<RunCodeOutcome>;
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
 * Память проекта для инструментов `remember` и `forget`. Хранилище живёт в main
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
  /** Git рабочей папки: нужен инструментам git_status/git_diff. */
  git?: GitTools;
  /** Открыть файл в редакторе (renderer): нужен инструменту open_file. */
  openFile?(path: string, line?: number, column?: number): Promise<boolean>;
  /** Терминальные сессии (pty): нужны инструментам terminal_*. */
  terminals?: TerminalAgent;
  /** Символы проекта и скелет файла (языковой сервер): codebase_search, file_outline. */
  symbols?: SymbolSearch;
  /** Линтер проекта: нужен инструменту run_linter. */
  linter?: Linter;
  /** Команда запуска тестов: нужна инструменту run_tests. */
  tests?: TestRunner;
  /** Прошлые беседы проекта: нужен инструменту `session_search`. */
  sessions?: SessionSearchRunner;
  /** Память проекта: нужна инструментам remember/forget. */
  memory?: MemoryTools;
  /** Навыки проекта (`.chui/skills`): каталог идёт в промпт, тело — инструментом read_skill. */
  skills?: SkillTools;
  /** Картинки для модели (`read_image`): чтение и уменьшение живут в main (`ai/read-image.ts`). */
  readImage?: ReadImageRunner;
  /** Веб-поиск: подключён только при включённой настройке. */
  webSearch?: WebSearchRunner;
  /** Чтение страницы по ссылке: тоже только при включённой настройке. */
  webFetch?: WebFetchRunner;
  /** Программа вместо десятка вызовов: есть, когда её вообще можно запустить. */
  runCode?: RunCodeRunner;
  /** Внешние инструменты (MCP): есть только при настроенных серверах. */
  mcp?: McpRunner;
  /** Подзадачи (инструмент `task`): запускает service — у него есть провайдер. */
  subagent?: SubagentRunner;
  /** Браузер: подключён только при включённой настройке. */
  browser?: BrowserTools;
  /** Спросить разрешение на действие в браузере (переход, клик, ввод, скрипт). */
  confirmBrowser?(action: string): Promise<boolean>;
  /** Песочница: подключена только при включённой настройке. */
  sandbox?: SandboxRunner;
  /**
   * Задания (`run_background`): долгие команды, которые не держат шаг.
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
   * Предел на вызов этой задаче не отвечает: три `read_file` в одном шаге честно
   * укладываются в свои 60 000 символов каждый и дают 180 000 — контекст уже
   * переполнен, а обрезка срабатывает только следующим шагом и выбрасывает ходы
   * целиком. Поэтому шаг платит из общего бюджета, а исчерпанное называется вслух.
   */
  stepBudget?: { left: number };
}

/** Ограничение вывода: без него один файл на 2 МБ съест весь контекст модели. */
const MAX_OUTPUT_CHARS = 60_000;

/**
 * Сколько символов вывода шаг отдаёт модели всего. Предела на вызов мало: агент
 * читает по три файла за шаг, и это 180 000 символов — половина скромного окна,
 * после чего обрезка истории выбрасывает ходы целиком. Бюджет шага делает цену
 * шага предсказуемой, а `MIN_OUTPUT_CHARS` не даёт инструменту ответить пустотой.
 */
export const STEP_OUTPUT_CHARS = 80_000;

/**
 * Минимум на один вызов, даже когда бюджет шага уже исчерпан. Пустой ответ модель
 * поймёт как «инструмент ничего не вернул» и позовёт его снова; честнее отдать
 * начало (или хвост) с пометкой, что текст лежит в файле.
 */
const MIN_OUTPUT_CHARS = 1_500;
/** Больше этого одной страницы модели не отдаём: даже по просьбе. */
const MAX_FETCH_CHARS = 60_000;
const MAX_SEARCH_HITS = 200;
/** Сколько разделов документации отдаём на один запрос `search_docs`. */
const MAX_DOC_RESULTS = 12;
/**
 * Во сколько раз просим больше совпадений, чем отдадим. Потолок на файл
 * отбирает уже после поиска: без запаса шумный файл занял бы весь список, и
 * других файлов в выдаче не было бы вовсе.
 */
const SEARCH_OVERFETCH = 3;
/** Потолок для режима «только файлы»: там на файл одна строка, поэтому можно больше. */
const MAX_FIND_FILES = 2000;
const MAX_DIR_ENTRIES = 500;
/** Сколько строк отдаёт read_file за один диапазонный вызов. */
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

/** Форма аргумента `apply_edit`: её называем в ошибках, чтобы вызов чинился за один шаг. */
const EDITS_SHAPE =
  'нужен [{ path: "/абсолютный/путь/файл", edits: [{ startLine, startColumn, endLine, endColumn, newText }] }]';

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

export async function runTool(ctx: ToolContext, name: string, rawArguments: string): Promise<ToolOutcome> {
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return { ok: false, summary: parsed.message };

  try {
    // Внешние инструменты (MCP) идут мимо оператора `switch`: их имена приходят
    // из настроек и заранее неизвестны.
    if (isMcpToolName(name)) return await runExternalTool(ctx, name, parsed.value);

    switch (name) {
      case 'list_dir':
        return await listDir(ctx.workspace, parsed.value);
      case 'read_file':
        return await readFile(ctx, parsed.value);
      case 'read_files':
        return await readFiles(ctx, parsed.value);
      case 'search':
        return await search(ctx, parsed.value);
      case 'codebase_search':
        return await codebaseSearch(ctx, parsed.value);
      case 'search_docs':
        return await searchDocs(ctx, parsed.value);
      case 'session_search':
        return await sessionSearch(ctx, parsed.value);
      case 'read_skill':
        return await readSkill(ctx, parsed.value);
      case 'read_image':
        return await readImage(ctx, parsed.value);
      case 'find_references':
        return await findReferences(ctx, parsed.value);
      case 'go_to_definition':
        return await goToDefinition(ctx, parsed.value);
      case 'rename_symbol':
        return await renameSymbol(ctx, parsed.value);
      case 'file_outline':
        return await fileOutline(ctx, parsed.value);
      case 'run_linter':
        return await runLinter(ctx, parsed.value);
      case 'run_tests':
        return await runTests(ctx, parsed.value);
      case 'project_map':
        return await projectMap(ctx.workspace);
      case 'find_files':
        return await findFiles(ctx, parsed.value);
      case 'get_diagnostics':
        return await diagnostics(ctx, parsed.value);
      case 'apply_edit':
        return await applyEdit(ctx, parsed.value);
      case 'apply_patch':
        return await applyPatch(ctx, parsed.value);
      case 'replace_in_files':
        return await replaceInFiles(ctx.workspace, parsed.value);
      case 'run_terminal':
        return await runTerminal(ctx, parsed.value);
      case 'run_background':
        return await runBackground(ctx, parsed.value);
      case 'run_output':
        return runOutput(ctx, parsed.value);
      case 'run_stop':
        return runStop(ctx, parsed.value);
      case 'web_search':
        return await webSearch(ctx, parsed.value);
      case 'web_fetch':
        return await webFetch(ctx, parsed.value);
      case 'run_code':
        return await runCodeProgram(ctx, parsed.value);
      case 'create_file':
        return await createFile(ctx.workspace, parsed.value);
      case 'delete_file':
        return await deleteFile(ctx.workspace, parsed.value);
      case 'move_file':
        return await moveFile(ctx.workspace, parsed.value);
      case 'update_plan':
        // План не исполняется здесь: его показывает service отдельным событием.
        return { ok: true, summary: 'план обновлён' };
      case 'update_goal':
        // Цель — состояние беседы, а не действие: её разбирает service, чтобы
        // закрытие цели и продолжение прогона шли одним путём.
        return { ok: true, summary: 'цель обновлена' };
      case 'ask':
        return await ask(ctx, parsed.value);
      case 'task':
        return await task(ctx, parsed.value);
      case 'list_mcp_resources':
        return await listMcpResources(ctx, parsed.value);
      case 'read_mcp_resource':
        return await readMcpResource(ctx, parsed.value);
      case 'browser_open':
        return await browserOpen(ctx, parsed.value);
      case 'browser_snapshot':
        return await browserSnapshot(ctx);
      case 'browser_click':
        return await browserClick(ctx, parsed.value);
      case 'browser_type':
        return await browserType(ctx, parsed.value);
      case 'browser_evaluate':
        return await browserEvaluate(ctx, parsed.value);
      case 'browser_zoom':
        return await browserZoom(ctx, parsed.value);
      case 'browser_close':
        return await browserClose(ctx);
      case 'remember':
        return await remember(ctx, parsed.value);
      case 'forget':
        return await forget(ctx, parsed.value);
      case 'git_status':
        return await gitStatus(ctx);
      case 'git_diff':
        return await gitDiff(ctx, parsed.value);
      case 'git_log':
        return await gitLog(ctx, parsed.value);
      case 'git_blame':
        return await gitBlame(ctx, parsed.value);
      case 'git_stage':
        return await gitStage(ctx, parsed.value);
      case 'git_unstage':
        return await gitUnstage(ctx, parsed.value);
      case 'git_commit':
        return await gitCommit(ctx, parsed.value);
      case 'git_checkout':
        return await gitCheckout(ctx, parsed.value);
      case 'git_discard':
        return await gitDiscard(ctx, parsed.value);
      case 'git_fetch':
        return await gitNetwork(ctx, 'fetch');
      case 'git_pull':
        return await gitNetwork(ctx, 'pull');
      case 'git_push':
        return await gitPush(ctx, parsed.value);
      case 'open_file':
        return await openFile(ctx, parsed.value);
      case 'terminal_list':
        return terminalList(ctx);
      case 'terminal_start':
        return await terminalStart(ctx, parsed.value);
      case 'terminal_read':
        return terminalRead(ctx, parsed.value);
      case 'terminal_write':
        return await terminalWrite(ctx, parsed.value);
      case 'terminal_stop':
        return terminalStop(ctx, parsed.value);
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

  const prompt = requireString(args, 'prompt').trim();
  const description = optionalString(args, 'description')?.trim() || 'подзадача';
  return ctx.subagent.run({ description, prompt });
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
 * должны годиться в `apply_edit` без пересчёта.
 */
function numberedLines(lines: readonly string[], from: number): string {
  const width = String(from + lines.length - 1).length;
  return lines.map((line, index) => `${String(from + index).padStart(width, ' ')} | ${line}`).join('\n');
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
      detail: 'Это не текстовый файл — читать его бессмысленно. Если нужны метаданные, используй list_dir.',
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
        `Дальше — read_file с startLine с ${head.length + 1}` +
        `${outline ? ' или нужный раздел из оглавления выше' : ' или file_outline для оглавления'}.`;
      const body = `${numberedLines(head, 1)}\n\n${outline ? `Оглавление:\n${outline}\n\n` : ''}${tail}`;
      const { text } = clipText(ctx, 'read_file', body);
      return {
        ok: true,
        summary: `${rel}: ${total} строк, показаны первые ${head.length}`,
        detail: text,
        // Прочитанным считается только показанное: остальное модель не видела.
        read: { path: target, from: 1, to: head.length },
      };
    }
    const { text, truncated } = clipText(ctx, 'read_file', content.text);
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
        `Перечитай файл целиком (read_file без диапазона) или посмотри скелет (file_outline) ` +
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
  const { text: trimmed } = clipText(ctx, 'read_file', body);
  // Весь запрошенный кусок ушёл целиком — только тогда его можно считать прочитанным.
  const whole = trimmed === body;

  return {
    ok: true,
    summary: `${rel}: строки ${from}–${last} из ${total}`,
    detail: `${trimmed}${clipped}`,
    ...(whole ? { read: { path: target, from, to: last } } : {}),
  };
}

/** Сколько файлов и сколько символов отдаёт `read_files` за один вызов. */
const MAX_READ_FILES = 10;
const MAX_READ_FILES_TOTAL_CHARS = 60_000;

/**
 * Пакетное чтение: 2–5 файлов за один шаг. Каждый файл получает те же номера
 * строк, что и `read_file`, но общий вывод ограничен — иначе пятёрка больших
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
      const width = String(lines.length).length;
      const body = lines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`).join('\n');
      const { text, truncated } = clipText(ctx, 'read_files', body);
      const chunk = `### ${rel} (${lines.length} строк${truncated ? ', обрезано' : ''})\n${text || '(пустой файл)'}`;
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
      maxResults: filesOnly ? MAX_FIND_FILES : MAX_SEARCH_HITS * SEARCH_OVERFETCH,
    },
    ctx.signal,
  );
  const root = workspace.rootPath();

  // Режим «только файлы»: одна строка на файл, без номера строки и текста.
  if (filesOnly) {
    const files = [...new Set(result.hits.map((hit) => relativePath(hit.path, root)))];
    return {
      ok: true,
      summary: `совпадения в файлах: ${files.length}${result.truncated ? ' (список обрезан)' : ''} · просканировано: ${result.scanned}`,
      detail: files.length ? clipText(ctx, 'search', files.join('\n')).text : 'Ничего не найдено',
    };
  }

  // Потолок на файл: десяток строк из одного места полезнее двухсот, а по числу
  // скрытых видно, что файл шумный, — и модель сузит запрос вместо вывода
  // «больше нигде нет».
  const limited = limitPerFile(result.hits, MAX_HITS_PER_FILE, MAX_SEARCH_HITS);
  const detail = formatSearchHits(limited.hits, root, context);
  const truncated = result.truncated || limited.truncated;
  const notes = [truncated ? 'список обрезан' : '', limited.hidden > 0 ? `на файл до ${MAX_HITS_PER_FILE}` : ''].filter(
    Boolean,
  );

  return {
    ok: true,
    summary: `${limited.hits.length} совпадений${notes.length ? ` (${notes.join(', ')})` : ''} · просканировано файлов: ${result.scanned}`,
    detail: detail.length ? clipText(ctx, 'search', detail).text : 'Ничего не найдено',
  };
}

/**
 * Совпадения поиска в виде текста. Без контекста — по строке на совпадение
 * (`путь:строка:столбец: текст`), с контекстом — блоками, как `grep -C`: строка
 * совпадения помечена `:`, соседние — `-`. Номера строк настоящие, поэтому их
 * сразу можно передать в `read_file` с диапазоном.
 */
function formatSearchHits(hits: readonly SearchHit[], root: string | null, context: number): string {
  if (hits.length === 0) return '';
  if (context <= 0) {
    return hits.map((hit) => `${relativePath(hit.path, root)}:${hit.line}:${hit.column}: ${hit.text}`).join('\n');
  }

  const blocks: string[] = [];
  let lastPath: string | null = null;
  for (const hit of hits) {
    const before = hit.before ?? [];
    const after = hit.after ?? [];
    // Ширину номера берём по самой большой строке блока: колонка цифр не «пляшет».
    const last = hit.line + after.length;
    const width = String(last).length;
    const number = (value: number): string => String(value).padStart(width, ' ');

    const lines = [
      ...before.map((text, index) => `${number(hit.line - before.length + index)}- ${text}`),
      `${number(hit.line)}: ${hit.text}`,
      ...after.map((text, index) => `${number(hit.line + 1 + index)}- ${text}`),
    ];

    // Путь печатаем заголовком один раз на файл: в блоке он повторялся бы в
    // каждой строке и съедал место, которого ради контекста и не хватало.
    const rel = relativePath(hit.path, root);
    blocks.push(rel === lastPath ? lines.join('\n') : `${rel}\n${lines.join('\n')}`);
    lastPath = rel;
  }
  return blocks.join('\n\n');
}

/** Сколько объявлений вернуть по умолчанию и сколько файлов-сводок показать. */
const MAX_CODE_SYMBOLS = 40;
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
        'Устройство файла смотри через search или read_file.',
    };
  }

  const { summary, detail } = formatOutline(rel, symbols, { totalLines: total });
  return { ok: true, summary, detail };
}

async function codebaseSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const limit = Math.min(optionalInteger(args, 'limit') ?? MAX_CODE_SYMBOLS, MAX_CODE_SYMBOLS);
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
 * раздела: тот же путь и та же строка годятся в `read_file`, чтобы дочитать раздел.
 */
async function searchDocs(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = requireString(args, 'query');
  const limit = Math.min(Math.max(optionalInteger(args, 'limit') ?? MAX_DOC_RESULTS, 1), MAX_DOC_RESULTS);
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
        'например «read file») либо посмотри codebase_search.',
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
 * применяет документная модель renderer, тем же путём, что `apply_edit`, поэтому
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
        'Языковой сервер не нашёл объявления с таким именем. Уточни имя либо посмотри codebase_search. ' +
        'Для массовой замены подстроки есть `replace_in_files`, но он не знает семантики.',
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
        'Языковой сервер не поддерживает `textDocument/rename`. Для замены подстроки используй `replace_in_files`.',
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
 * и `run_terminal`: тесты выполняют код проекта. Вывод отдаём хвостом — он важнее
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
        'у Node — vitest, jest или встроенный `node --test`. Отдельный файл можно запустить через run_terminal.',
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
  const condensed = condenseOutput(result.output);
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
function commandLine(ctx: ToolContext, command: string): string {
  return ctx.sandbox ? `$ (в ${ctx.sandbox.label}) ${command}` : `$ ${command}`;
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
async function findFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { workspace } = ctx;
  const glob = optionalString(args, 'glob');
  const limit = optionalInteger(args, 'limit') ?? 200;

  const files = await workspace.findFiles(glob, limit);
  return {
    ok: true,
    summary: `${glob ? `«${glob}»: ` : ''}файлов: ${files.length}${files.length >= limit ? ' (обрезано)' : ''}`,
    detail: files.length ? clipText(ctx, 'find_files', files.join('\n')).text : 'Ничего не найдено',
  };
}

/* ── диагностика ────────────────────────────────────────────────────────── */

const MAX_DIAGNOSTICS = 100;

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

/** `apply_edit` едет в renderer: там документная модель, undo и ревью. */
async function applyEdit(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.applyEdits) {
    return { ok: false, summary: 'Правки сейчас недоступны: окно редактора не подключено' };
  }

  const edits = parseFileEdits(args.edits);
  const names = edits.map((file) => path.basename(file.path));
  const decision = await ctx.applyEdits(edits, ctx.autoApprove === true);

  if (decision.rejected) {
    return {
      ok: false,
      summary: `Пользователь отклонил правки: ${names.join(', ')}`,
      detail: 'Пользователь отклонил правки. Не повторяй этот вызов — предложи другое решение.',
    };
  }

  const outcome = readEditsOutcome(decision, (file) => path.basename(file));

  return {
    ok: outcome.ok,
    summary: `применено файлов: ${outcome.applied.length}${outcome.failed.length ? `, с ошибками: ${outcome.failed.length}` : ''}${outcome.tail}`,
    detail: outcome.detail,
    // Тела правок можно забыть только когда они действительно легли в файлы:
    // отклонённая или оставшаяся в буфере правка модели ещё понадобится.
    ...(outcome.ok && (decision.unwritten?.length ?? 0) === 0 ? { applied: true } : {}),
  };
}

/**
 * Разбор аргументов `apply_edit`. Модель — недоверенный источник, поэтому
 * структура проверяется вручную: битый FileEdit дальше в документную модель
 * попасть не должен.
 */
function parseFileEdits(value: unknown): FileEdit[] {
  // Одиночный файл без обёртки в массив — та же правка: ронять вызов из-за лишних
  // квадратных скобок незачем (так же ведёт себя разбор `apply_patch`).
  const single = typeof value === 'object' && value !== null && !Array.isArray(value);
  const list: unknown = single ? [value] : value;
  if (!Array.isArray(list)) throw new Error(`Аргумент «edits» должен быть массивом: ${EDITS_SHAPE}`);
  if (list.length === 0) throw new Error('Не передано ни одной правки');
  if (list.length > MAX_EDITED_FILES) {
    throw new Error(`Слишком много файлов за один вызов: ${list.length} (максимум ${MAX_EDITED_FILES})`);
  }

  return list.map((item, index) => parseFileEdit(item, index));
}

function parseFileEdit(value: unknown, index: number): FileEdit {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`edits[${index}]: ожидался объект — ${EDITS_SHAPE}`);
  }

  const raw = value as Record<string, unknown>;
  const filePath = raw.path;
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    // Форму называем прямо: «не задан path» само по себе не говорит, куда его класть.
    throw new Error(`edits[${index}]: не задан path. ${EDITS_SHAPE}`);
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

  const fileEdit: FileEdit = {
    path: filePath,
    edits: edits.map((edit, editIndex) => parseTextEdit(edit, index, editIndex)),
  };
  if (typeof raw.expectedVersion === 'number') fileEdit.expectedVersion = raw.expectedVersion;
  return fileEdit;
}

function parseTextEdit(value: unknown, fileIndex: number, editIndex: number): TextEdit {
  const where = `edits[${fileIndex}].edits[${editIndex}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: ожидался объект`);
  }

  const raw = value as Record<string, unknown>;
  const position = (key: string): number => {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      throw new Error(`${where}.${key}: нужно целое число ≥ 1`);
    }
    return number;
  };

  const newText = raw.newText;
  if (typeof newText !== 'string') throw new Error(`${where}.newText: нужна строка`);

  const edit: TextEdit = {
    startLine: position('startLine'),
    startColumn: position('startColumn'),
    endLine: position('endLine'),
    endColumn: position('endColumn'),
    newText,
  };

  // Необязательный якорь: с ним правка сверяется с документом и не может
  // «попасть» в другое место из-за сбитой позиции.
  if (raw.oldText !== undefined) {
    if (typeof raw.oldText !== 'string') throw new Error(`${where}.oldText: нужна строка`);
    edit.oldText = raw.oldText;
  }

  return edit;
}

/**
 * Правка по якорю (`apply_patch`). Разбор аргументов — здесь, а сами якоря
 * разрешает renderer: только у него есть текст документа (в том числе ещё не
 * сохранённый). Дальше правки идут тем же путём, что `apply_edit`, — ревью, undo
 * и панель изменений работают как обычно.
 */
async function applyPatch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.applyPatches) {
    return { ok: false, summary: 'Правки сейчас недоступны: окно редактора не подключено' };
  }

  const patches = parsePatchFiles(args.patches);
  const names = patches.map((file) => path.basename(file.path));
  const decision = await ctx.applyPatches(patches, ctx.autoApprove === true);

  if (decision.rejected) {
    return {
      ok: false,
      summary: `Пользователь отклонил правки: ${names.join(', ')}`,
      detail: 'Пользователь отклонил правки. Не повторяй этот вызов — предложи другое решение.',
    };
  }

  const outcome = readEditsOutcome(decision, (file) => path.basename(file));

  return {
    ok: outcome.ok,
    summary: `применено файлов: ${outcome.applied.length}${outcome.failed.length ? `, с ошибками: ${outcome.failed.length}` : ''}${outcome.tail}`,
    detail: outcome.detail,
    // Тела правок можно забыть только когда они действительно легли в файлы:
    // отклонённая или оставшаяся в буфере правка модели ещё понадобится.
    ...(outcome.ok && (decision.unwritten?.length ?? 0) === 0 ? { applied: true } : {}),
  };
}

/* ── запуск команд ──────────────────────────────────────────────────────── */

/**
 * `run_terminal` — единственный инструмент, который меняет систему за
 * пределами документов, поэтому он всегда идёт через подтверждение.
 */
async function runTerminal(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const command = requireString(args, 'command').trim();
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }
  // Предел времени — необязательный аргумент: у большинства команд хватает
  // значения по умолчанию, а заведомо долгой (сборка, установка) нужно больше.
  const timeoutSeconds = optionalInteger(args, 'timeout');
  const timeoutMs = timeoutSeconds !== undefined ? Math.min(Math.max(timeoutSeconds, 1), 1800) * 1000 : undefined;
  const runOptions = { signal: ctx.signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  if (!ctx.confirmCommand) {
    return { ok: false, summary: 'Запуск команд недоступен: окно редактора не подключено' };
  }

  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  if (needsConfirmation(ctx, command)) {
    const allowed = await ctx.confirmCommand(command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил выполнение команды',
        detail: 'Пользователь не разрешил выполнить эту команду. Не повторяй её — предложи другое решение.',
      };
    }
  }

  if (ctx.sandbox && !ctx.sandbox.available) return sandboxUnavailable(ctx.sandbox);
  // В песочнице та же команда идёт в контейнер: агент об этом не просит отдельно,
  // режим задаёт человек настройкой.
  const spillStream = ctx.spillDir ? createSpillStream(ctx.spillDir, 'run_terminal') : null;
  const options: RunOptions = spillStream ? { ...runOptions, spill: (chunk) => spillStream.write(chunk) } : runOptions;
  const result = ctx.sandbox
    ? await ctx.sandbox.run(command, root, options)
    : await runShellCommand(command, root, options);
  // Файл оставляем только тогда, когда вывод действительно не поместился в потолок.
  const full = spillStream?.close(result.truncated) ?? null;
  // Причёсываем и держим хвост: один `npm install` иначе завалит контекст логом.
  const condensed = condenseOutput(result.output);
  const output = full ? trimCommandTail(ctx, condensed, full) : clipTail(ctx, 'run_terminal', condensed);
  const notes: string[] = [];
  if (result.timedOut) notes.push('превышено время выполнения');
  if (result.truncated) notes.push('вывод обрезан');

  return {
    ok: result.code === 0 && !result.timedOut,
    summary: `код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `${commandLine(ctx, command)}\n${output.length ? output : '(пустой вывод)'}${spillNote(full)}`,
  };
}

/* ── долгие команды: задания ─────────────────────────────────────────────── */

/** Предел времени задания — тот же, что у `run_terminal`: больше 30 минут незачем. */
const MAX_JOB_TIMEOUT_SECONDS = 1800;

/**
 * `run_background` — та же команда, что у `run_terminal`, но шаг она не держит.
 *
 * Возвращается номер задания, а не вывод: сборка на пять минут иначе держала бы
 * агента всё это время, и он не мог бы даже сказать, что там происходит. Вывод
 * читается через `run_output`.
 */
async function runBackground(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };
  if (!ctx.confirmCommand) {
    return { ok: false, summary: 'Запуск команд недоступен: окно редактора не подключено' };
  }

  const command = requireString(args, 'command').trim();
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }
  const timeoutSeconds = optionalInteger(args, 'timeout');

  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  // Подтверждение то же, что у обычного запуска: команда есть команда, и то, что
  // она уходит в фон, ничего не смягчает.
  if (needsConfirmation(ctx, command)) {
    const allowed = await ctx.confirmCommand(command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил выполнение команды',
        detail: 'Пользователь не разрешил выполнить эту команду. Не повторяй её — предложи другое решение.',
      };
    }
  }

  // Задание — это процесс на хосте. В песочнице контейнер живёт на время команды,
  // и «фон» в нём пришлось бы держать открытым, поэтому честно отказываем.
  if (ctx.sandbox) {
    return {
      ok: false,
      summary: 'В песочнице фоновая команда не поддерживается',
      detail:
        `Песочница включена (${ctx.sandbox.label}), а контейнер живёт ровно на время команды. ` +
        'Запусти команду через run_terminal с бо́льшим пределом времени или выключи песочницу.',
    };
  }

  const limitMs =
    timeoutSeconds !== undefined ? Math.min(Math.max(timeoutSeconds, 1), MAX_JOB_TIMEOUT_SECONDS) * 1000 : undefined;

  let job: JobHandle;
  try {
    job = ctx.jobs.start({
      command,
      cwd: root,
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
      `Читай вывод через run_output { id: "${snapshot.id}" }, остановить — run_stop.`,
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
 * `run_output` — состояние задания и новый вывод. Без `id` — список заданий:
 * чтобы не гадать, что вообще запущено, после перезапуска хода.
 */
function runOutput(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
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
        'Такого задания нет: номер берётся из ответа run_background, а завершённые задания ' +
        'убираются, когда набирается много новых. Запусти команду заново, если результат нужен.',
    };
  }

  const from = optionalInteger(args, 'from');
  const result = job.read(from);
  const snapshot = result.snapshot;
  const output = result.data.length > 0 ? clipTail(ctx, 'run_output', condenseOutput(result.data)) : '';
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
      ...(running ? [`Потом дочитай: run_output { id: "${snapshot.id}", from: ${result.offset} }`] : []),
    ].join('\n'),
  };
}

/** `run_stop` — снять задание: брошенная сборка продолжает жечь процессор. */
function runStop(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
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
    detail: 'Процесс убит вместе с дочерними. Вывод, который успел прийти, можно дочитать через run_output.',
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

/** Сколько результатов веб-поиска отдаём модели: больше — уже шум, а не ответ. */
const MAX_WEB_RESULTS = 10;

/**
 * Веб-поиск. Пустая выдача — не ошибка инструмента: модель должна узнать, что по
 * такому запросу ничего нет, и сменить формулировку. Ошибкой считаем только
 * недоступность сервиса — тогда в ответе есть текст причины.
 */
async function webSearch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.webSearch) return { ok: false, summary: 'Веб-поиск не подключён' };

  const query = requireString(args, 'query');
  const limit = Math.min(Math.max(optionalInteger(args, 'limit') ?? MAX_WEB_RESULTS, 1), MAX_WEB_RESULTS);

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

/**
 * Программа вместо десятка вызовов (`run_code`).
 *
 * Каждый `tools.<имя>(args)` внутри программы — это обычный вызов инструмента:
 * он идёт через `ctx.runCode.onCall`, а тот — через `runTool` с тем же контекстом.
 * Значит права, подтверждения, запись правок и учёт прочитанного работают как
 * всегда, а меняется только число оборотов к модели: один вместо десяти.
 *
 * Запрет на часть инструментов живёт в `shared/run-code.ts`: `run_code` не зовёт
 * себя, `ask` не ждёт человека из программы, а план и цель — состояние беседы,
 * и из программы они всё равно ничего не поменяют.
 */
async function runCodeProgram(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.runCode) return { ok: false, summary: 'Программа недоступна: нет запуска' };

  const code = requireString(args, 'code');
  const timeoutMs = optionalInteger(args, 'timeoutMs');

  const outcome = await ctx.runCode.run(code, {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    onCall: async (name, callArgs) => {
      if (!runCodeToolAllowed(name)) {
        return {
          ok: false,
          summary: `инструмент «${name}» недоступен из программы`,
          text: `«${name}» нельзя звать из программы: сделай это обычным вызовом после её окончания.`,
        };
      }
      const result = await runTool(ctx, name, JSON.stringify(callArgs === undefined ? {} : callArgs));
      return {
        ok: result.ok,
        summary: result.summary,
        text: result.detail ?? result.summary,
      };
    },
  });

  const shaped = formatRunCode(outcome);
  return { ok: !outcome.error && !outcome.timedOut, summary: shaped.summary, detail: shaped.detail };
}

/** История коммитов: read-only контекст «что тут менялось». */
async function gitLog(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.git) return { ok: false, summary: 'Git недоступен' };

  const limit = optionalInteger(args, 'limit') ?? 20;
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

/** Новый файл. Существующий не перетираем — для этого есть apply_edit. */
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

  const { text, truncated } = clipText(ctx, 'git_diff', diff);
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
          'Заметок стало слишком много. Убери устаревшие через `forget`, а затем запиши нужную снова — ' +
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

/** «1 файл», «2 файла», «5 файлов» — для подписи действия в подтверждении. */
function pluralFiles(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла';
  return 'файлов';
}

/* ── открытие файла в редакторе ─────────────────────────────────────────── */

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

function terminalList(ctx: ToolContext): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const sessions = ctx.terminals.list();
  if (sessions.length === 0) {
    return { ok: true, summary: 'открытых терминалов нет', detail: 'Список пуст. Открой сессию через terminal_start.' };
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

  const cwd = optionalString(args, 'cwd') ?? ctx.workspace.rootPath() ?? undefined;
  const command = optionalString(args, 'command');
  if (command && command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  if (command && needsConfirmation(ctx, command)) {
    if (!ctx.confirmCommand) return { ok: false, summary: 'Запуск команд недоступен' };
    const allowed = await ctx.confirmCommand(command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил команду',
        detail: 'Не повторяй эту команду — предложи другое решение.',
      };
    }
  }

  const session = await ctx.terminals.create({ cols: TERMINAL_COLS, rows: TERMINAL_ROWS, cwd });
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

  const id = requireString(args, 'id');
  const data = requireString(args, 'data');

  // Ввод в терминал может быть чем угодно — страховка ловит необратимое и здесь.
  if (needsConfirmation(ctx, data)) {
    if (!ctx.confirmCommand) return { ok: false, summary: 'Ввод в терминал недоступен' };
    const allowed = await ctx.confirmCommand(`[${id}] ${data.replace(/\n/g, '⏎')}`);
    if (!allowed) return { ok: false, summary: 'Пользователь запретил ввод', detail: 'Ввод отклонён.' };
  }

  ctx.terminals.write(id, data);
  return {
    ok: true,
    summary: `отправлено в ${id}`,
    detail: `В сессию ${id} отправлено символов: ${data.length}. Прочитай вывод через terminal_read.`,
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
  const size = entry.kind === 'file' ? ` (${entry.size} Б)` : '';
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
 * в выводе `search`, `list_dir` и в самом проекте (`workspace.ts` уже отдаёт
 * относительные пути POSIX-вида). Путь в ответе модели должен быть один и тот же
 * на любой системе: по нему она ходит в следующие инструменты.
 */
function relativePath(target: string, root: string | null): string {
  if (!root) return target;
  const rel = path.relative(root, target);
  return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
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
 * уже другой вывод. `read_file` с диапазоном умеет прочитать такой файл, поэтому
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
 * `list_mcp_resources` — каталог ресурсов MCP: адреса, имена, типы.
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
 * `read_mcp_resource` — прочитать один ресурс по адресу из каталога.
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

  const report: SessionSearchReport = await ctx.sessions.search(query);
  return {
    ok: true,
    summary: report.hits.length > 0 ? `бесед по запросу: ${report.hits.length}` : 'в прошлых беседах не нашлось',
    detail: formatSessionSearch(report),
  };
}
