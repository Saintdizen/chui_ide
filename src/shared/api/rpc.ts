import type { MenuRole } from '../app-menu';
import type { AccountBalance } from '../balance';
import type { OfficePreview } from '../office';
import type { ApplyResult, FileEdit, TextEdit } from '../edits';
import type { BlameLine } from '../git-blame';
import type { PatchFile } from '../patch';
import type { ProjectScan } from '../project-scan';
import type { ProjectAnalysis } from '../project-analysis';
import type { ProjectSettings } from '../project-config';
import type { ReviewThread } from '../review';
import type { HistoryEntry } from '../file-history';
import type { GitLfsInfo } from '../git-lfs';
import type { GitSparseInfo } from '../git-sparse';
import type { GitIdentity, GitSshKey } from '../git-identity';
import type { WorkspaceRoot } from '../workspace-roots';
import type { LspStatus } from '../lsp-status';
import type { InheritedResult, SymbolIndexStatus } from '../symbol-index';
import type { SemanticToken } from '../lsp-semantic-tokens';
import type { FolderCompareResult } from '../folder-compare';
import type { StructuralProjectMatches, StructuralProjectOptions, StructuralSearchOptions } from '../structural-search';
import type { ExportsQuery, ExportsResult } from '../symbol-exports';
import type { InheritanceQuery, InheritanceResult } from '../type-inheritance';
import type { ProjectPackage } from '../monorepo';
import type { ProjectCommand } from '../commands';
import type { ChatTitleParts } from '../chat-title';
import type { PermissionPreset } from '../permissions';
import type { ForgeComment, ForgeInfo, ForgeIssue, ForgeNotification, ForgePipeline } from '../git-platform';
import type { GitReflogEntry } from '../git-reflog';
import type { GitStashEntry } from '../git-stash';
import type { GitTag } from '../git-tags';
import type { RebaseTodoItem } from '../git-rebase';
import type { PullMode } from '../git-pull';
import type { GitRefDiff } from '../git-ref-diff';
import type { GitRootFetch, GitRootSummary } from '../git-multiroot';
import type { CommitPromptParts } from '../commit-message';
import type { TestPromptParts } from '../test-generation';
import type { GitBisectState } from '../git-bisect';
import type { GitSubmodule } from '../git-submodules';
import type { GitWorktree } from '../git-worktrees';
import type { NodeEnvironmentHealth, NodeInfo, NodePackage } from '../node-env';
import type { NodeTestSuite } from '../node-tests';
import type { PythonEnvironment, PythonInterpreter, VenvLookup } from '../python-env';
import type { InstalledPackage } from '../python-packages';
import type { CollectedSuite } from '../python-tests';
import type { EnvironmentHealth } from '../python-health';
import type { ProjectSymbol } from '../lsp-symbols';
import type { ProjectKind } from '../project-kinds';
import type { ReviewVerdict } from '../approval-review';
import type { AppInfo } from './app';
import type {
  DirEntry,
  FileContent,
  FileStat,
  ReplaceFilesOptions,
  ReplaceFilesResult,
  SearchOptions,
  SearchResult,
  WorkspaceInfo,
} from './fs';
import type { WindowState } from './window';
import type {
  BrowserAction,
  BrowserPickedElement,
  BrowserRect,
  BrowserZoomMode,
  SessionState,
  TerminalCreateOptions,
  TerminalSession,
} from './terminal';
import type {
  ChatTitleResult,
  CommitMessageResult,
  GitBranch,
  GitCommit,
  GitCommitDiff,
  GitCommitInfo,
  GitConflictParts,
  GitDiff,
  GitFileHunks,
  GitNetworkResult,
  GitRebaseResult,
  GitRemote,
  GitStatus,
  RecentProject,
  TestGenerationResult,
} from './git';
import type { AiTelemetrySnapshot } from './settings';
import type {
  CreateVenvOptions,
  CreateVenvResult,
  NodeFormatResult,
  PythonFormatResult,
  PythonInstallOptions,
  PythonInstallResult,
  PythonLineProfileResult,
} from './python';
import type { LspServerConfig } from './lsp';
import type {
  AiConnectionTestResult,
  DebugAttachOptions,
  DebugBreakpoint,
  DebugExceptionFilters,
  DebugScope,
  DebugVariable,
  McpServerTools,
  Settings,
  SettingsPatch,
} from './debug';
import type {
  ChatConversation,
  ChatHistory,
  ChatRequest,
  ChatStreamDone,
  InlineCompletionRequest,
  InlineCompletionResult,
  PickedImage,
  ViewImage,
} from './ai';

/* ── Хост-вызовы main → renderer ────────────────────────────────────────── */

/** Аргументы `ai.applyEdits`: то, что агент просит применить к документам. */
export interface ApplyEditsHostParams {
  edits: FileEdit[];
  /** Полный доступ: применить сразу, без экрана ревью. */
  autoApprove?: boolean;
}

export interface ApplyEditsHostResult {
  /** Пользователь отказался — это решение, а не ошибка. */
  rejected: boolean;
  result?: ApplyResult;
  /**
   * Пути, чьи правки легли только в буфер редактора: на диск они не записаны.
   * Так бывает без полного доступа (файл пишет человек кнопкой «Сохранить») и при
   * конфликте с чужой правкой. Молчать об этом нельзя: main читает файлы с диска,
   * и агент принял бы старый текст за применённый.
   */
  unwritten?: string[];
  /**
   * Почему `persistPaths` не записал файл (код ФС либо текст ошибки). Пути в
   * `unwritten` без записи здесь означают "применилось, но признак грязного
   * буфера остался" — тогда причины нет, и гадать о ней нельзя.
   */
  unwrittenReasons?: Record<string, string>;
}

/** Аргументы `ai.applyPatches`: правки по якорю, без позиций. */
export interface ApplyPatchesHostParams {
  patches: PatchFile[];
  /** Полный доступ: применить сразу, без экрана ревью. */
  autoApprove?: boolean;
}

/** Аргументы `ai.confirmCommand`: команда, которую просит выполнить агент. */
export interface ConfirmCommandHostParams {
  command: string;
  /**
   * Что сказала проверка модели, если она не решилась разрешить сама. Причина
   * показывается в карточке подсказкой: человеку полезно видеть, что её смутило.
   */
  review?: ReviewVerdict;
}

export interface ConfirmCommandHostResult {
  allowed: boolean;
}

