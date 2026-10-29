/**
 * Что получает и возвращает инструмент агента: `ToolContext` — всё, до чего шаг
 * может дотянуться (рабочая папка, отмена, разрешения), `ToolOutcome` — ответ
 * модели и карточке в UI, `SandboxRunner` — запуск команды в контейнере.
 *
 * Отдельный файл, потому что это единственный тип, который нужен всем
 * инструментам сразу: `agent-tools.ts` держит реестр, `agent-terminal.ts`,
 * `tool-command.ts` и `output-trim.ts` — по своей теме, и без общего дома они
 * импортировали бы 4 000 строк ради трёх интерфейсов.
 */
import type {
  ApplyEditsHostResult,
  BrowserZoomMode,
  DiagnosticsHostResult,
  TerminalCreateOptions,
  TerminalSession,
  ToolFileChange,
  ToolPresentedFile,
} from '../../shared/api';
import type { BrowserSnapshot } from '../../shared/browser';
import type { SearchSymbol } from '../../shared/code-search';
import type { FileEdit } from '../../shared/edits';
import type { LintOutcome } from '../../shared/lint';
import type { SymbolLocation } from '../../shared/lsp-locations';
import type { FileSymbol } from '../../shared/lsp-symbols';
import type { McpResourceInfo, McpToolInfo } from '../../shared/mcp';
import type { MemoryNote, MemoryScope, RememberResult } from '../../shared/memory';
import type { PatchFile } from '../../shared/patch';
import type { ReadRange } from '../../shared/read-coverage';
import type { SessionSearchReport } from '../../shared/session-search';
import type { FetchedPage } from '../../shared/web-fetch';
import type { WebSearchHit } from '../../shared/web-search';
import type { WorkspaceService } from '../workspace/workspace';
import type { JobRegistry } from './jobs';
import type { CommandResult, RunOptions } from './run-command';

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
  /**
   * Фактически прочитанные куски (1-based, включительно): повтор не нужен. Версия
   * файла и `eof` — чтобы понимать, устарел ли текст и закрыт ли диапазон до конца.
   */
  read?: {
    path: string;
    from: number;
    to: number;
    stamp?: string;
    eof?: boolean;
  };
  /** Пачка (`read { paths }`): каждый файл отдельным куском. */
  reads?: Array<{
    path: string;
    from: number;
    to: number;
    stamp?: string;
    eof?: boolean;
  }>;
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
  /** Сколько всего нашлось, если показываем не всё (счёт `grep -c`). */
  matches?: number;
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
 * подходит сюда структурно, как `TerminalAgent`.
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
  /**
   * «Что было в прогоне» по прошлой беседе: шаги, вызовы и чем кончилось.
   * Нет метода — нечем отвечать, и инструмент об этом скажет.
   */
  trace?(uid: string): Promise<string>;
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
 * (`project/lint.ts`), сюда приходит готовый вызов — тот же уговор, что у `TerminalAgent` Инструмент остаётся проверяемым без запуска линтеров.
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
  /** Вся память области: в промпт едет только её хвост, остальное читается здесь. */
  notes(scope?: MemoryScope): Promise<readonly MemoryNote[]>;
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
  /**
   * Уже прочитанное в этой ветке: файл и его диапазоны. Нужно командам-читалкам
   * (`cat`, `sed -n`): без этого `cat` того же файла отдаёт текст заново, хотя
   * покрытие про него знает — и платит модель. Читалки могут подтвердить версию
   * или удалить устаревшие диапазоны перед подавлением повтора.
   */
  coveredReads?: Map<string, ReadRange[]>;
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
  /** Пометки языка из редактора. */
  diagnostics?(path?: string): Promise<DiagnosticsHostResult>;
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
  /** Прошлые беседы проекта: нужно действию `sessions` инструмента `search`. */
  sessions?: SessionSearchRunner;
  /** Память проекта: нужна инструменту mind. */
  memory?: MemoryTools;
  /** Картинки для модели (`read_image`): чтение и уменьшение живут в main (`ai/read-image.ts`). */
  readImage?: ReadImageRunner;
  /** Веб-поиск: подключён только при включённой настройке. */
  webSearch?: WebSearchRunner;
  /** Чтение страницы по ссылке: тоже только при включённой настройке. */
  webFetch?: WebFetchRunner;
  /** Внешние инструменты (MCP): есть только при настроенных серверах. */
  mcp?: McpRunner;
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
  stepBudget?: { left: number; tokensLeft?: number; exhausted?: boolean };
}