/** Аргументы `ai.confirmBrowser`: действие в браузере, которое просит выполнить агент. */
export interface ConfirmBrowserHostParams {
  action: string;
}

export interface ConfirmBrowserHostResult {
  allowed: boolean;
}

/** Аргументы `ai.ask`: вопрос ассистента и, если есть, готовые варианты ответа. */
export interface AskHostParams {
  question: string;
  /** Готовые варианты (до 5) — показываются кнопками. */
  options?: readonly string[];
}

export interface AskHostResult {
  /** Ответ человека. Пустая строка — вопрос остался без ответа (например, прогон прервали). */
  answer: string;
}

/** Аргументы `ai.exitPlan`: план, который агент отдаёт человеку на утверждение. */
export interface ExitPlanHostParams {
  /** План словами. Пусто — человек видит только чек-лист шагов. */
  plan: string;
}

export interface ExitPlanHostResult {
  /** `true` — план утверждён, режим переключён на «Агент». */
  approved: boolean;
  /** Замечание при отказе: что поправить в плане. */
  note: string;
}

/** Одна пометка языка: ошибка, предупреждение, подсказка. */
export interface DiagnosticItem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

/** Аргументы `ai.getDiagnostics`: без пути — по всем открытым файлам. */
export interface DiagnosticsHostParams {
  path?: string;
}

export interface DiagnosticsHostResult {
  items: DiagnosticItem[];
}

/** Аргументы `ai.openFile`: файл и место, которое нужно показать в редакторе. */
export interface OpenFileHostParams {
  path: string;
  /** Строка (1-based). Без неё — начало файла. */
  line?: number;
  /** Столбец (1-based). */
  column?: number;
}

export interface OpenFileHostResult {
  ok: boolean;
}

/**
 * Таблица хостовых методов: main обязан знать, что renderer умеет исполнять.
 * Обратный вызов нужен только там, где действие физически живёт в renderer.
 */
export interface HostMethods {
  'ai.applyEdits': { params: ApplyEditsHostParams; result: ApplyEditsHostResult };
  /** Правки по якорю: позиции считает renderer — у него есть текст документа. */
  'ai.applyPatches': { params: ApplyPatchesHostParams; result: ApplyEditsHostResult };
  'ai.confirmCommand': { params: ConfirmCommandHostParams; result: ConfirmCommandHostResult };
  'ai.confirmBrowser': { params: ConfirmBrowserHostParams; result: ConfirmBrowserHostResult };
  /** Вопрос человеку с ожиданием ответа: инструмент `ask`. */
  'ai.ask': { params: AskHostParams; result: AskHostResult };
  /** Утверждение плана: инструмент `exit_plan_mode` (режим переключает renderer). */
  'ai.exitPlan': { params: ExitPlanHostParams; result: ExitPlanHostResult };
  /** Пометки языка живут в renderer (в редакторе), а не на диске. */
  'ai.getDiagnostics': { params: DiagnosticsHostParams; result: DiagnosticsHostResult };
  /** Показать файл в редакторе: открытие вкладки — тоже дело renderer. */
  'ai.openFile': { params: OpenFileHostParams; result: OpenFileHostResult };
}

export type HostMethodName = keyof HostMethods;
export type HostParamsOf<M extends HostMethodName> = HostMethods[M]['params'];
export type HostResultOf<M extends HostMethodName> = HostMethods[M]['result'];

/* ── Контракт RPC ───────────────────────────────────────────────────────── */

/**
 * Таблица методов. Main обязан зарегистрировать все ключи (это проверяет
 * компилятор в `main/ipc/register.ts`), renderer получает автовывод типов
 * аргументов и результата из имени метода.
 */
export interface ChuiMethods {
  'app.info': { params: void; result: AppInfo };

  'dialog.pickFolder': { params: { title?: string }; result: { path: string | null } };
  /**
   * Выбор пути для сохранения файла ПОД ДРУГИМ ИМЕНЕМ (Save As). `defaultPath` —
   * папка и имя текущего файла: диалог открывается на них, а не на прошлом месте.
   */
  'dialog.saveFile': { params: { title?: string; defaultPath?: string }; result: { path: string | null } };
  'dialog.confirm': {
    params: { title: string; message: string; detail?: string; confirmLabel?: string };
    result: { confirmed: boolean };
  };
  /**
   * Закрытие окна с несохранёнными файлами: исходов три, а не два, поэтому не
   * `dialog.confirm`. Файлы — полные пути: имена для диалога выводит main.
   */
  'dialog.confirmClose': {
    params: { files: string[] };
    result: { choice: 'save' | 'discard' | 'cancel' };
  };
  /**
   * Выбор картинок системным диалогом. Читает файлы и отдаёт data-URL сам main:
   * renderer не имеет доступа к файловой системе и не должен его получать.
   */
  'dialog.pickImages': { params: void; result: PickedImage[] };

  'workspace.open': { params: { path: string }; result: WorkspaceInfo };
  'workspace.readDir': { params: { path: string }; result: DirEntry[] };
  'workspace.readFile': { params: { path: string }; result: FileContent };
  /** Прочитать файл-картинку для вьюера. Текстом её не открыть: бинарь. */
  'workspace.readImage': { params: { path: string }; result: ViewImage };
  /** Прочитать документ Office для предпросмотра (.docx/.xlsx). */
  'workspace.readOffice': { params: { path: string }; result: OfficePreview };
  'workspace.writeFile': { params: { path: string; text: string }; result: { mtimeMs: number } };
  'workspace.stat': { params: { path: string }; result: FileStat };

  /*
   * Удалённые файловые системы (SSH, WSL, контейнер): адрес собирается из схемы и
   * пути (см. `shared/fs-address.ts`), а main ходит туда клиентом системы
   * (`main/workspace/remote-fs.ts`). Отдельные методы, а не общие с `workspace.*`:
   * путь-адрес не проверяется `safePath` и в списки локальных корней не попадает.
   */
  'remote.check': { params: { address: string }; result: { ok: boolean; detail: string } };
  'remote.readDir': { params: { address: string }; result: DirEntry[] };
  'remote.readFile': { params: { address: string; maxBytes?: number }; result: { text: string; truncated: boolean } };
  'remote.writeFile': { params: { address: string; text: string }; result: { ok: boolean } };
  'remote.stat': {
    params: { address: string };
    result: { exists: boolean; kind: 'file' | 'directory'; size: number; mtimeMs: number };
  };
  'remote.mkdir': { params: { address: string }; result: { ok: boolean } };
  'remote.rename': { params: { from: string; to: string }; result: { ok: boolean } };
  'remote.remove': { params: { address: string }; result: { ok: boolean } };
  'workspace.search': { params: SearchOptions; result: SearchResult };
  /** Относительные (POSIX) пути всех файлов проекта — для быстрого открывателя. */
  'workspace.listFiles': { params: void; result: string[] };
  /**
   * Алиасы импорта из `paths` tsconfig. `prefixes` — шаблоны со звёздочкой (`@/` →
   * `src/`), `exact` — шаблоны без неё (`@ui`): они совпадают только целиком.
   * Нет tsconfig или `paths` — обе карты пустые.
   */
  'workspace.importAliases': {
    params: void;
    result: { aliases: { prefixes: Record<string, string>; exact: readonly string[] } };
  };
  /** Сравнить две папки рабочей области: какие файлы различаются. */
  'workspace.compareFolders': { params: { left: string; right: string }; result: FolderCompareResult };
  /** Сессия проекта: восстановление при открытии и сохранение изменений. */
  'session.load': { params: { root: string }; result: SessionState };
  'session.save': { params: { root: string; state: SessionState }; result: void };
  'workspace.replace': { params: ReplaceFilesOptions; result: ReplaceFilesResult };
  /**
   * Поиск по структуре кода по всему проекту — предпросмотр, без правок. Возвращает
   * файлы с местами и общим числом вхождений (по тому же образцу, что и в файле).
   */
  'workspace.structuralSearch': { params: StructuralSearchOptions; result: StructuralProjectMatches };
  /** Замена по структуре по всему проекту: изменённые пути и число замен. */
  'workspace.structuralReplace': { params: StructuralProjectOptions; result: ReplaceFilesResult };
  /**
   * Где имя объявлено ЭКСПОРТОМ: разбор по языку (JS/TS и Python) без языкового сервера —
   * такого запроса в LSP нет. Возвращает файлы с местами (строка, вид экспорта).
   */
  'workspace.findExports': { params: ExportsQuery; result: ExportsResult };
  /**
   * Наследование имени по проекту: кто наследует (`subtypes`) или от кого наследует
   * (`supertypes`). Свой разбор строк (JS/TS и Python), без языкового сервера.
   */
  'workspace.findInheritance': { params: InheritanceQuery; result: InheritanceResult };
  'workspace.createFile': { params: { path: string; contents?: string }; result: { path: string } };
  'workspace.createDir': { params: { path: string }; result: { path: string } };
  'workspace.rename': { params: { from: string; to: string }; result: { path: string } };
  /**
   * Переписать импорты, ведущие на переименованный файл (или в переименованную
   * папку): относительные спецификаторы в файлах проекта переводятся на новый путь.
   */
  'workspace.updateImports': { params: { oldPath: string; newPath: string }; result: { files: string[] } };
  /** Копия файла или папки: существующий объект в цели не перетирается. */
  'workspace.copy': { params: { from: string; to: string }; result: { path: string } };
  'workspace.trash': { params: { path: string }; result: void };
  /**
   * Карта проекта: языки, манифесты, тесты и точки входа. Собирается обходом
   * имён без чтения содержимого — дёшево и без последствий для больших проектов.
   */
  'project.scan': { params: void; result: ProjectScan };
  /**
   * Анализ проекта целиком: линтер по корню плюс сверка зависимостей
   * с `node_modules`. Нужен, чтобы «Проблемы» и счётчики в статус-баре не
   * пустовали до открытия первого файла: пометки обычных источников (LSP,
   * проверка импортов) приходят только по открытым документам.
   *
   * Вызов долгий (секунды, у линтера есть свой потолок в main) — зовётся фоном
   * при открытии проекта, а не на каждое сохранение.
   */
  'project.analyze': { params: void; result: ProjectAnalysis };
  // Отдельно от analyze: tsc идёт десятками секунд — только по команде.
  'project.types': { params: void; result: ProjectAnalysis };
  /**
   * Настройки уровня проекта из `<root>/.chui_ide/`: редактор, дерево, запуск и
   * LSP. Лежат в самом проекте, чтобы их можно было версионировать вместе с кодом,
   * в отличие от userData. Макет панелей сюда не входит: он общий для всех проектов.
   */
  'project.config': { params: { root: string }; result: ProjectSettings };
  'project.updateSettings': { params: { root: string; patch: ProjectSettings }; result: ProjectSettings };

  /** Виртуальные окружения Python в проекте: главное — первым. */
  'python.environments': { params: void; result: PythonEnvironment[] };
  /** Интерпретаторы Python, найденные в системе: выбор версии при создании окружения. */
  'python.interpreters': { params: void; result: PythonInterpreter[] };
  /** Создать окружение, при желании поставив в него пакеты. Долгий вызов со событиями. */
  'python.createVenv': { params: CreateVenvOptions; result: CreateVenvResult };
  /**
   * Окружение по папке, которую указал человек: своё, созданное раньше, возможно вне
   * проекта. Возвращает окружение либо объяснение, почему папка не подошла.
   */
  'python.venvAt': { params: { path: string }; result: VenvLookup };
  /** Команда активации главного окружения для терминала; null — окружения нет. */
  'python.activateCommand': { params: void; result: { command: string | null } };
  /** Установленные пакеты главного окружения: имя и версия. */
  'python.packages': { params: void; result: InstalledPackage[] };
  /** Поставить пакеты или зависимости из requirements.txt. Долгий вызов со событиями. */
  'python.install': { params: PythonInstallOptions; result: PythonInstallResult };
  /** Список тестов проекта: `pytest --collect-only`. */
  'python.tests': { params: void; result: CollectedSuite };
  /** Что не так с окружениями проекта: битый `pyvenv.cfg`, нет pip, пропал базовый питон. */
  'python.envHealth': { params: void; result: EnvironmentHealth[] };
  /** Отформатировать текст файла инструментом окружения (ruff или black). */
  'python.format': { params: { path: string; text: string }; result: PythonFormatResult };
  /**
   * Профиль строк файла: свой профилировщик на стандартной библиотеке исполняет
   * скрипт и возвращает, сколько времени прошло на каждой строке.
   */
  'python.profileLines': { params: { path: string; args?: string[] }; result: PythonLineProfileResult };

  /** Окружение Node: версия Node и менеджер пакетов проекта. */
  'node.info': { params: void; result: NodeInfo };
  /** Установленные пакеты проекта: то, что лежит в `node_modules`. */
  'node.packages': { params: void; result: NodePackage[] };
  /** Что не так с окружением проекта: нет `node_modules`, версия Node не под `engines.node`. */
  'node.envHealth': { params: void; result: NodeEnvironmentHealth[] };
  /** Отформатировать текст файла инструментом проекта (prettier или biome). */
  'node.format': { params: { path: string; text: string }; result: NodeFormatResult };
  /** Список тестов проекта: `vitest list`, `jest --listTests` или файлы для `node --test`. */
  'node.tests': { params: void; result: NodeTestSuite };
  /**
   * Какие из импортированных модулей проект не видит: для Python — интерпретатор,
   * для JS/TS — `node_modules`. Пустой ответ — либо всё на месте, либо судить
   * не по чему (нет интерпретатора, не найден каталог пакетов).
   */
  'imports.missing': {
    params: { language: string; path: string; modules: string[]; locals: string[] };
    result: { missing: string[] };
  };
  /**
   * Пакеты проекта (монорепо): где лежат манифесты. Нужны панели изменений, чтобы
   * разложить правки по пакетам, а не показывать один общий список файлов.
   */
  'project.packages': { params: void; result: ProjectPackage[] };
  /**
   * Куда прогон с покрытием пишет отчёт. `path` — файл для pytest
   * (`--cov-report=json:…`), `dir` — каталог, куда раннеры Node (vitest, jest)
   * кладут свой `coverage-final.json`. Оба — во временном каталоге.
   */
  'project.coverageJsonPath': { params: void; result: { path: string; dir: string } };
  /**
   * Прочитать файл отчёта покрытия, который IDE сама попросила у раннера. Лежит
   * он во временном каталоге, куда `workspace.readFile` не пускает, — поэтому за
   * него отвечает main. Читает только СВОЙ файл: путь он вычисляет из корня.
   */
  'project.readCoverage': { params: { kind: 'pytest' | 'node' }; result: { text: string | null } };

  'git.status': { params: void; result: GitStatus };
  /**
   * Diff того, что попадёт в коммит: с индекса — индекс против HEAD, без него —
   * рабочее дерево против индекса. Нужен для сообщения коммита по diff.
   */
  'git.commitDiff': { params: void; result: GitCommitDiff };
  /** Блоки изменений файла: для действий прямо из жёлоба редактора. */
  'git.fileHunks': { params: { path: string }; result: GitFileHunks };
  /** Откатить ОДИН блок файла в рабочем дереве (обратный `git apply -R`). */
  'git.discardHunk': { params: { path: string; index: number }; result: GitStatus };
  /**
   * Сводка по всем корням рабочей области: какие папки — репозитории git, какие
   * в них ветки и сколько правок. Нужна панели изменений, чтобы видеть всю область
   * сразу, а не только активную папку (`shared/git-multiroot.ts`).
   */
  'git.summary': { params: void; result: GitRootSummary[] };
  'git.init': { params: void; result: GitStatus };
  'git.stage': { params: { paths: string[] }; result: GitStatus };
  'git.unstage': { params: { paths: string[] }; result: GitStatus };
  'git.discard': { params: { paths: string[] }; result: GitStatus };
  'git.commit': { params: { message: string; paths?: string[]; amend?: boolean }; result: GitCommitInfo };
  'git.diff': { params: { path: string; staged?: boolean; commit?: string }; result: GitDiff };
  'git.stageHunk': { params: { path: string; index: number }; result: GitStatus };
  'git.unstageHunk': { params: { path: string; index: number }; result: GitStatus };
  /**
   * Происхождение строк файла: кто, когда и каким коммитом их менял. Без
   * границ — весь файл; неотслеживаемый файл даёт пустой список, а не сбой.
   */
  'git.blame': { params: { path: string; startLine?: number; endLine?: number }; result: BlameLine[] };
  /** История коммитов: все или только трогавшие указанный файл. */
  'git.log': { params: { path?: string; limit?: number }; result: GitCommit[] };
  /**
   * Содержимое файла в HEAD — база для полосок изменений в жёлобе. `null` —
   * файл вне репозитория; пустая строка — файл новый или без коммитов.
   */
  'git.headText': { params: { path: string }; result: string | null };

  /* Отложенные изменения (stash): список, сохранить, применить, всплыть, удалить. */
  'git.stashList': { params: void; result: GitStashEntry[] };
  'git.stashSave': { params: { message?: string; includeUntracked?: boolean }; result: GitStatus };
  'git.stashApply': { params: { index: number }; result: GitStatus };
  'git.stashPop': { params: { index: number }; result: GitStatus };
  'git.stashDrop': { params: { index: number }; result: GitStatus };
  /** Полный патч записи — для просмотра содержимого. */
  'git.stashShow': { params: { index: number }; result: string };

  /* Отдельные коммиты и теги: перенос, откат, сброс и метки. */
  'git.cherryPick': { params: { commit: string }; result: GitStatus };
  'git.revert': { params: { commit: string }; result: GitStatus };
  'git.reset': { params: { mode: 'soft' | 'mixed' | 'hard'; commit: string }; result: GitStatus };
  /**
   * Интерактивный rebase последних `count` коммитов: список шагов задаёт вызывающий
   * (перестановка, склейка, переписывание сообщения, drop). Возвращает исход операции:
   * rebase может завершиться, остановиться на конфликте или на шаге `edit`.
   */
  'git.rebase': { params: { count: number; items: RebaseTodoItem[] }; result: GitRebaseResult };
  /** Продолжить остановленный rebase (после разрешённого конфликта или шага `edit`). */
  'git.rebaseContinue': { params: void; result: GitRebaseResult };
  /** Прервать rebase: ветка возвращается туда, где была до запуска. */
  'git.rebaseAbort': { params: void; result: GitStatus };
  /** Пропустить текущий коммит остановленного rebase. */
  'git.rebaseSkip': { params: void; result: GitRebaseResult };
  'git.tags': { params: void; result: GitTag[] };
  'git.createTag': { params: { name: string; message?: string; commit?: string }; result: GitStatus };
  'git.deleteTag': { params: { name: string }; result: GitStatus };
  'git.pushTag': { params: { name: string }; result: GitNetworkResult };

  /* Ветки, .gitignore и журнал ссылок (reflog). */
  'git.deleteBranch': { params: { name: string; force?: boolean }; result: GitStatus };
  'git.renameBranch': { params: { from: string; to: string }; result: GitStatus };
  'git.ignore': { params: { paths: string[] }; result: GitStatus };
  /** Подмодули репозитория: состояние нужно дереву, чтобы пометить папки. */
  'git.submodules': { params: void; result: GitSubmodule[] };
  /** Забрать код подмодулей (`update --init --recursive`). */
  'git.submoduleUpdate': { params: void; result: GitStatus };
  /* Дополнительные рабочие каталоги одного репозитория (worktree). */
  'git.worktrees': { params: void; result: GitWorktree[] };
  /** Добавить каталог: существующая ветка или новая; без них — отделённый указатель. */
  'git.worktreeAdd': { params: { path: string; branch?: string; newBranch?: string }; result: GitWorktree[] };
  /** Удалить каталог; `force` — когда в нём есть незакоммиченные правки. */
  'git.worktreeRemove': { params: { path: string; force?: boolean }; result: GitWorktree[] };
  /** Убрать записи о каталогах, которых уже нет на диске. */
  'git.worktreePrune': { params: void; result: GitWorktree[] };
  /**
   * Какие из путей игнорируются git (`.gitignore`). Спрашиваем только про видимые
   * в дереве пути: полный список игнорируемого читать незачем.
   */
  'git.checkIgnore': { params: { paths: string[] }; result: string[] };
  /** Журнал ссылок: чем можно откатить неудачный merge, rebase или reset. */
  'git.reflog': { params: { limit?: number }; result: GitReflogEntry[] };
  /** История в виде графа веток — текстом, как её рисует git. */
  'git.logGraph': { params: { limit?: number }; result: string };
  /**
   * Сравнение двух ссылок (веток, коммитов, тегов): список изменённых файлов
   * со статусом и счётчиком строк. Для просмотра различий между ветками.
   */
  'git.compareRefs': { params: { base: string; head: string }; result: GitRefDiff };
  /** Один файл между двумя ссылками: слева содержимое из `base`, справа из `head`. */
  'git.diffRefs': { params: { base: string; head: string; path: string }; result: GitDiff };
  /* Пошаговый поиск «багованного» коммита (bisect). */
  /** Текущее состояние поиска: идёт ли он, где стоит и сколько осталось. */
  'git.bisectState': { params: void; result: GitBisectState };
  /** Начать поиск; `bad` и `good` — известные плохой и хороший коммиты. */
  'git.bisectStart': { params: { bad?: string; good?: string }; result: GitBisectState };
  /** Пометить проверяемый коммит хорошим, плохим или пропустить его. */
  'git.bisectMark': { params: { mark: 'good' | 'bad' | 'skip' }; result: GitBisectState };
  /** Закончить поиск: ветка возвращается туда, где была до него. */
  'git.bisectReset': { params: void; result: GitStatus };
  /** Три версии конфликтного файла: общий предок и обе стороны. */
  'git.conflictParts': { params: { path: string }; result: GitConflictParts };
  /** Отметить конфликт решённым: содержимое файла уходит в индекс (`git add`). */
  'git.markResolved': { params: { path: string }; result: GitStatus };
  'git.branches': { params: void; result: GitBranch[] };
  'git.checkout': { params: { name: string; create?: boolean }; result: GitStatus };
  'git.remotes': { params: void; result: GitRemote[] };
  'git.fetch': { params: void; result: GitNetworkResult };
  /** `fetch` во всех корнях области: итог по каждой папке (`shared/git-multiroot.ts`). */
  'git.fetchRoots': { params: void; result: GitRootFetch[] };
  /** `mode` — как вливать (`merge`/`rebase`/`ff-only`); не задан — как настроено в git. */
  'git.pull': { params: { mode?: PullMode }; result: GitNetworkResult };
  'git.push': { params: { setUpstream?: boolean; force?: boolean }; result: GitNetworkResult };
  'git.clone': { params: { url: string; directory: string }; result: { path: string } };

  /* Площадка хостинга: запросы на слияние (PR/MR) через `gh`/`glab`. */
  /** Площадка репозитория, доступность клиента, вход и список запросов. */
  'git.forgeInfo': { params: { remote?: string }; result: ForgeInfo };
  /** Создать запрос на слияние из ветки. */
  'git.forgeCreate': {
    params: { title: string; body?: string; target?: string; source?: string; draft?: boolean };
    result: ForgeInfo;
  };
  /** Забрать ветку запроса в рабочий каталог (клиент делает fetch и checkout). */
  'git.forgeCheckout': { params: { number: number }; result: GitStatus };
  /** Комментарии запроса на слияние (обсуждение). */
  'git.forgeComments': { params: { number: number }; result: ForgeComment[] };
  /** Написать комментарий к запросу: возвращает обновлённое обсуждение. */
  'git.forgeComment': { params: { number: number; body: string }; result: ForgeComment[] };
  /** Задачи площадки (issues): список открытых и закрытых. */
  'git.forgeIssues': { params: void; result: ForgeIssue[] };
  /** Создать задачу: возвращает обновлённый список. */
  'git.forgeIssueCreate': { params: { title: string; body?: string }; result: ForgeIssue[] };
  /** Закрыть задачу: возвращает обновлённый список. */
  'git.forgeIssueClose': { params: { number: number }; result: ForgeIssue[] };
  /** Комментарии задачи (обсуждение). */
  'git.forgeIssueComments': { params: { number: number }; result: ForgeComment[] };
  /** Написать комментарий к задаче: возвращает обновлённое обсуждение. */
  'git.forgeIssueComment': { params: { number: number; body: string }; result: ForgeComment[] };
  /** Прогоны CI площадки (Actions/Pipelines): свежие сверху. */
  'git.forgePipelines': { params: void; result: ForgePipeline[] };
  /** Перезапустить прогон: возвращает обновлённый список. */
  'git.forgePipelineRerun': { params: { id: number }; result: ForgePipeline[] };
  /** Уведомления площадки (непрочитанные ветки / незакрытые дела). */
  'git.forgeNotifications': { params: void; result: ForgeNotification[] };
  /** Отметить уведомление прочитанным: возвращает обновлённый список. */
  'git.forgeNotificationRead': { params: { id: string }; result: ForgeNotification[] };
  /** Открыть ссылку в браузере системы (страницы площадки и запросов). */
  'shell.openExternal': { params: { url: string }; result: { ok: boolean } };
  /** Показать файл или папку в проводнике системы (выделить объект). */
  'shell.revealInOS': { params: { path: string }; result: { ok: boolean } };
  /** Открыть файл программой системы: внешний редактор, просмотрщик, что настроено. */
  'shell.openPath': { params: { path: string }; result: { ok: boolean } };
  /** Открыть терминал системы в папке. `ok: false` — подходящего терминала нет. */
  'shell.openTerminal': { params: { path: string }; result: { ok: boolean; command?: string } };

  /* Встроенный браузер: страница — вкладка в редакторе, рисует её WebContentsView.
     Место вложения задаётся числами, потому что оно не в DOM, а отдельным слоем
     окна; состояние вкладки приходит обратным событием `PushTopic.BrowserNav`. */
  /** Завести вложение для вкладки. Адрес приходит уже нормализованным. */
  'browser.viewCreate': { params: { id: string; url: string }; result: { ok: boolean; reason?: string } };
  /** Показать вложение на месте области редактора. */
  'browser.viewShow': { params: { id: string; rect: BrowserRect }; result: { ok: boolean } };
  /** Спрятать вложение: активна не страница (файл, чат, картинка). */
  'browser.viewHide': { params: void; result: { ok: boolean } };
  /** Область редактора переехала или изменилась — переставить вложение. */
  'browser.viewLayout': { params: { rect: BrowserRect }; result: { ok: boolean } };
  /** Действие над вкладкой: назад, вперёд, обновить, стоп, переход, DevTools. */
  'browser.viewCommand': {
    params: { id: string; action: BrowserAction; url?: string };
    result: { ok: boolean; reason?: string };
  };
  /** Закрыть вложение вкладки: она ушла из полосы. */
  'browser.viewClose': { params: { id: string }; result: { ok: boolean } };
  /** Закрыть все вложения сразу. */
  'browser.viewCloseAll': { params: void; result: { ok: boolean } };
  /** Поделиться вкладкой с ассистентом: агент работает в этой же странице и сессии. */
  'browser.viewShare': { params: { id: string }; result: { ok: boolean } };
  /** Отозвать общий доступ: агент снова заводит свою вкладку во временной сессии. */
  'browser.viewUnshare': { params: void; result: { ok: boolean } };
  /** Снимок страницы вкладки (data-URL): уходит в чат как вложение-картинка. */
  'browser.viewCapture': { params: { id: string }; result: { ok: boolean; dataUrl?: string; reason?: string } };
  /** Журнал консоли страницы вкладки: строки для вложения-контекста. */
  'browser.viewConsole': { params: { id: string }; result: { ok: boolean; lines: string[] } };
  /** Масштаб страницы: кнопки шапки и Ctrl+колесо. Возвращает получившийся масштаб. */
  'browser.viewZoom': {
    params: { id: string; mode: BrowserZoomMode };
    result: { ok: boolean; zoom?: number; reason?: string };
  };
  /**
   * Выбрать элемент страницы мышью (отмена — Esc). Возвращает его описание для чата
   * и снимок области элемента: подсветить элемент в DOM нельзя — страница не в DOM.
   */
  'browser.viewPick': {
    params: { id: string };
    result: { ok: boolean; element?: BrowserPickedElement; shot?: { dataUrl: string; bytes: number }; reason?: string };
  };

  /* Личность автора, подпись коммитов и ключи: настройки git, а не IDE. */
  /** Действующие имя, почта, подпись и хранилище паролей. */
  'git.identity': { params: void; result: GitIdentity };
  /** Записать настройки в локальный конфиг репозитория. */
  'git.setIdentity': { params: { values: Partial<GitIdentity> }; result: GitIdentity };
  /** Открытые ключи из `~/.ssh`: тип, комментарий и отпечаток. */
  'git.sshKeys': { params: void; result: GitSshKey[] };

  /* Git LFS: большие файлы в отдельном хранилище. */
  /** Что знает репозиторий: доступен ли git-lfs, шаблоны и файлы под LFS. */
  'git.lfsInfo': { params: void; result: GitLfsInfo };
  /** Взять шаблон под LFS (`git lfs track`) — строка уходит в `.gitattributes`. */
  'git.lfsTrack': { params: { pattern: string }; result: GitLfsInfo };
  /** Перестать вести шаблон через LFS (`git lfs untrack`). */
  'git.lfsUntrack': { params: { pattern: string }; result: GitLfsInfo };
  /** Подтянуть содержимое больших файлов (`git lfs pull`). */
  'git.lfsPull': { params: void; result: GitLfsInfo };
  /** Подготовить репозиторий к LFS: хуки `git lfs install --local`. */
  'git.lfsInstall': { params: void; result: GitLfsInfo };

  /* Разреженный рабочий каталог (sparse checkout): что из репозитория выложено на диск. */
  /** Включён ли режим и какие каталоги выбраны. */
  'git.sparseInfo': { params: void; result: GitSparseInfo };
  /** Задать набор каталогов целиком (`git sparse-checkout set --cone`). */
  'git.sparseSet': { params: { directories: string[] }; result: GitSparseInfo };
  /** Добавить каталог к текущему набору (`git sparse-checkout add`). */
  'git.sparseAdd': { params: { directory: string }; result: GitSparseInfo };
  /** Выключить разреженный режим: на диск возвращается весь репозиторий. */
  'git.sparseDisable': { params: void; result: GitSparseInfo };

  /* Замечания к коду (code review): хранятся в проекте, источник истины — renderer. */
  /** Замечания текущего проекта. */
  'review.load': { params: void; result: ReviewThread[] };
  /** Записать список замечаний целиком; возвращает то, что легло на диск. */
  'review.save': { params: { threads: ReviewThread[] }; result: ReviewThread[] };

  /* Локальная история файла: снимки содержимого, снятые при сохранении. */
  /** Снимки файла, новые в начале. */
  'history.list': { params: { path: string }; result: HistoryEntry[] };
  /** Содержимое одного снимка; ошибка, если снимка уже нет. */
  'history.read': { params: { path: string; id: string }; result: { text: string } };
  /** Убрать историю файла целиком. */
  'history.clear': { params: { path: string }; result: void };

  'terminal.create': { params: TerminalCreateOptions; result: TerminalSession };
  'terminal.write': { params: { id: string; data: string }; result: void };
  'terminal.resize': { params: { id: string; cols: number; rows: number }; result: void };
  'terminal.kill': { params: { id: string }; result: void };

  'window.getState': { params: void; result: WindowState };
  'window.minimize': { params: void; result: void };
  'window.toggleMaximize': { params: void; result: WindowState };
  'window.close': { params: void; result: void };
  /** Действие меню, которое умеет только main: буфер обмена, масштаб, окно. */
  'menu.role': { params: { role: MenuRole }; result: void };

  /* Стартовое окно: список недавних проектов и переход к IDE. */
  'app.recentProjects': { params: void; result: RecentProject[] };
  'app.openProject': { params: { path: string }; result: { root: string; name: string } };
  /**
   * Закрытие проекта: main поднимает стартовое окно со списком проектов, а окно IDE
   * закрывает сам renderer — закрытие в обработчике уничтожило бы отправителя до ответа.
   */
  'app.closeProject': { params: void; result: void };
  /**
   * Создать проект: папка с файлами-заготовками выбранного вида. Возвращает путь
   * новой папки — окно открывает его тем же путём, что и склонированный.
   */
  'app.createProject': {
    params: { name: string; directory: string; kind: ProjectKind };
    result: { path: string };
  };
  'app.forgetProject': { params: { path: string }; result: RecentProject[] };
  /** Корень, открытый в main: окно IDE забирает его при старте. */
  'workspace.current': { params: void; result: { root: string | null; roots: WorkspaceRoot[] } };
  /** Добавить папку в рабочую область: в одном окне может быть несколько корней. */
  'workspace.addRoot': { params: { path: string }; result: WorkspaceInfo };
  /** Убрать корень; активным становится первый оставшийся (`null` — область пуста). */
  'workspace.removeRoot': { params: { path: string }; result: WorkspaceInfo | null };
  /** Сделать корень активным — им отвечают git, поиск и запуск без явного файла. */
  'workspace.setActiveRoot': { params: { path: string }; result: WorkspaceInfo };

  'settings.get': { params: void; result: Settings };
  'settings.update': { params: SettingsPatch; result: Settings };
  'settings.revealFile': { params: void; result: { path: string } };

  /* Темы из файла: импорт, экспорт шаблона и снятие. */
  'theme.import': { params: void; result: { settings: Settings; name: string | null } };
  /** Импорт набора значков дерева из JSON-файла: правила «маска → значок». */
  'explorer.importBadges': { params: void; result: { settings: Settings; count: number } };
  'theme.export': { params: { contents: string; name: string }; result: { path: string | null } };
  'theme.clear': { params: void; result: Settings };

  /* Языковые серверы: синхронизация документа и перезапуск. */
  'lsp.open': { params: { path: string; languageId: string; text: string }; result: void };
  'lsp.change': { params: { path: string; text: string }; result: void };
  'lsp.close': { params: { path: string }; result: void };
  'lsp.restart': { params: void; result: LspStatus };
  'lsp.status': { params: void; result: LspStatus };
  /**
   * Прогреть серверы языков проекта, не дожидаясь открытия файлов (см. `LspService.prewarm`).
   * Языки приходят из карты проекта: у каждого должен быть сервер в настройках.
   */
  'lsp.prewarm': { params: { languages: string[] }; result: void };
  /** Символы проекта по запросу: классы, функции, переменные — «перейти к символу». */
  'lsp.symbols': { params: { query: string }; result: ProjectSymbol[] };
  /**
   * Состояние карты символов проекта (см. `main/symbols/indexer.ts`): собрана ли она,
   * сколько файлов и объявлений. Карта собирается в фоне при открытии проекта, и по
   * этому ответу видно, докуда она дошла. `warming` — поиск уже отвечает тем, что есть.
   */
  'index.status': { params: void; result: SymbolIndexStatus };
  /** Пересобрать карту символов в фоне: изменившиеся файлы разберутся заново. */
  'index.rebuild': { params: void; result: SymbolIndexStatus };
  /**
   * Поиск ТОЛЬКО по карте символов, без языковых серверов: им дополняются подсказки
   * при обычном наборе. `lsp.symbols` спрашивает ещё и серверы, а на каждую паузу
   * в наборе это слишком дорого — карта отвечает мгновенно.
   */
  'index.find': { params: { query: string }; result: ProjectSymbol[] };
  /**
   * Что тип умеет и от кого это унаследовано: члены самого типа и предков, без тел
   * и без языкового сервера. Ответ собирается по карте символов (см. `index.status`),
   * поэтому приходит сразу, а `phase` говорит, стоит ли переспросить позже.
   */
  'index.inherited': { params: { name: string }; result: InheritedResult };
  /** Найти в PATH известные языковые серверы и вернуть готовые конфигурации. */
  'lsp.detect': { params: void; result: LspServerConfig[] };
  /**
   * Прокси-запрос к языковому серверу открытого файла: подсказки, наведение,
   * переход к определению. Форму params/result задаёт LSP, детали — в renderer.
   */
  'lsp.request': { params: { path: string; method: string; params: unknown }; result: unknown };
  /**
   * Чем сервер готов открывать подсказки: знаки-триггеры, знаки «принять» и умение
   * доводить элемент отдельным запросом (см. `LspService.completionTriggers`). Renderer
   * открывает попап по знакам сервера, а не только по точке.
   */
  'lsp.capabilities': {
    params: { path: string };
    result: { triggerCharacters: string[]; allCommitCharacters: string[]; resolveProvider: boolean };
  };
  /**
   * Семантическая подсветка файла: точные роли от сервера (см. `LspService.semanticTokens`).
   * Ответ уже разобран в main (там легенда сервера) — renderer получает готовые участки.
   */
  'lsp.semanticTokens': { params: { path: string; languageId?: string }; result: SemanticToken[] };
  /**
   * Отформатировать УЧАСТОК файла (`textDocument/rangeFormatting`): выделение или только
   * что вставленный кусок. Правки с позициями 1-based; пусто — сервер не умеет или менять
   * нечего. Инструмент проекта (ruff, prettier) так не умеет — он форматирует файл целиком.
   */
  'lsp.formatRange': {
    params: { path: string; startLine: number; startColumn: number; endLine: number; endColumn: number };
    result: TextEdit[];
  };

  /**
   * Словарь орфографии: слова из файла, найденного в системе (aspell, hunspell,
   * LibreOffice), и путь к нему. Пустой список и `null` — словаря в системе нет.
   */
  'spell.dictionary': { params: void; result: { words: string[]; source: string | null } };

  /* Отладчик: сессия debugpy по протоколу DAP. */
  /** Начать отладку файла интерпретатором окружения. */
  'debug.start': {
    params: { program: string; args?: string[]; env?: Record<string, string>; cwd?: string };
    result: { ok: boolean; message: string };
  };
  /**
   * Подключиться к уже запущенному процессу: он стартовал сам, и запускать его
   * заново нельзя — отлаживаем то, что работает.
   */
  'debug.attach': { params: DebugAttachOptions; result: { ok: boolean; message: string } };
  /** Точки останова файла: набор заменяется целиком, как в DAP. */
  'debug.setBreakpoints': {
    params: {
      path: string;
      breakpoints: Array<{ line: number; condition?: string; hitCondition?: string; logMessage?: string }>;
    };
    result: DebugBreakpoint[];
  };
  /**
   * Останов по исключению: какие исключения останавливают программу. Набор
   * заменяется целиком, как и точки останова.
   */
  'debug.setExceptionBreakpoints': { params: DebugExceptionFilters; result: void };
  'debug.continue': { params: void; result: void };
  'debug.step': { params: { kind: 'over' | 'into' | 'out' }; result: void };
  'debug.pause': { params: void; result: void };
  'debug.stop': { params: void; result: void };
  /** Области видимости кадра: локальные, глобальные. */
  'debug.scopes': { params: { frameId: number }; result: DebugScope[] };
  /** Значения области или раскрытого узла. */
  'debug.variables': { params: { reference: number }; result: DebugVariable[] };
  /**
   * Вычислить выражение в контексте кадра: панель «наблюдение».
   * Ошибка выражения — это результат, а не сбой: текст ошибки возвращается как значение.
   */
  'debug.evaluate': { params: { expression: string; frameId?: number }; result: DebugVariable };
  /**
   * Значение выражения для подсказки под курсором. Ошибку не показываем: `null`
   * означает «значения нет», и подсказка не появляется.
   */
  'debug.hover': { params: { expression: string; frameId?: number }; result: DebugVariable | null };
  /** Задать новое значение переменной или поля; `null` — отладчик не смог присвоить. */
  'debug.setVariable': { params: { reference: number; name: string; value: string }; result: DebugVariable | null };
  /** Задать значение произвольному выражению в кадре; `null` — присвоить не удалось. */
  'debug.setExpression': {
    params: { expression: string; value: string; frameId?: number };
    result: DebugVariable | null;
  };

  'ai.setApiKey': { params: { providerId: string; apiKey: string }; result: Settings };
  'ai.clearApiKey': { params: { providerId: string }; result: Settings };
  /** Ключ сервиса веб-поиска: отдельно от провайдеров — это не провайдер модели. */
  'ai.setWebSearchKey': { params: { apiKey: string }; result: Settings };
  'ai.clearWebSearchKey': { params: void; result: Settings };
  /**
   * Поднять серверы MCP из настроек и вернуть их инструменты. Нужно проверке в
   * настройках: без неё конфигурация сервера слепа — ошибку видно только в stderr.
   */
  'ai.mcpTools': { params: void; result: McpServerTools[] };
  /** Проверить адрес и ключ до сохранения провайдера. */
  'ai.test': {
    params: { baseUrl: string; apiKey?: string; providerId?: string };
    result: AiConnectionTestResult;
  };
  /**
   * Остаток на счёте у активного провайдера. `null` — либо провайдер такого
   * не умеет (локальные серверы, большинство OpenAI-совместимых), либо сервер
   * не ответил: это не ошибка, и попап просто не рисует строку про деньги.
   */
  'ai.balance': { params: void; result: AccountBalance | null };

  'ai.chat': { params: ChatRequest; result: ChatStreamDone };
  /**
   * Подсказка для inline-автодополнения: продолжить код в месте курсора.
   * Отдельно от `ai.chat` — это короткий запрос без истории и инструментов.
   */
  'ai.complete': { params: InlineCompletionRequest; result: InlineCompletionResult };
  /**
   * Сообщение коммита по diff: один запрос к модели без истории и инструментов.
   * Части промпта строит `shared/commit-message.ts` (обрезка diff, очистка ответа).
   */
  'ai.commitMessage': { params: CommitPromptParts; result: CommitMessageResult };
  /**
   * Тест к выделенному коду: один запрос без истории и инструментов, как сообщение
   * коммита. Промпт и очистка ответа — в `shared/test-generation.ts`.
   */
  'ai.generateTest': { params: TestPromptParts; result: TestGenerationResult };
  /**
   * Название беседы по первому обмену: один короткий запрос без истории и
   * инструментов, как у сообщения коммита. Пустое название — не ошибка.
   */
  'ai.chatTitle': { params: ChatTitleParts; result: ChatTitleResult };
  /**
   * Права доступа агента (кнопка в композере). Меняются и во время ответа:
   * main перечитывает их перед каждым действием, а не только в начале прогона.
   */
  'ai.setPermission': { params: { permission: PermissionPreset }; result: void };
  /** История бесед рабочей папки: renderer восстанавливает вкладки после запуска. */
  'ai.chats.load': { params: { root: string }; result: ChatHistory };
  /** Сохранение бесед: renderer — источник истины, main только пишет на диск. */
  'ai.chats.save': { params: { root: string; conversations: ChatConversation[]; activeUid?: string }; result: void };
  /**
   * Команды проекта (`.chui/commands`): готовые запросы для меню композера.
   * Список нужен интерфейсу, а не модели — в промпт он не идёт.
   */
  'ai.commands': { params: void; result: ProjectCommand[] };
  /**
   * Журнал прогонов (`ai.telemetry` в настройках): путь к файлу, его размер и
   * последние записи. Читает main — файл лежит вне рабочей папки, и открыть его
   * вкладкой редактора нельзя.
   */
  'ai.telemetry': { params: void; result: AiTelemetrySnapshot };
  /** Очистить журнал прогонов. */
  'ai.telemetryClear': { params: void; result: { ok: boolean } };
}

export type MethodName = keyof ChuiMethods;
export type ParamsOf<M extends MethodName> = ChuiMethods[M]['params'];
export type ResultOf<M extends MethodName> = ChuiMethods[M]['result'];
