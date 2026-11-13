import {
  ChatStreamEvent,
  type ApplyEditsHostParams,
  type ApplyEditsHostResult,
  type ApplyPatchesHostParams,
  type ChatAttachment,
  type ChatDeltaPayload,
  type ChatMessage,
  type PickedImage,
  type PlanStep,
  type ReasoningEffort,
  type Settings,
} from '../../shared/api';
import { sanitizeToolPreset, toolPresetSpec, type ToolPresetId } from '../../shared/tool-presets';
import { fileName, usedReferences, type UsedReferences } from '../../shared/tool-files';
import type { ApplyFailure, FileEdit } from '../../shared/edits';
import { expandCommandPrompt, findCommand, parseCommandInvocation, type ProjectCommand } from '../../shared/commands';
import { parallelRunNotice } from '../../shared/parallel-runs';
import { sessionAttachment } from '../../shared/session-context';
import { leaveQuestion, type RunLeaving } from '../../shared/run-keep';
import { composerAction, feedAction, focusAfterCard, recallStep, type ComposerAction } from '../../shared/run-keys';
import { isAutoTitle } from '../../shared/chat-title';
import { messageParts } from '../../shared/chat-sanitize';
import { addEditGrant, type EditGrant, matchingEditGrant, rememberedEditGrant } from '../../shared/agent-grants';
import { parentOf } from '../../shared/paths';
import { CHAT_ACTIONS, type ChatAction, parseChatAction } from '../../shared/chat-actions';
import { type CompactionFacts, compactionLines } from '../../shared/compaction-facts';
import { forkPlan } from './chat-fork';
import { showForkCompare } from './chat-fork-compare';
import { resolvePatches } from '../../shared/patch';
import { turnsSinceCompact } from './compact-turns';
import { restoreSent } from '../../shared/chat-attachments';
import {
  answerReserve,
  compactionBudgetChars,
  compactionMessage,
  needsCompaction,
  contextUsage,
} from '../../shared/context-fit';
import { contextWindow, maxOutputTokens, modelCapabilities } from '../../shared/providers';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { EditService } from '../core/edits';
import type { EditorApi } from '../core/editor-api';
import type { HostService } from '../core/host';
import { relativePath, type WorkspaceModel } from '../core/workspace-model';
import type { GitModel } from '../core/git-model';
import { createChatBranchSpace } from './chat-branch-space';
import { createChatRunning } from './chat-running';
import { describeThread } from '../../shared/chat-threads';
import type { RpcClient } from '../core/rpc';
import { basename, clear, h, type IconName, pulseOnClick, svgIcon } from './dom';
import { createSessionInfo, createUsageRing, type SessionInfoData } from './session-info';
import { createAttachments } from './chat-attachments';
import { enqueuePrompt, takeNextPrompt } from './chat-queue';
import { createChatQueueView } from './chat-queue-view';
import {
  addCheckpointFile,
  beginCheckpoint,
  hasCheckpoint,
  revertPlan,
  revertPreview,
  revertSummary,
  truncateCheckpoints,
} from './chat-checkpoints';
import { MAX_RUN_ARTIFACTS, type RunArtifacts } from '../core/artifacts';
import { createToolFeed, type ToolCardView } from './chat-tools';
import { createRunFold } from './run-fold';
import { runEndReport, type RunEndFile, type RunEndHow, type RunEndReport } from './run-end';
import { createMarkdownRenderer } from './chat-markdown';
import { createChatComposer } from './chat-composer';
import { createComposerMenu } from './chat-composer-menu';
import { createChangesPanel } from './chat-changes';
import { archivePlan, createPlanPanel } from './chat-plan';
import { createGoalPanel } from './chat-goal';
import { CONTINUE_PROMPT, createStreamRunner, type StreamCancelHandle } from './chat-stream';
import { contextIndexOf, findThreadIndex, scrollTargetFor } from './chat-session';
import type { ChatSession } from './chat-session';
import type { CodebasePlace } from '../../shared/meaning-search';
import { hunkAtLine } from '../../shared/hunk-lines';
import {
  approvalReviewNote,
  createAskPrompt,
  createCommandApproval,
  createPlanApproval,
  createEditReview,
  type ApprovalHost,
} from './chat-approvals';
import { mergePatchResult } from './chat-patches';
import { countLines, plural, snippetFor, titleFrom } from './chat-text';
import { formatChatDate } from '../../shared/chat-date';
import { createChatTabs, type ChatSearchHit } from './chat-tabs';
import { createRunInspector } from './run-inspector';
import { createChatCompact } from './chat-compact';
import { createChatPersistence, newChatUid } from './chat-persistence';
import { type ChatExportFormat, chatExportFileName, chatToJson, chatToMarkdown } from '../../shared/chat-export';
import { segmentsOf } from '../../shared/chat-find';
import { createChatFindBar } from './chat-find-bar';
import { createChatPromptNav } from './chat-prompt-nav';
import { showContextMenu } from './context-menu';
import { chatTabMenuPlan } from './chat-tab-menu';
import { isPopupOpen } from './popup-menu';
import { showToast } from './toast';
import {
  announceMessage,
  announceTitle,
  runEnd,
  runStatusLine,
  shouldRefocus,
  tailOf,
  type RunEnd,
  type RunOutcome,
} from './chat-notify';
import { errorText } from '../core/file-errors';

/**
 * Чем кончился ход.
 *
 * Не «получилось ли», а именно исход: `busy` — ассистент уже занят и вопрос не
 * ушёл, `unavailable` — не выбраны провайдер или модель, `failed` — модель
 * отказала, `stopped` — человек остановил генерацию.
 */
export type PromptRun = 'started' | 'failed' | 'stopped' | 'busy' | 'unavailable';

export interface ChatView {
  element: HTMLElement;
  /**
   * Строка статуса ассистента (режим и заполнение контекста). Композер её не
   * держит у себя: окно монтирует её в общую полосу статус-бара.
   */
  statusElement: HTMLElement;
  newChat(): void;
  /** Положить запрос в поле ввода новой беседы, не отправляя (автоматизации). */
  draftPrompt(text: string): void;
  stop(): void;
  /**
   * Дописать историю бесед немедленно, не дожидаясь паузы в 400 мс.
   *
   * Нужен на выгрузке окна: отложенный таймер до закрытия страницы не доживёт,
   * и последний выбор (набор инструментов, цель беседы) пропал бы.
   */
  flushHistory(): void;
  /** Набор инструментов активной беседы — его и надо считать «текущим». */
  currentToolPreset(): ToolPresetId;
  /** Проверка модели разрешила команду без человека. Строка ложится в ленту того
   * хода, что идёт сейчас: молча выполненное действие должно быть видно.
   */
  noteApprovalReview(command: string, reason: string): void;
  /**
   * main принял паузу или снял её.
   *
   * Событие `paused` внутри стрима не заменяет его: оно приходит только
   * на границе шага, а между нажатием и ею может пройти минуту (идёт терминал
   * или длинный вызов). До этого момента человек не знает, успело ли нажатие.
   * `uid` — чья пауза: при двух прогонах main адресует её беседе.
   */
  setPaused(value: boolean, uid?: string): void;
  /** Открыть окно «Прогон» для активной беседы (трасса последнего хода). */
  openRunLog(): void;
  askAboutSelection(mode: 'explain' | 'fix'): Promise<void>;
  applySettings(settings: Settings): void;
  /**
   * Приложить готовое изображение к вопросу — снимок страницы из встроенного браузера.
   * Через этот метод вложение кладётся в активную беседу, как из скрепки или Ctrl+V.
   */
  attachImage(image: PickedImage): void;
  /** Приложить коммит по хешу — `#commit` спрашивает хеш и зовёт это. */
  attachCommit(hash: string): void;
  /** Приложить снимок окна — `#screen`. */
  attachScreen(): void;
  /** Приложить готовый контекст (журнал консоли страницы и подобное). */
  attachContext(item: ChatAttachment): void;
}

/** Что чату нужно от окна настроек: только показать его. */
export interface SettingsOpener {
  open(): void;
}

export interface ChatDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  editors: EditorApi;
  edits: EditService;
  /**
   * Открыть файл так же, как это делают дерево и быстрое открытие. Клику по файлу
   * в ленте нельзя обойтись одним `editors.reveal`: среди открытых документа может
   * и не быть — агент его только что создал, — и показывать тогда нечего.
   */
  openFile?: (path: string) => Promise<void>;
  /**
   * Встать на место в открытом файле. Тот же приём, что у перехода по ссылке в
   * документе: открытие — дело `openFile`, место — `editors.reveal`.
   */
  revealAt?: (path: string, position?: { line?: number; column?: number }) => void;
  commands: CommandRegistry;
  /** Рабочая папка: её корень — ключ, по которому main находит историю бесед. */
  workspace: WorkspaceModel;
  /**
   * Изменения репозитория — для `#diff`. Необязательно: без него пункт не показывается,
   * ведь панель чата может жить и без открытого проекта.
   */
  git?: GitModel;
  /** Последний вывод активной вкладки терминала для `#terminal`. */
  terminalOutput?: () => { text: string; lines: number } | null;
  /**
   * Прогон кончился, а человек мог и не смотреть на ленту. Необязательно: без него
   * заметка всё равно выходит, только док и заголовок вкладки не подсвечиваются.
   */
  onRunEnd?(how: RunEnd, title: string): void;
  /**
   * Чем агент занят сейчас — для шапки панели и дока («сейчас: правит x.ts»).
   * `null` — работа кончилась. Зовётся на каждом вызове инструмента, поэтому
   * в UI обновлять надо ДЕШЕВО: без перерисовки ленты.
   */
  onBusyHint?(hint: string | null): void;
  /**
   * Видит ли человек ленту ПРЯМО СЕЙЧАС — панель раскрыта, окно не свёрнуто.
   *
   * Нужен отдельно от `document.hasFocus()`: свёрнутая правая колонка фокус не
   * отбирает, и по одному фокусу прогон считался бы просмотренным — ответ готов,
   * а окно пустое. Необязательно: без него считаем, что видит (старое поведение).
   */
  isChatVisible?(): boolean;
  /**
   * Спросить человека перед необратимым — тем же системным диалогом, что у Git.
   *
   * Нужен именно здесь: откат к вопросу молча меняет файлы и удаляет созданные
   * агентом. Необязателен ради тестов, но в окне всегда есть.
   */
  confirm(options: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /**
   * Показать файл в экране различий против HEAD. Нужен ревью правок: блок можно
   * разглядеть только там — в попапе изменений видна только одна цифра строк.
   * Необязательно: без него пункт просто не появляется.
   */
  openDiff?: (path: string, staged: boolean) => void;
  /** Артефакты прогона: что агент предъявил (`present`) — их же видит боковая панель. */
  artifacts?: RunArtifacts;
  /**
   * Места проекта по смыслу — для `#codebase`. Тот же поиск, что у палитры по смыслу;
   * необязательно: без него пункт молчит и говорит, почему.
   */
  codebase?: (query: string) => Promise<readonly CodebasePlace[]>;
  /** Адрес открытой страницы встроенного браузера — для `#web`. */
  browserUrl?(): string;
  /** Спросить хеш коммита для `#commit`. `null` — человек передумал. */
  askCommit?(): string | null;
  settings: Settings;
  /** Модальное окно со всеми настройками приложения. */
  settingsModal: SettingsOpener;
  /** Приёмник хостовых вызовов: правки приходят из main. */
  host: HostService;
}

/**
 * Панель ассистента — правый «остров» в стиле панели инструментов.
 *
 * Сама панель только ведёт беседу: отправляет запрос потоком (`rpc.stream`),
 * рисует ответ, правки и чек-лист плана по событиям. Агентный цикл — вызовы
 * инструментов шаг за шагом — живёт в main (`ai/service.ts`), а их описания
 * лежат в shared/tools.ts. Режим (ask/agent/plan) решает, какие инструменты
 * доступны и что подтверждается у пользователя.
 */
/**
 * План меню вкладки беседы — вынесен в `chat-tab-menu.ts`.
 *
 * Чистая функция жила здесь и тянула в знаменатель покрытия весь DOM-файл
 * (4.8k строк) ради одного теста. Переэкспорт — чтобы не трогать вызовы.
 */
export { chatTabMenuPlan } from './chat-tab-menu';

export function createChatPanel(deps: ChatDeps): ChatView {
  let settings = deps.settings;
  /**
   * Идёт ли прогон в АКТИВНОЙ беседе — по нему живёт поле ввода и кнопка.
   * Прогоны соседних бесед считаются в `runningIds`: они идут, но это не повод
   * гасить ввод там, где человек сейчас печатает.
   */
  let busy = false;
  /** Беседы, в которых прямо сейчас идёт прогон. */
  const runningIds = new Set<number>();
  /** Где какой прогон: по беседе — чтобы конец одного не стирал другой. */
  const runningSessions = new Map<number, ChatSession>();
  /**
   * Тянем ли ленту вниз автоматически. Пользователь прокрутил вверх —
   * стрим не дёргает ленту; вернулся к низу (или нажал кнопку) — снова тянем.
   */
  let autoScroll = true;
  /** Ожидания решений пользователя (ревью правок, подтверждение команды). */
  const pendingApprovals = new Set<() => void>();

  const sessions: ChatSession[] = [];
  let activeId = 0;
  let nextId = 1;
  /** Беседа, которая сейчас генерирует: хостовые вызовы приходят именно от неё. */
  let streamingSession: ChatSession | null = null;
  /**
   * Открытые потоки по беседам: `cancelActive` гасит последний открытый, а при
   * двух прогонах это может быть не та задача. Здесь у каждой беседы своя ручка.
   */
  const liveStreams = new Map<number, StreamCancelHandle>();
  /**
   * Чем кончился последний прогон: `setBusy(false)` зовётся и в `finally` стрима, где
   * исхода уже не видно, а сказать в доке надо именно исход.
   */
  let streamingOutcome: RunOutcome | null = null;
  const active = (): ChatSession => sessions.find((session) => session.id === activeId) ?? sessions[0]!;

  // `tabindex` — чтобы в ленту можно было вернуть фокус после ответа на
  // карточку. Без него фокус уходит в `document.body`, и следующий Tab
  // начинает обход страницы с начала — мимо чата.
  const body = h('div', { class: 'chat-body', tabindex: '-1' });

  const jumpButton = h(
    'button',
    {
      class: 'chat-jump',
      type: 'button',
      title: 'К последнему сообщению',
      onClick: () => stickToEnd(),
    },
    svgIcon('chevronDown', 16),
  );
  jumpButton.hidden = true;

  /**
   * Прокрутить ленту вниз БЕЗ сброса «слежу за низом».
   *
   * `scrollTop = scrollHeight` — это тоже программа: `scroll` придёт асинхронно и
   * пересчитает `autoScroll` по фактической позиции. Пока разметка не уложена
   * (только что вставлена, шрифты не пришли), `scrollHeight` меньше правды, и привязка
   * к низу слетала бы на ровном месте. Ставим флаг явно — прокрутка либо догонит низ,
   * либо `scroll` сделает то же самое.
   */
  function stickToEnd(): void {
    autoScroll = true;
    jumpButton.hidden = true;
    body.scrollTop = body.scrollHeight;
  }

  // Низ ленты — это «следить за ответом»; верх — «читать и не мешать».
  body.addEventListener('scroll', () => {
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    autoScroll = distance < 40;
    jumpButton.hidden = autoScroll;
  });
  /* ── композер: поле вопроса, режим, права, модель ─────────────────────── */

  // Панель ввода — отдельный модуль (`chat-composer.ts`): он владеет режимом и
  // правами и рисует свои контролы. Панель беседы только читает поле и подключает
  // к нему отправку и меню — для этого поле вынесено наружу алиасом `input`.
  const composer = createChatComposer({
    rpc: deps.rpc,
    onSend: (text) => void send(text),
    onStop: () => stop(),
    conversationForPause: () => (streamingSession ?? active()).uid,
    onOpenSettings: () => deps.settingsModal.open(),
    onContext: () => menu.toggleContext(),
    // Кнопки «файл / выделение / ошибки» — тот же путь, что у меню: одно действие
    // на вид контекста, а не второй способ приложить то же самое.
    onAttachQuick: (kind) => void attachments.attachFrom(kind),
    onPasteImages: (files) => void attachments.attachFiles(files),
    onEffortChange: (effort) => void saveEffort(effort),
    // Набор меняется и во время беседы: следующее действие увидит новый набор.
    onToolPresetChange: (preset) => void saveToolPreset(preset),
  });
  const input = composer.input;

  /**
   * ↑ в пустом поле возвращает прошлый вопрос — как в оболочке. `recallIndex` —
   * где стоит человек в списке вопросов этой беседы, `null` — в своём черновике.
   *
   * Живёт здесь, а не рядом с обработчиком: `activate`/`send` сбрасывают
   * состояние, а вызываются они раньше того места в коде.
   */
  let recallIndex: number | null = null;
  /** Что было набрано до первого ↑: «вперёд» за последний вопрос вернёт именно это. */
  let recallDraft = '';

  /*
    Клавиатура ленты.

    В ленту фокус приходит после ответа на карточку (см. `focusAfterCard`), а по
    Tab — нет: она `tabindex="-1"`, чтобы не удлинять обход окна. Но раз фокус
    тут оказался, листаться должно как в любом списке: PageUp/PageDown —
    страница, Home/End — край, Escape — обратно в поле ввода.

    Стрелки вверх/вниз не трогаем: Alt+↑/↓ в ленте уже прыгает по своим
    вопросам (см. `jumpToPrompt`), а прокрутку с прыжком не совместить.
  */
  body.addEventListener('keydown', (event) => {
    const action = feedAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    });
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'composer') {
      input.focus();
      return;
    }
    if (action === 'to-end') {
      stickToEnd();
      return;
    }
    // Листал руками — значит читает, а не следит за ответом: иначе следующий
    // пришедший токен утащил бы ленту вниз из-под глаз.
    autoScroll = false;
    jumpButton.hidden = false;
    if (action === 'to-start') body.scrollTop = 0;
    // Не полный экран, а экран минус строка: без перекрытия читать сшивку
    // страниц невозможно — теряется место, на котором остановился глаз.
    else if (action === 'page-up') body.scrollTop -= pageStep();
    else body.scrollTop += pageStep();
  });

  /** Шаг страницы ленты: чуть меньше видимой высоты, чтобы соседние экраны сшивались. */
  function pageStep(): number {
    return Math.max(80, body.clientHeight - 48);
  }

  /* ── команды проекта (`.chui/commands`) ───────────────────────────────────── */

  /**
   * Готовые запросы этого проекта: файлы лежат на диске, поэтому список приходит
   * из main. Кэш на панель — он пересобирается при смене папки и когда человек
   * нажимает `/`, а своих команд ещё нет.
   */
  let projectCommandList: ProjectCommand[] = [];
  let commandsPending = false;
  /** Список уже спросили: повторять на каждую букву после слэша незачем. */
  let commandsLoaded = false;

  async function loadProjectCommands(): Promise<void> {
    // Два нажатия `/` подряд не должны дать два запроса: второй ждёт первый.
    if (commandsPending) return;
    commandsPending = true;
    try {
      projectCommandList = await deps.rpc.request('ai.commands');
    } catch {
      // Проекта нет или каталог не читается — своих команд просто нет.
      projectCommandList = [];
    } finally {
      commandsPending = false;
      commandsLoaded = true;
    }
  }

  /**
   * Приложить прошлую беседу к вопросу: сослаться на разговор, а не пересказывать
   * его. Берём `history` — то, что видит модель (после сжатия там резюме), а не
   * ленту: в ленте карточки инструментов и картинки, для справки они лишние.
   */
  function mentionSession(uid: string): void {
    const found = sessions.find((item) => item.uid === uid);
    if (!found) {
      showToast('Беседа не найдена', 'error');
      return;
    }
    if (found === active()) {
      showToast('Это текущая беседа — она уже в контексте');
      return;
    }
    const context = sessionAttachment({ uid: found.uid, title: found.title, messages: found.history });
    // Пустая беседа — прикладывать нечего; об этом говорим прямо, иначе нажатие
    // выглядит как «ничего не произошло».
    if (!context) {
      showToast('В этой беседе ещё нет разговора — прикладывать нечего');
      return;
    }
    attachments.attachContext(context);
  }

  /**
   * `/имя хвост` → текст запроса. Неизвестное имя возвращается как есть: пусть
   * модель увидит написанное, чем поле молча очистится.
   */
  async function expandProjectCommand(written: string): Promise<string> {
    const invocation = parseCommandInvocation(written);
    if (!invocation) return written;
    if (projectCommandList.length === 0) await loadProjectCommands();
    const command = findCommand(projectCommandList, invocation.name);
    if (!command) return written;
    // Прицепки из шапки прикладываются и при отправке набранной руками команды,
    // а не только при выборе из меню: путь один — иначе они разойдутся.
    for (const kind of command.context ?? []) attachments.attachFrom(kind);
    return expandCommandPrompt(command, invocation.tail);
  }

  /* ── панель изменений, план агента и контекст к вопросу ──────────────────── */

  /**
   * Показать файл человеку: сперва открыть, потом встать на место. Документа может
   * не быть вовсе — созданный агентом файл в редакторе ещё не открывали, — и тогда
   * `editors.reveal` молчит: модели документа у него нет.
   */
  const revealFile = async (path: string, line = 1, column = 1): Promise<void> => {
    await deps.openFile?.(path);
    deps.revealAt?.(path, { line, column });
  };

  /**
   * «Источники» над ответом: какие файлы модель читала, пока его готовила.
   *
   * Свёрнуты в одну строку с числом: при длинном прогоне их десятки, и
   * развёрнутый список вытеснил бы сам ответ с экрана. Чипы открывают файл
   * тем же `revealFile`, что и `path:line` в тексте — одно поведение везде.
   * `null`, когда читать было нечего: пустая рамка — шум.
   */
  function referencesBlock(sources: UsedReferences): HTMLElement | null {
    if (sources.files.length === 0) return null;
    const details = h('details', { class: 'msg-references' }) as HTMLDetailsElement;
    // В счётчике — всё, включая усечённые: «Источники: 3» при пяти без
    // пометки врало бы о том, сколько файлов модель прочла на самом деле.
    const total = sources.files.length + sources.omitted;
    details.append(
      h('summary', { title: 'Файлы, которые ассистент читал, готовя этот ответ' }, 'Источники: ', String(total)),
    );
    const list = h('div', { class: 'msg-reference-list' });
    for (const file of sources.files) {
      // Подпись — короткое имя и номер строки: полный путь в чип не влезает,
      // а нужный файл человек узнаёт по имени. Полный — в подсказке.
      const label = file.from === undefined ? fileName(file.path) : `${fileName(file.path)}:${file.from}`;
      list.appendChild(
        h(
          'button',
          {
            class: 'md-path is-code',
            type: 'button',
            title: file.path,
            onClick: () => void revealFile(file.path, file.from ?? 1),
          },
          label,
        ),
      );
    }
    // Усечённые — отдельной фразой, а не молчанием: иначе счётчик обещает
    // больше, чем видно в списке, и человек ищет пропавшие файлы.
    if (sources.omitted > 0) list.appendChild(h('span', { class: 'msg-reference-more' }, `и ещё ${sources.omitted}`));
    details.appendChild(list);
    return details;
  }

  /** Кнопка файла-результата в ленте: та же пара, но место — только если агент его назвал. */
  const openPresented = async (path: string, position?: { line?: number; column?: number }): Promise<void> => {
    await deps.openFile?.(path);
    deps.revealAt?.(path, position);
  };

  /**
   * Проиндексировать блок, который начинается на строке `line`. Панель знает
   * границы блока, а `git` — только номер в diff: между ними общая `hunkAtLine`.
   * Номера берём свежие: пока панель была открыта, файл мог измениться.
   */
  async function stageHunkByLine(path: string, line: number): Promise<void> {
    if (!deps.git) return;
    const { unstaged } = await deps.git.fileHunks(path);
    const index = hunkAtLine(unstaged, line);
    if (index === null || index < 0) return;
    await deps.git.stageHunk(path, index);
    const current = active();
    changesPanel.render({ touched: current.touched, files: current.files, unsaved: 0 });
  }

  /** Вернуть файл к `HEAD`: без подтверждения — вызывающий сам решает цену. */
  async function discardFile(path: string): Promise<void> {
    if (!deps.git) return;
    await deps.git.discard([path]);
  }

  // Панель изменений и план агента — отдельные модули: они только рисуют по
  // состоянию беседы, а работа с документами и редактором остаётся здесь.
  const changesPanel = createChangesPanel({
    // Копирование пути отвечает тостом: буфер может отказать молча (окно без
    // фокуса), а молчащий отказ в «Копировать» — худший из возможных.
    notify: (message, kind) => showToast(message, kind),
    reveal: (path, line, column) => void revealFile(path, line, column),
    onRevert: () => void revertTouched(),
    onSave: () => void saveTouched(),
    // Блоки — из того же git, что у панели источника изменений: индекс читает
    // main, а здесь нужен лишь номер блока в diff файла.
    ...(deps.git
      ? {
          hunks: async (path: string) => (await deps.git!.fileHunks(path)).unstaged,
          onStageHunk: (path: string, hunk: { newStart: number }) => void stageHunkByLine(path, hunk.newStart),
          onDiscardFile: (path: string) => void discardFile(path),
          ...(deps.openDiff ? { openDiff: (path: string) => deps.openDiff?.(path, false) } : {}),
        }
      : {}),
  });
  const planPanel = createPlanPanel({
    // «До конца» — обычное сообщение: агент продолжает с того шага, где стоит.
    // Отдельной команды в main нет намеренно: продолжение — это такой же ход,
    // и оно должно попасть в историю беседы, как любой другой.
    onRunToEnd: () => void send('Продолжай по плану до конца, не останавливаясь на подтверждениях.'),
  });
  /**
   * Окно «Прогон»: трасса последнего прогона этой беседы. Одна на панель —
   * открывается из строки под ответом и командой «Прогон агента».
   */
  const runInspector = createRunInspector();
  // Окно живёт в корне документа, как и остальные модалки: панель чата может быть
  // в боковой колонке, и подложка окна не должна обрезаться её границами.
  document.body.appendChild(runInspector.element);
  /**
   * Цель работы. В отличие от плана не прячется по концу прогона: открытая цель
   * остаётся над композером, пока её не закроют модель или человек — иначе
   * непонятно, почему следующее действие агента началось само.
   */
  const goalPanel = createGoalPanel({
    onClose: () => {
      const session = active();
      if (!session.goal) return;
      session.goal = { ...session.goal, done: true };
      goalPanel.hide();
      scheduleSave();
    },
  });

  // Контекст, который пользователь прикладывает к вопросу (выделение, файл,
  // пометки, картинки, `@`-упоминания), и полоса чипов живут в отдельном модуле.
  // Панель только подключает его к активной беседе и к полю ввода.
  const attachments = createAttachments({
    rpc: deps.rpc,
    documents: deps.documents,
    editors: deps.editors,
    workspace: deps.workspace,
    ...(deps.git ? { git: deps.git } : {}),
    ...(deps.openFile ? { openFile: deps.openFile } : {}),
    // Вывод терминала — снимок последних строк: панель решает, что считать выводом.
    ...(deps.terminalOutput ? { terminalOutput: deps.terminalOutput } : {}),
    // Места проекта — тот же поиск по смыслу, что у палитры: `#codebase` спрашивает его
    // по тому, что уже набрано в поле ввода.
    ...(deps.codebase ? { codebase: deps.codebase } : {}),
    ...(deps.browserUrl ? { browserUrl: deps.browserUrl } : {}),
    // Коммит спрашиваем: «вот этот» почти всегда не последний.
    ...(deps.askCommit ? { askCommit: deps.askCommit } : {}),
    composerText: () => input.value,
    session: () => active(),
    // Бюджет вложений — тот же расчёт, что у кольца и у проверки перед отправкой
    // (`ensureContextFits`), но с сессией без вложений: тогда `used` — это ровно
    // всё, что уйдёт помимо них (история, инструкции, инструменты, новый вопрос).
    attachmentBudget: () => {
      const session = active();
      const base = contextUsage(sessionInfoData({ ...session, attachments: [] }, input.value));
      const full = contextUsage(sessionInfoData(session, input.value));
      return {
        limit: full.limit,
        overhead: base.used,
        reserve: answerReserve(maxOutputTokens(currentModel(), settings.ai.maxTokens), full.limit),
      };
    },
    focus: () => input.focus(),
  });

  /* ── меню композера: слэш-команды и контекст ───────────────────────────── */

  // Меню (слэш-команды, `#`-контекст и `@`-файлы) живёт в отдельном модуле:
  // сама панель только строит его и слушает поле ввода. Работа с редактором и
  // проектом остаётся здесь — модуль просит её через колбэки.
  const menu = createComposerMenu({
    input,
    onContext: (kind) => attachments.attachFrom(kind),
    // Цена вида и уже набранное — из того же расчёта, что и кольцо (`syncSessionInfo`):
    // иначе цифра в меню разошлась бы с заполнением контекста.
    contextCost: (kind) => {
      const item = attachments.contextPrice(kind);
      if (item === null) return null;
      return { attached: attachments.attachedTokens(), item };
    },
    onAttachBest: () => attachments.attachBest(),
    onPickImage: () => void attachments.attachImagesFromDialog(),
    onMention: (path) => attachments.attachMention(path),
    mentionPaths: () => attachments.mentionPaths(),
    requestMentions: () => attachments.requestMentions(),
    // Текущую беседу в подсказку не отдаём: приложить разговор к нему же
    // самому — это удвоить контекст без пользы. Пустые тоже: в них нечего читать,
    // и выбор такой беседы выглядел бы как «ничего не произошло».
    sessions: () =>
      sessions
        .filter((item) => item.id !== activeId && item.history.length > 0)
        .map((item) => ({ uid: item.uid, title: item.title })),
    onMentionSession: (uid) => mentionSession(uid),
    projectCommands: () => projectCommandList,
    requestCommands: () => {
      // Спрашиваем один раз: иначе каждая буква после слэша шла бы в main.
      if (!commandsLoaded) void loadProjectCommands();
    },
    // Свои команды беседы из меню — тем же путём, что и набранные руками:
    // два пути разошлись бы по поведению через месяц.
    onChatAction: (id) => {
      const action = CHAT_ACTIONS.find((item) => item.id === id);
      if (action) void runChatAction(action, '');
    },
  });

  // Перетаскивание файла на панель чата: тот же результат, что вставка из буфера.
  // Слушатели вешаются ниже, когда корневой элемент уже собран.

  // Меню живёт поверх панели: закрываем его кликом мимо, как всплывающие слои.
  document.addEventListener('pointerdown', (event) => {
    if (!menu.isOpen()) return;
    const node = event.target as Node;
    if (menu.element.contains(node) || composer.element.contains(node)) return;
    menu.hide();
  });

  /* ── беседы: вкладки в стиле вкладок редактора ───────────────────── */

  // Полоса вкладок и поиск по беседам — отдельный модуль (`chat-tabs.ts`): он
  // рисует по списку бесед, а переключение, закрытие, меню и переход к
  // найденному приходят к беседам колбэками. Состояние бесед остаётся здесь.
  const tabs = createChatTabs({
    onActivate: (id) => activate(id),
    onClose: (id) => closeSession(id),
    onNewChat: () => newChat(),
    onMenu: (id, event) => openTabMenu(id, event),
    search: (query) => searchChats(query),
    onPickSearch: (id, query) => pickSearchHit(id, query),
    focusInput: () => input.focus(),
  });

  /** Контекстное меню вкладки беседы: выгрузить в .md или .json, либо закрыть. */
  function openTabMenu(id: number, event: MouseEvent): void {
    const session = sessions.find((item) => item.id === id);
    const empty = !session || (session.transcript.length === 0 && session.history.length === 0);
    const others = sessions.length > 1;

    showContextMenu(
      chatTabMenuPlan(
        { empty, others },
        {
          exportAs: (format) => void exportSession(id, format),
          close: () => closeSession(id),
          // «Другие» и «все» — по одной через `closeSession`: у каждой беседы
          // может быть свой прогон, и путь закрытия умеет про него спросить.
          closeOthers: () => {
            for (const session of [...sessions]) if (session.id !== id) closeSession(session.id);
          },
          closeAll: () => {
            for (const session of [...sessions]) closeSession(session.id);
          },
        },
      ),
      event.clientX,
      event.clientY,
    );
  }

  /**
   * Экспорт беседы (`.md` или `.json`): путь спрашивает main (`chat.export`), файл
   * пишет он же.
   *
   * Берём `transcript`, а не `history`: после сжатия в контексте осталось резюме,
   * и выгружать оттуда — значит отдать файл, где половины разговора нет. Именно ту
   * половину и хотят показать.
   */
  async function exportSession(id: number, format: ChatExportFormat = 'markdown'): Promise<void> {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;

    const messages = session.transcript.length > 0 ? session.transcript : session.history;
    if (messages.length === 0) {
      showToast('В беседе нечего выгружать', 'info');
      return;
    }

    // Дата — в экспорте и в имени файла: два выгруза одной беседы за разные дни
    // не должны затирать друг друга в папке загрузок.
    const today = new Date().toISOString().slice(0, 10);
    const meta = {
      title: session.title,
      date: today,
      model: currentModel(),
      workspace: deps.workspace.root ?? undefined,
    };
    // Форматов два и они расходятся не вёрсткой, а смыслом: Markdown — чтобы
    // показать человеку, JSON — чтобы разобрать скриптом. Общая у них только
    // выборка сообщений (видна в chat-export).
    const contents = format === 'json' ? chatToJson(messages, meta) : chatToMarkdown(messages, meta);

    try {
      const result = await deps.rpc.request('chat.export', {
        contents,
        name: chatExportFileName(session.title, today, format),
      });
      // Отмена в диалоге — не ошибка и не повод для тоста.
      if (result.path) showToast(`Беседа выгружена: ${result.path}`, 'info');
    } catch (error) {
      showToast(`Не удалось выгрузить беседу: ${String(error)}`, 'error');
    }
  }

  /** Поиск по беседам: одна строка на беседу, в которой нашлось совпадение. */
  function searchChats(query: string): ChatSearchHit[] {
    const text = query.trim().toLowerCase();
    if (text === '') return [];
    const hits: ChatSearchHit[] = [];
    for (const session of sessions) {
      // Сначала дата: «12.03», «март», «2026-03» — беседы за время, без слов.
      // Так ищут, когда помнят «когда», а не «о чём».
      if (matchesDate(session.updatedAt, text)) {
        hits.push({
          id: session.id,
          title: session.title,
          snippet: `изменена ${formatChatDate(session.updatedAt)}`,
          updatedAt: session.updatedAt,
        });
        continue;
      }
      // Транскрипт, а не история: после компакции в `history` остаётся резюме,
      // и слова из старых сообщений иначе не найти.
      for (const message of session.transcript) {
        const snippet = snippetFor(message.content ?? '', query);
        if (snippet === null) continue;
        hits.push({ id: session.id, title: session.title, snippet, updatedAt: session.updatedAt });
        break; // одна строка на беседу — список читается легче
      }
    }
    // Свежие сверху: в поиске по старым беседам чаще нужна последняя.
    return hits.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Совпадает ли дата беседы с запросом: «2026-03», «12.03», «март», «12». */
  function matchesDate(at: number, query: string): boolean {
    if (at <= 0) return false;
    return formatChatDate(at).toLowerCase().includes(query);
  }

  /** Таймер снятия подсветки поиска: она подсказка, а не разметка ленты. */
  let searchHitTimer = 0;

  /** Клик по результату поиска: открыть беседу и показать найденное место. */
  function pickSearchHit(id: number, query: string): void {
    activate(id);
    const target = sessions.find((session) => session.id === id);
    if (!target) return;
    // Прошлую подсветку снимаем: без этого она копилась бы по всем поискам и
    // осталась бы в ленте навсегда.
    for (const session of sessions) {
      for (const marked of session.thread.querySelectorAll('.is-search-hit')) marked.classList.remove('is-search-hit');
    }
    requestAnimationFrame(() => {
      const node = [...target.thread.querySelectorAll('.msg')].find((el) =>
        (el.textContent ?? '').toLowerCase().includes(query),
      );
      if (!node) return;
      node.scrollIntoView({ block: 'center' });
      node.classList.add('is-search-hit');
      if (searchHitTimer) clearTimeout(searchHitTimer);
      searchHitTimer = window.setTimeout(() => node.classList.remove('is-search-hit'), 2500);
    });
  }

  /**
   * Отметки совпадений внутри ленты — отдельно от `.is-search-hit` хита из
   * вкладок: у них разная жизнь. Здесь отметок много (все совпадения сразу),
   * и живут они до смены запроса, а там — одна и по таймеру.
   */
  const findMarks: HTMLElement[] = [];

  function clearFindMarks(): void {
    // Обводку снимаем здесь же: это единственное место, которое знает и о
    // закрытии поиска, и о смене запроса.
    for (const session of sessions) {
      for (const marked of session.thread.querySelectorAll('.is-find-current')) {
        marked.classList.remove('is-find-current');
      }
    }
    // Разметку снимаем по одной: `replaceChild` перестраивает узел,
    // и живые ссылки на текст после первой замены указывали бы уже в никуда.
    for (const mark of findMarks.splice(0)) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    }
  }

  /**
   * Прокрутить к совпадению и обвести его.
   *
   * `block: 'center'` — потому что поиск часто попадает в длинное сообщение:
   * у верхнего края видно только его начало и непонятно, что нашлось.
   * `behavior: 'auto'` намеренно: плавная прокрутка трёхсот сообщений занимает
   * секунды, и человек успевает нажать Enter ещё пять раз.
   */
  function revealFindMatch(target: { text: string; element: HTMLElement }, query: string, index: number): void {
    target.element.scrollIntoView({ block: 'center', behavior: 'auto' });
    markFindMatches(target.element, query, index);
    // Обводка — ПОСЛЕ разметки: `markFindMatches` первым делом снимает прежние
    // пометки вместе с обводкой, и поставленная до неё не дожила бы до экрана.
    // Таймером её не гасим: Esc должен снимать обводку сразу, а таймер о
    // закрытии полосы не знает и оставлял бы сообщение обведённым.
    target.element.classList.add('is-find-current');
  }

  /**
   * Обвести ВСЕ совпадения в сообщении и особенно сильно — текущее.
   *
   * Сначала снимаем прежние пометки: `textContent` сообщения меняется при этом
   * обратно на исходный, иначе следующая разметка вставляла бы `<mark>` внутрь
   * `<mark>`, а поиск внутри разметки нашёл бы куски, которых в тексте нет.
   */
  function markFindMatches(element: HTMLElement, query: string, current: number): void {
    clearFindMarks();
    if (query.length === 0) return;
    // Только текстовые узлы: не трогаем обработчики кнопок «копировать» и
    // подсветку кода внутри ответа — пересборка их бы убила.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      texts.push(node as Text);
    }

    let seen = 0;
    for (const textNode of texts) {
      const value = textNode.nodeValue ?? '';
      const pieces = segmentsOf(value, query);
      if (!pieces.some((piece) => piece.match)) continue;

      const fragment = document.createDocumentFragment();
      for (const piece of pieces) {
        if (!piece.match) {
          fragment.appendChild(document.createTextNode(piece.text));
          continue;
        }
        const mark = document.createElement('mark');
        mark.className = seen === current ? 'find-mark is-current' : 'find-mark';
        mark.textContent = piece.text;
        fragment.appendChild(mark);
        findMarks.push(mark);
        seen += 1;
      }
      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    // Текущее совпадение может оказаться за пределами окна по вертикали даже
    // внутри центрированного сообщения — доводим до него.
    const active = findMarks[current];
    if (active) active.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  function renderTabs(): void {
    tabs.render(
      sessions.map((session) => {
        const running = runningIds.has(session.id);
        return {
          id: session.id,
          title: session.title,
          streaming: running,
          // Нить: чем занята и сколько стоила. Цена — из накопленного следа
          // беседы, поэтому переживает перезапуск и не сбрасывается ходом.
          thread: describeThread({
            id: session.id,
            running,
            hasHistory: session.history.length > 0,
            // Оборванный прогон — не «упала», а «остановлена»: `aborted` значит, что
            // его прервали, и решать человеку тут нечего. Падения в ленте видны
            // сообщением, но отдельного признака в беседе для них нет — не выдумываем.
            failed: false,
            model: currentModel(),
            ...(session.trace ? { trace: session.trace } : {}),
          }),
        };
      }),
      activeId,
    );
  }

  function createSession(uid = newChatUid()): ChatSession {
    const session: ChatSession = {
      id: nextId,
      uid,
      title: `Беседа ${nextId}`,
      // Новая беседа ещё не сохранена — даты у неё нет, и в поиске по дате она не всплывает.
      updatedAt: 0,
      // `role="log"` — лента читается диктором: новое сообщение объявляется само,
      // не только когда в него ткнут мышью. `polite` — не перебивать набор в поле.
      thread: h('div', { class: 'chat-thread', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' }),
      history: [],
      transcript: [],
      touched: new Map(),
      files: [],
      artifacts: [],
      attachments: [],
      fold: createRunFold(),
      draft: '',
      // `undefined` = беседа ещё ни разу не показывалась: только ей ставим конец.
      scrollTop: undefined,
    };
    nextId += 1;
    sessions.push(session);
    body.appendChild(session.thread);
    renderIntro(session);
    return session;
  }

  /** Переключение вкладки: меняются лента, черновик, чипы и панель изменений. */
  function activate(id: number): void {
    const current = active();
    if (current.id === id) return;

    current.draft = input.value;
    // Позиция прежней беседы — ДО скрытия: у `hidden` ленты браузер отдаёт 0.
    current.scrollTop = body.scrollTop;
    closeApprovals();
    menu.hide();
    activeId = id;
    // Поле и кнопка — про эту беседу: у соседней прогон может идти, а здесь — нет.
    syncBusy();

    for (const session of sessions) session.thread.hidden = session.id !== id;
    const next = active();
    input.value = next.draft;
    // История вопросов у каждой беседы своя: индекс с прежней вкладки здесь — чужой.
    resetRecall();
    // Очередь живёт в ленте своей беседы: при возврате на вкладку она должна быть
    // на месте, иначе спрятанные вопросы человеку не видны и не снимаются.
    renderQueue(next);
    attachments.render();
    renderChanges();
    // Артефакты — тоже свойство беседы: у соседней вкладки свои файлы.
    deps.artifacts?.set(next.artifacts ?? []);
    goalPanel.render(next.goal ?? null);
    // Панель плана одна на все вкладки: без перерисовки на новой вкладке
    // остался бы чек-лист предыдущей беседы — или её пустота вместо плана.
    const nextPlan = planPanelOf(next);
    if (nextPlan) planPanel.render(nextPlan);
    else planPanel.hide();
    renderTabs();
    syncSessionInfo();

    // Занятость общая: прогон в окне один, поэтому и поле одно на все вкладки.
    input.disabled = busy;
    // К низу — только на первом показе. Дальше позиция у каждой беседы своя
    // (полоса одна на всех): возврат восстанавливает её, а не ставит конец.
    const target = scrollTargetFor(next);
    if (target === 'end') {
      next.scrollTop = undefined;
      stickToEnd();
    } else {
      body.scrollTop = target;
      // Браузер обрежет до реального низа, пока высота не устоялась: флаг считаем
      // по факту, а не верим сохранённому числу.
      autoScroll = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      jumpButton.hidden = autoScroll;
    }
    input.focus({ preventScroll: true });
  }

  /**
   * Вкладка уже спросила про прогон и получила «да»: второй раз не спрашиваем.
   * `closeSession` синхронный, а вопрос — нет, и делать асинхронным весь путь
   * закрытия (с вкладками, черновиками и перерисовкой) ради одного вопроса —
   * цена больше пользы. Поэтому ответ ловится в `.then`, а закрытие
   * повторяется уже без вопроса.
   */
  let skipLeaveAsk = false;

  /**
   * Спросить, можно ли бросать прогон в закрываемой вкладке. `true` — можно.
   */
  function safelyLeaveRun(session: ChatSession): boolean {
    if (skipLeaveAsk) return true;
    const files = session.activeCheckpoint?.files.size ?? 0;
    const steps = session.run?.steps.length ?? 0;
    const state: RunLeaving = files > 0 ? 'wrote' : steps > 0 ? 'read' : 'idle';
    const message = leaveQuestion(state, files, steps);
    if (!message) return true;

    void deps
      .confirm({
        title: 'Закрыть вкладку с идущим ответом?',
        message,
        detail: 'Прогон оборвётся. Файлы, которые агент уже изменил, останутся как есть.',
        confirmLabel: 'Закрыть',
      })
      .then((confirmed) => {
        if (!confirmed) return;
        skipLeaveAsk = true;
        try {
          closeSession(session.id);
        } finally {
          skipLeaveAsk = false;
        }
      });
    return false;
  }

  /** Закрытие вкладки. Последнюю не закрываем — вместо неё появляется пустая. */
  function closeSession(id: number): void {
    // Черновик уходящей вкладки забираем ДО всего остального. Поле ввода одно на
    // всё окно: без этого набранное в закрываемой беседе стиралось бы молча.
    const leaving = sessions.find((session) => session.id === id);
    if (leaving) leaving.draft = input.value;

    if (sessions.length === 1) {
      newChat();
      return;
    }

    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;

    // Прогон в закрываемой вкладке мог уже править файлы. Прежде он обрывался
    // молча (`cancelActive()` подряд), и сделанное терялось без единого слова.
    // Спрашиваем только там, где есть что терять; чтение и бездействие
    // обрываются молча — вопрос, на который всегда жмут «да», перестаёт
    // читаться, и в тот раз, когда он важен, его прожмут так же.
    const leavingRun = sessions[index]!;
    // Прогон — по беседе, а не по «одной живой»: при двух задачах закрытие
    // вкладки с чужой беседы не должно ни спрашивать, ни обрывать её.
    if (runningIds.has(leavingRun.id) && !safelyLeaveRun(leavingRun)) return;

    const [removed] = sessions.splice(index, 1);
    removed?.thread.remove();
    if (removed) {
      runningIds.delete(removed.id);
      runningSessions.delete(removed.id);
      // Гасим именно её поток, если вкладку закрыли посреди прогона.
      liveStreams.get(removed.id)?.cancel();
    }

    if (activeId === id) {
      activeId = sessions[Math.min(index, sessions.length - 1)]!.id;
      const next = active();
      for (const session of sessions) session.thread.hidden = session.id !== next.id;
      input.value = next.draft;
      attachments.render();
      renderChanges();
      const nextPlan = planPanelOf(next);
      if (nextPlan) planPanel.render(nextPlan);
      else planPanel.hide();
    }

    renderTabs();
    syncSessionInfo();
    scheduleSave();
  }

  function syncTabTitle(session: ChatSession, text: string): void {
    session.title = titleFrom(text);
    renderTabs();
    scheduleSave();
  }

  /**
   * Беседы, про которые название уже спрашивали. Спрашиваем один раз: заголовок
   * по первому вопросу («проверь, что тут слома…») в полосе из пяти вкладок не
   * различается, а название по сути разговора — различается.
   */
  const namedSessions = new Set<string>();

  /**
   * Переименовать беседу по первому обмену. Спрашиваем после первого ответа:
   * до него у модели нет ничего, кроме вопроса, а название нужно про разговор.
   *
   * Молчание модели — не ошибка: останется заголовок по вопросу, он рабочий.
   * Заголовок, который уже дала модель (или пришедший из файла), не трогаем.
   */
  async function maybeNameSession(session: ChatSession): Promise<void> {
    if (namedSessions.has(session.uid)) return;
    const question = session.history.find((message) => message.role === 'user')?.content ?? '';
    const answer = session.history.find((message) => message.role === 'assistant')?.content ?? '';
    // Ответа ещё нет — попробуем на следующем ходе, отметку не ставим.
    if (!question.trim() || !answer.trim()) return;
    namedSessions.add(session.uid);
    if (!isAutoTitle(session.title, question)) return;

    const result = await deps.rpc.request('ai.chatTitle', { question, answer }).catch(() => null);
    const title = result?.title.trim() ?? '';
    if (!title) return;
    // Пока модель думала, человек мог переключить вкладку: заголовок принадлежит
    // СВОЕЙ беседе, поэтому пишем в неё, а не в активную.
    session.title = title;
    renderTabs();
    scheduleSave();
  }

  /* ── сохранение бесед ─────────────────────────────────────────────────────
   * Источник истины — renderer: он собирает ленту и историю, а main пишет файл
   * по корню проекта. Вся возня с записью, задержкой и переключением папок —
   * в `chat-persistence.ts`: панель отдаёт снимок бесед и принимает
   * восстановленную историю, а остальное остаётся модулю.
   */

  const persistence = createChatPersistence({
    rpc: deps.rpc,
    workspace: deps.workspace,
    snapshot: () => {
      const current = active();
      return { sessions, ...(current ? { activeUid: current.uid } : {}) };
    },
    // Восстановление: вкладки и ленты строятся по сохранённой истории.
    restore: (history) => {
      for (const session of sessions) session.thread.remove();
      sessions.length = 0;
      nextId = 1;

      for (const conversation of history.conversations) {
        const session = createSession(conversation.uid);
        session.title = conversation.title;
        session.updatedAt = conversation.updatedAt;
        // Лента — из переписки, контекст — из сжатой части, если беседа сжималась.
        session.transcript = [...conversation.messages];
        session.history = [...(conversation.context ?? conversation.messages)];
        // Сжатый контекст пришёл из файла — отметку в ленте тоже восстанавливаем,
        // иначе после перезапуска непонятно, почему ответы не растут в контексте.
        session.compacted = Boolean(conversation.context);
        session.usage = conversation.usage;
        // Из файла нельзя понять, к той ли истории относится расход: считаем его
        // устаревшим, и про кеш судим только после первого нового ответа.
        session.usageFresh = false;
        session.turnsSinceCompact = 0;
        session.trace = conversation.trace;
        // Набор правил из прошлого хода: отметка в ленте появится не «впервые»,
        // а только когда правила действительно поменялись.
        session.instructions = conversation.instructions;
        session.goal = conversation.goal;
        // План прошлого прогона: закрытое окно посреди работы не должно
        // оставлять панель пустой — шаги нужны тому же праву, что и цель.
        session.plan = conversation.plan;
        session.planHistory = conversation.planHistory;
        // Память чтений из файла: следующий ход после открытия окна не начнётся
        // с чистого листа и не перечитает то, что уже читали до закрытия.
        session.reads = conversation.reads;
        // Набор инструментов из файла — выбор этой беседы. Нет его — берётся общий
        // из настроек (см. `syncToolPreset`): так старые файлы читаются без миграции.
        session.toolPreset = conversation.toolPreset;
        // Перенесённый через сжатие контекст: следующий пересказ не должен потерять
        // присланные файлы.
        session.kept = conversation.keptAttachments;
        // Черновик: окно, закрытое с набранным вопросом, открывается с ним же.
        session.draft = conversation.draft ?? '';

        renderHistory(session);
      }
      if (sessions.length === 0) createSession();

      const restored = history.activeUid ? sessions.find((item) => item.uid === history.activeUid) : undefined;
      activeId = (restored ?? sessions[0]!).id;
      syncActiveView();
      // Панель одна на все вкладки: после старта показываем план той беседы,
      // которая открыта, иначе чек-лист прогона терялся до следующего события.
      const shown = planPanelOf(restored ?? sessions[0]!);
      if (shown) planPanel.render(shown);
      else planPanel.hide();
      // Старт всегда открывает беседу с конца — там последний ответ. Один
      // `scrollTop` тут не годится: лента только что вошла в документ, и картинки
      // с карточками файлов ещё не получили высоту (см. `scrollToEndSoon`).
      scrollToEndSoon(restored ?? sessions[0]!);
    },
    // Корень сменился после старта: список путей для `@` собираем заново, а
    // команды проекта — уже другие файлы.
    onRootChanged: () => {
      attachments.requestMentions();
      // Другая папка — другие файлы: список команд собираем заново.
      commandsLoaded = false;
      void loadProjectCommands();
    },
  });

  /** Записать беседы с задержкой: пачка правок даёт один файл. */
  const scheduleSave = (): void => persistence.schedule();

  /**
   * Дописать историю немедленно, не дожидаясь паузы `SAVE_DELAY`.
   *
   * Нужно ровно на закрытии окна: `beforeunload` успевает отправить запрос, а
   * отложенный таймер — нет, страница умирает раньше. Без этого последний выбор
   * (набор инструментов) терялся, если человек закрывал окно в пределах 400 мс
   * после клика.
   */
  function flushHistory(): void {
    persistence.flush();
  }

  /**
   * Набор инструментов активной беседы — не выдумка, а то, что реально лежит
   * в сессии. Панель настроек сверяет с ним кнопку «Агент», когда жмёт
   * «включить ассистента»: без этого глобальная настройка молча перебивала бы
   * выбор, сделанный в беседе, и кнопка звала бы к набору, которого нет.
   */
  function currentToolPreset(): ToolPresetId {
    return sanitizeToolPreset(active().toolPreset ?? settings.ai.toolPreset);
  }

  /**
   * План беседы в виде, который принимает панель: пустой список — это тоже
   * ответ (плана нет), но `undefined` — «показать нечего» — отличается тем, что
   * панель нужно прятать, а не рисовать с нулём шагов.
   */
  function planPanelOf(session: ChatSession): PlanStep[] | undefined {
    return session.plan && session.plan.length > 0 ? session.plan : undefined;
  }

  /** Обновить вид активной беседы после восстановления вкладок. */
  function syncActiveView(): void {
    const next = active();
    for (const session of sessions) session.thread.hidden = session.id !== next.id;
    input.value = next.draft;
    attachments.render();
    renderChanges();
    // Цель принадлежит беседе, а панель над полем одна — показываем цель той,
    // что открыта: у соседней вкладки может быть своя, и путать их нельзя.
    goalPanel.render(next.goal ?? null);
    const nextPlan = planPanelOf(next);
    if (nextPlan) planPanel.render(nextPlan);
    else planPanel.hide();
    // Набор инструментов у каждой беседы свой: показать соседкин — значит соврать
    // о том, что уйдёт модели следующим вопросом.
    syncToolPreset();
    renderTabs();
    syncSessionInfo();
  }

  /**
   * Восстановление ленты по истории. Вызовы инструментов рисуем теми же
   * карточками, что и при живом ответе: беседа после перезапуска должна
   * читаться так же, как читалась до него.
   */
  function renderHistory(session: ChatSession): void {
    clear(session.thread);
    // `clear` сносит и строку очереди: без перерисовки она исчезла бы из ленты
    // при любом восстановлении истории, хотя вопросы в ней остались.
    session.queueNode = undefined;
    if (session.transcript.length === 0) {
      renderIntro(session);
      renderQueue(session);
      return;
    }

    const cards = new Map<string, ToolCardView>();
    const lastIndex = session.transcript.length - 1;
    session.transcript.forEach((message, index) => {
      if (message.role === 'user') {
        // Служебный дострой обрезанного ответа — не вопрос человека: в ленте не показываем.
        if (message.content === CONTINUE_PROMPT) return;
        appendMessage(
          session,
          'user',
          message.content,
          () => editUserMessage(session, index, message.content),
          message.images ?? [],
          // Кнопка отката есть только там, где снимок ещё в памяти: после перезапуска
          // чекпойнты пропадают, и обещать возврат нечего.
          hasCheckpoint(session, index) ? () => void revertToCheckpoint(session, index) : undefined,
        );
        return;
      }

      if (message.role === 'assistant') {
        const el = h('div', { class: 'msg msg-assistant' });
        // Источники — над ответом, а не под ним: человеку важно, на что
        // опирается ответ, ДО чтения, а подпись внизу он пролистает.
        // Только у ответов с содержанием: у промежуточной болтовни перед
        // вызовом инструмента источников ещё нет.
        if (message.content) {
          const sources = referencesBlock(usedReferences(session.history.slice(0, index + 1)));
          if (sources) el.appendChild(sources);
        }
        // Рисуем по партам, а не по полям: так вызов стоит в ленте там, где он
        // был между текстами, а не свален в кучу в конце ответа. Старые беседы
        // без `parts` проходят через тот же путь — `messageParts` выводит их из
        // плоских полей.
        const parts = messageParts(message);
        const hasTool = parts.some((part) => part.kind === 'tool');
        const feed = hasTool
          ? createToolFeed(el, null, undefined, async (path) => {
              await revealFile(path);
            })
          : undefined;
        for (const [index, part] of parts.entries()) {
          if (part.kind === 'text') {
            // Текст, за которым последовал вызов инструмента, — промежуточный:
            // пузырём, чтобы он не сливался со строками действий. Смотрим на
            // следующий парт, а не на наличие вызовов вообще.
            const interim = parts.slice(index + 1).some((next) => next.kind !== 'text');
            const content = h('div', { class: interim ? 'msg-body msg-note' : 'msg-body' });
            markdown.renderInto(content, part.text);
            el.appendChild(content);
          } else if (part.kind === 'tool' && feed) {
            cards.set(part.call.id, feed.add({ id: part.call.id, name: part.call.name, args: part.call.arguments }));
          }
        }
        feed?.seal();
        // «Повторить» — только у последнего ответа: повторять середину беседы нечем.
        if (message.content) {
          const text = message.content;
          attachAssistantActions(
            el,
            () => text,
            index === lastIndex ? () => void regenerate(session) : undefined,
            feedbackFor(session, index),
          );
        }
        if (el.childElementCount > 0) currentTurn(session).appendChild(el);
        return;
      }

      // Результат инструмента: карточке из прошлого шага дописываем итог.
      if (message.role === 'tool') {
        const card = message.toolCallId ? cards.get(message.toolCallId) : undefined;
        const failed = message.content.startsWith('Ошибка:');
        card?.finish({
          id: message.toolCallId ?? '',
          name: message.name ?? '',
          ok: !failed,
          summary: failed ? message.content.slice(0, 120) : 'готово',
          detail: message.content,
        });
      }
    });
    // Сжатая беседа: отметка после переписки — видно, что модель работает по резюме.
    // `tail` обязателен: выше `thread` пересобирается, и в `session.thread` уже новый узел.
    if (session.compacted) appendCompactedNote(session, session.thread);
    // Очередь — последней: она всегда под историей, а не внутри неё.
    renderQueue(session);
    windowTurns(session);
    scrollToEnd(session);
  }

  /* ── информация о сессии ───────────────────────────────────────────────── */

  const sessionInfo = createSessionInfo({
    onCompact: () => void compactActive(),
    // «Снять всё» у части «Файлы»: `takeForSend` забирает и очищает список —
    // вложений терять не надо, они либо уйдут дальше, либо их и не было.
    onDropFiles: () => {
      attachments.takeForSend();
      // Цифры в открытой панели — из данных сессии: без пересчёта они бы
      // остались старыми до следующего события.
      syncSessionInfo();
    },
    // Счёт у провайдера — только если он его показывает: у локальных серверов
    // и большинства OpenAI-совместимых метода нет, и main вернёт `null`.
    balance: () => deps.rpc.request('ai.balance'),
  });

  /**
   * Все виджеты про AI в полосе — одна кнопка «Информация о сессии» (кольцо
   * контекста): в неё же встают значок режима и искра состояния ассистента.
   * Порознь они занимали полосу тремя блоками, а вели к одному и тому же окну.
   */
  const contextRing = createUsageRing(() => toggleSessionInfo());
  const aiSparkle = h('span', { class: 'status-ai', title: 'AI: готов' }, svgIcon('sparkle', 12));
  // Живой регион для диктора: искра и её `title` — только зримая отметка, диктор
  // их не читает. Узел начинаем с «Готово», а не с пустоты: `aria-live` объявляет
  // ИЗМЕНЕНИЕ текста, и первая фраза в пустом узле может быть сочтена исходным
  // состоянием — тогда диктор промолчит ровно в первый прогон, когда и нужен.
  const runStatus = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }, 'Готово');
  // Значок режима и искра генерации — рядом в начале кнопки, за ними кольцо.
  contextRing.element.prepend(composer.modeBadge, aiSparkle, runStatus);

  /**
   * Статус ассистента живёт в общей полосе окна (статус-баре), а не в композере:
   * там он не занимает высоту панели. Композер отдаёт готовую строку наружу
   * (`statusElement`), а окно «Информация о сессии» раскрывается вверх от неё же.
   */
  // Место, где идёт задача: ветка, а если задача уведена — отдельный каталог.
  // Живёт рядом со статусом: человек видит, какие файлы он правит, без меню.
  const branchSpace = deps.git
    ? createChatBranchSpace({
        git: deps.git,
        workspace: deps.workspace,
        confirm: deps.confirm,
        notify: (message, kind) => showToast(message, kind),
        sessionTitle: () => active().title || '',
        // Свой каталог задачи записывается в БЕСЕДУ (п.31): ход кончится, прогон
        // умрёт, а каталог задачи останется — вместе с ней, а не с окном.
        setSessionRoot: (root) => {
          const session = active();
          if (root) session.workspace = root;
          else delete session.workspace;
        },
      })
    : null;

  /**
   * Полоса «что ещё идёт». Опрашивает main только во время прогона: между ходами
   * там нечего смотреть, а опрос дважды в секунду — это работа впустую.
   */
  const runningBar = createChatRunning({
    snapshot: () =>
      deps.rpc
        .request('ai.running', undefined)
        .then((snapshot) => snapshot ?? null)
        // Спрос не удался (старый main, AI выключен) — пустоты достаточно.
        .catch(() => null),
    abort: () => {
      const session = active();
      void deps.rpc.request('ai.abortConversation', { conversationUid: session.uid }).catch(() => undefined);
    },
    abortTool: (callId, name) => {
      // Прогон идёт дальше: main получит отмену инструмента как обычную ошибку.
      void deps.rpc.request('ai.abortTool', { callId, name }).catch(() => undefined);
    },
  });

  const statusElement = h(
    'div',
    { class: 'chat-status' },
    branchSpace?.element ?? null,
    runningBar.element,
    contextRing.element,
    sessionInfo.element,
  );

  function sessionInfoData(session: ChatSession = active(), pending = ''): SessionInfoData {
    return {
      provider: currentProvider()?.label ?? 'провайдер не задан',
      model: currentModel(),
      history: session.history,
      attachments: session.attachments,
      systemPrompt: settings.ai.systemPrompt,
      ...(session.instructions ? { instructions: session.instructions } : {}),
      tools: composer.modes().useTools,
      // Вес описаний берём из следа последнего прогона: его знает main. Пока
      // ответа не было — числа нет, и панель оценит по всему списку, честно
      // помечая «≈».
      ...(session.trace?.toolsTokens !== undefined ? { toolsTokens: session.trace.toolsTokens } : {}),
      reservedTokens: answerReserve(
        maxOutputTokens(currentModel(), settings.ai.maxTokens),
        contextWindow(currentModel(), settings.ai.contextWindow),
      ),
      usage: session.usage,
      contextWindow: settings.ai.contextWindow,
      ...(pending ? { pending } : {}),
    };
  }

  /** Панель открыта — данные пересчитываем, закрыта — не тратим время. */
  function syncSessionInfo(): void {
    const data = sessionInfoData();
    contextRing.set(contextUsage(data));
    if (sessionInfo.visible) sessionInfo.show(data);
    // Быстрые кнопки показываются по тому же расчёту, что и цена вида: если
    // приложить нечего — кнопки нет. Иначе она обещала бы действие и молчала.
    composer.setQuickAttach({
      file: attachments.contextPrice('file') !== null,
      selection: attachments.contextPrice('selection') !== null,
      problems: attachments.contextPrice('problems') !== null,
    });
  }

  function toggleSessionInfo(): void {
    if (sessionInfo.visible) sessionInfo.hide();
    else sessionInfo.show(sessionInfoData());
  }

  // Окно — всплывающий слой: клик мимо и Esc его закрывают, как меню композера.
  document.addEventListener('pointerdown', (event) => {
    if (!sessionInfo.visible) return;
    const node = event.target as Node;
    if (sessionInfo.element.contains(node) || contextRing.element.contains(node)) return;
    sessionInfo.hide();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sessionInfo.visible) sessionInfo.hide();
  });

  /** Модель сжатия: своя из настроек (`ai.compactModel`), иначе — активная. */
  function compactionModel(): string {
    return settings.ai.compactModel?.trim() || currentModel();
  }

  /** Бюджет одного прохода сжатия, в символах — от окна модели сжатия (см. `shared/context-fit`). */
  function compactBudget(): number {
    const model = compactionModel();
    // Явный размер окна задан для активной модели; для отдельной модели сжатия
    // берём автоопределение по имени.
    const override = model === currentModel() ? settings.ai.contextWindow : undefined;
    return compactionBudgetChars(
      contextWindow(model, override),
      answerReserve(maxOutputTokens(model, settings.ai.maxTokens), contextWindow(model, override)) + 2_000,
    );
  }

  /**
   * Сжатие беседы — отдельным модулем: нарезка истории, каскадная достройка
   * резюме и замена `history` держатся вместе. Пока они лежали прямо здесь,
   * любой проход по файлу грозил снести одно из двух — так уже случалось.
   */
  const compact = createChatCompact({
    target: () => ({ providerId: currentProvider()?.id ?? null, model: compactionModel() }),
    budget: () => compactBudget(),
    complete: async ({ providerId, model, prompt }) => {
      let streamed = '';
      const done = await deps.rpc.stream(
        'ai.chat',
        { providerId, model, messages: [{ role: 'user', content: prompt }], useTools: false },
        (event, payload) => {
          if (event === ChatStreamEvent.Delta) streamed += (payload as ChatDeltaPayload).text;
        },
      );
      return done.text || streamed;
    },
    notify: (text, kind) => showToast(text, kind),
    setBusy: (value) => setBusy(value),
    beforeStart: () => sessionInfo.hide(),
    save: () => {},
    renderSummary: (session, before, summary, facts) => renderCompacted(session, before, summary, facts),
    afterFinally: () => {
      renderTabs();
      syncSessionInfo();
      scheduleSave();
    },
  });

  /** Сжатие беседы: подпись сохраняет прежние места вызова. */
  const compactSession = (session: ChatSession): Promise<boolean> => compact.compactSession(session);

  /** Сжатие по кнопке: с проверками «идёт генерация» и «есть что сжимать». */
  async function compactActive(): Promise<void> {
    const session = active();
    if (busy) {
      showToast('Дождитесь ответа или остановите генерацию');
      return;
    }
    if (session.history.length === 0) {
      showToast('Беседа пуста — сжимать нечего');
      return;
    }
    await compactSession(session);
  }

  /**
   * Перед отправкой решаем, не пора ли освободить контекст.
   *
   * Причины и их порядок живут в `needsCompaction` (`shared/context-fit`):
   * подход к окну модели, жёсткий потолок из настроек (по умолчанию выключен),
   * расписание «сжимать чаще» и промах кеша — последний и есть основной повод,
   * когда человек ничего не настраивал.
   * Сжимать нечего — просто предупреждаем, что ответ может обрезаться.
   */
  async function ensureContextFits(session: ChatSession, pending: string): Promise<boolean> {
    const usage = contextUsage(sessionInfoData(session, pending));
    const reason = needsCompaction({
      used: usage.used,
      limit: usage.limit,
      // Резерв — не весь `maxTokens` из настроек, а разумная его часть (`answerReserve`).
      reserve: answerReserve(maxOutputTokens(currentModel(), settings.ai.maxTokens), usage.limit),
      usage: session.usage,
      usageFresh: session.usageFresh,
      compactAtTokens: settings.ai.compactAtTokens,
      turnsSinceCompact: session.turnsSinceCompact,
      turnsEvery: settings.ai.compactEveryTurns,
      compactCapable: modelCapabilities(currentModel()).compactCapable,
    });
    if (!reason) return true;

    if (session.history.length < 2) {
      showToast('Контекст переполнен, но сжимать почти нечего — ответ может обрезаться', 'error');
      return true;
    }
    showToast(compactionMessage(reason));
    // Сжатие не удалось — запрос не отправляем: иначе он уйдёт обрезанным, и
    // пользователь получит ошибку лимита вместо ответа.
    return compactSession(session);
  }

  /**
   * После сжатия в ленте остаётся отметка и само резюме.
   *
   * Ленту при этом НЕ очищаем. Сжимается контекст для модели — история, которую
   * пошлём в следующий раз, — а не то, что человек читает: раньше сжатие стирало
   * переписку целиком и оставляло вместо неё сводку, и это выглядело как
   * «текст обрезался» ровно в тот момент, когда беседа стала длинной. Своё
   * прочитанное человек вправе перечитать и скопировать.
   */
  function renderCompacted(session: ChatSession, before: number, summary: string, facts: CompactionFacts): void {
    // Отметка живёт ВНУТРИ хода, а не отдельным ребёнком ленты. Причина не
    // косметическая: `currentTurn` заводит новый `.chat-turn` для любого
    // сообщения, кроме приветствия, — следующий вопрос человека встал бы ниже
    // отметки, — а `clearTurn` снимает
    // ответ и перерисовывает ход заново. Отдельный ребёнок ленты пережигал
    // сжатие в первом из этих мест и терялся бы во втором.
    const note = h(
      'details',
      { class: 'thread-summary', open: true },
      h(
        'summary',
        { class: 'thread-summary-head' },
        svgIcon('collapse', 12),
        `Контекст беседы сжат · было сообщений: ${before}`,
      ),
      h(
        'div',
        { class: 'thread-summary-text' },
        // «Сжали 40 сообщений» само по себе ничего не говорит: человек хочет
        // знать, о чём резюме и что в него вошло, — иначе не понять, не
        // потерялось ли главное, не начав читать само резюме.
        h('div', { class: 'thread-summary-facts' }, ...compactionLines(facts).map((line) => h('div', {}, line))),
        'Выше — вся переписка, её можно перечитать. Модель дальше получает только это резюме:',
        h('div', { class: 'thread-summary-body' }, summary),
      ),
    );
    currentTurn(session).appendChild(note);
    session.compacted = true;
    // Прокручиваем к отметке: новый вопрос встанет ниже неё. Прыжка в начало
    // ленты (как было) нет — человек продолжает читать с того же места.
    if (session.id === activeId) note.scrollIntoView({ block: 'nearest' });
  }

  /** Отметка о сжатии — в `chat-compact`: правило одно для потока и для восстановленной беседы. */
  const appendCompactedNote = (session: ChatSession, tail: HTMLElement | null = null): void =>
    compact.appendCompactedNote(session, tail);

  /** Подпись кнопки модели — «Провайдер - Модель»: где и чем спрашиваем, видно сразу. */
  function syncModelLabel(): void {
    const provider = currentProvider()?.label ?? 'провайдер не задан';
    const label = currentModel() || 'модель не выбрана';
    composer.setModel(provider, label);
    // Усилие размышления относится к модели: сменилась модель — сменилась и доступность.
    syncEffort();
  }

  /**
   * Усилие размышления относится к модели, а не к беседе: показываем его
   * только там, где модель действительно принимает `reasoning_effort`.
   * Иначе контрол выглядел бы работающим, ничего не меняя.
   */
  function syncEffort(): void {
    const effort = settings.ai.reasoningEffort ?? 'off';
    const capabilities = modelCapabilities(currentModel());
    composer.setEffort(
      effort,
      !capabilities.reasoningEffort,
      capabilities.reasoningEffort
        ? capabilities.note
          ? `Усилие размышления: сколько модель думает перед ответом. ${capabilities.note}`
          : 'Усилие размышления: сколько модель думает перед ответом'
        : `Модель не принимает усилие размышления: ${capabilities.note ?? 'параметр не поддерживается'}`,
    );
  }

  async function saveEffort(effort: ReasoningEffort): Promise<void> {
    try {
      settings = await deps.rpc.request('settings.update', { ai: { reasoningEffort: effort } });
      showToast(effort === 'off' ? 'Размышления выключены' : `Усилие размышления: ${effort}`);
    } catch (error) {
      showToast(errorText(error), 'error');
    }
  }

  /**
   * Набор инструментов — свойство БЕСЕДЫ, а не общая настройка: «разговор про
   * рефакторинг» и «разговор про релиз» не должны навязывать друг другу свой
   * выбор. Настройка служит только значением по умолчанию для новых бесед.
   */
  function syncToolPreset(): void {
    composer.setToolPreset(sanitizeToolPreset(active().toolPreset ?? settings.ai.toolPreset));
  }

  function saveToolPreset(preset: ToolPresetId): void {
    active().toolPreset = preset;
    composer.setToolPreset(preset);
    scheduleSave();
    // И в настройку по умолчанию: новой беседе достался бы старый набор, и выбор,
    // сделанный один раз, приходилось бы повторять в каждой вкладке заново.
    void deps.rpc
      .request('settings.update', { ai: { toolPreset: preset } })
      .then((next) => {
        settings = next;
      })
      .catch(() => undefined);
    showToast(`Набор инструментов: ${toolPresetSpec(preset).label}`);
  }

  /** Отрисовать панель изменений по активной беседе. */
  function renderChanges(): void {
    const session = active();
    const unsaved = [...session.touched.keys()].filter((path) => deps.documents.get(path)?.dirty).length;
    changesPanel.render({ touched: session.touched, files: session.files, unsaved });
  }

  /**
   * Записать документы на диск. Кто именно решает — человек: правки агента
   * ложатся в документы в памяти, а файл пишет кнопка «Сохранить» в панели
   * изменений (см. `saveTouched`). Откат пишет на диск сразу: возвращая текст,
   * странно оставлять файл версией агента.
   */
  async function persistPaths(paths: Iterable<string>): Promise<Map<string, string>> {
    const reasons = new Map<string, string>();
    for (const path of paths) {
      const document = deps.documents.get(path);
      if (!document?.dirty) continue;
      try {
        // Пишем через сервис правок: он сверяет время файла и не даёт молча
        // перетереть чужую правку (того же файла мог коснуться другой инструмент).
        // Правки текста при сохранении (хвосты, перевод строки в конце) сервис
        // берёт из той же настройки, что и Ctrl+S — см. `prepareForDisk`.
        const result = await deps.edits.saveDocument(document);
        if (result === 'conflict') {
          reasons.set(path, 'conflict');
          showToast(`Файл изменён на диске, не перезаписан: ${basename(path)}`, 'error');
        }
      } catch (error) {
        // Не записалось — говорим вслух и оставляем файл «грязным». Раньше
        // исключение глоталось целиком: документ оставался в буфере, а агент
        // продолжал работать, не зная, что на диске старый текст.
        reasons.set(path, describeError(error));
        showToast(`Не записано на диск: ${basename(path)} — ${describeError(error)}`, 'error');
      }
    }
    return reasons;
  }

  /** Причина ошибки строкой: у отказа файловой системы есть код, он важнее текста. */
  function describeError(error: unknown): string {
    if (error instanceof Error) {
      const code = (error as { code?: string }).code;
      return code ? `${code}: ${error.message}` : error.message;
    }
    return String(error);
  }

  /**
   * «Сохранить»: записать на диск то, что агент изменил в документах. Пишем
   * только «грязные» файлы — уже сохранённые второй раз трогать незачем.
   */
  async function saveTouched(): Promise<void> {
    const session = active();
    const dirty = [...session.touched.keys()].filter((path) => deps.documents.get(path)?.dirty);
    if (dirty.length === 0) {
      showToast('Нечего сохранять: правки агента уже на диске');
      return;
    }

    await persistPaths(dirty);
    renderChanges();
    const failed = dirty.filter((path) => deps.documents.get(path)?.dirty).length;
    showToast(
      failed > 0
        ? `Не удалось сохранить файлов: ${failed}`
        : `Сохранено ${dirty.length} ${plural(dirty.length, 'файл', 'файла', 'файлов')}`,
      failed > 0 ? 'error' : 'success',
    );
  }

  /** «Отменить» возвращает документы к тому, какими они были до правок агента. */
  async function revertTouched(): Promise<void> {
    const session = active();
    const touched = session.touched;
    const fileEdits: FileEdit[] = [];

    for (const [target, entry] of touched) {
      const document = deps.documents.get(target);
      if (!document || document.value === entry.original) continue;

      const lines = document.value.split('\n');
      const last = lines[lines.length - 1] ?? '';
      fileEdits.push({
        path: target,
        edits: [
          {
            startLine: 1,
            startColumn: 1,
            endLine: lines.length,
            endColumn: last.length + 1,
            newText: entry.original,
          },
        ],
      });
    }

    touched.clear();
    const files = session.files;
    session.files = [];
    renderChanges();

    // Файловые операции откатываем тоже: созданное — в корзину, перенос — назад.
    // Удалённое вернуть нечем: файл уже в корзине системы, это отметим отдельно.
    let undone = 0;
    let skipped = 0;
    for (const file of files) {
      try {
        if (file.kind === 'created') {
          await deps.rpc.request('workspace.trash', { path: file.path });
          undone += 1;
        } else if (file.kind === 'moved' && file.from) {
          await deps.rpc.request('workspace.rename', { from: file.path, to: file.from });
          undone += 1;
        } else if (file.kind === 'deleted') {
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }

    if (fileEdits.length === 0) {
      showToast(
        undone > 0
          ? `Отменено файловых операций: ${undone}`
          : skipped > 0
            ? 'Удалённые файлы в корзине — верните их вручную'
            : 'Нечего отменять',
        skipped > 0 && undone === 0 ? 'error' : 'info',
      );
      return;
    }

    const result = await deps.edits.applyFileEdits(fileEdits, 'programmatic');
    // Правки лежат на диске, поэтому и откат должен до него дойти: иначе файл
    // останется версией агента, а редактор покажет прежний текст.
    await persistPaths(fileEdits.map((file) => file.path));
    const failed = result.failed.length;
    showToast(
      failed > 0
        ? `Не удалось отменить файлов: ${failed}`
        : skipped > 0
          ? `Правки отменены; удалённые файлы — в корзине`
          : 'Правки агента отменены',
      failed > 0 ? 'error' : 'success',
    );
  }

  /**
   * «Вернуть всё, как было до этого вопроса».
   *
   * Отличие от «Отменить»: та откатывает последние правки в документах, а эта — целый
   * ход вместе с файловыми операциями и историей. Откат целиком: на три вопроса назад
   * по одному файлу бессмысленно, а с историей наше состояние станет неполным.
   */
  async function revertToCheckpoint(session: ChatSession, index: number): Promise<void> {
    if (busy) {
      // Пока идёт ответ, агент может править те же файлы — откат под ним потеряется.
      showToast('Сначала остановите ответ', 'error');
      return;
    }
    const checkpoints = session.checkpoints ?? [];
    const at = checkpoints.findIndex((item) => item.messageIndex === index);
    if (at < 0) return;
    // Файлы откатываем ВСЕЕЙ работы начиная с этого вопроса: открутка на три шага
    // вперёд с оставленными правками промежуточных шагов — это не «как было».
    const plan = revertPlan(checkpoints, at);

    // СПРОС ДО ОТКАТА. Откат молчит: файлы меняются, а созданные агентом вовсе
    // уходят в корзину — и узнаётся это уже после. Предосмотр называет цену
    // словами: сколько файлов вернётся, какие будут удалены и что потеряет
    // несохранённое. Отказ — не ошибка, а решение человека.
    const preview = revertPreview(
      checkpoints,
      at,
      deps.documents.dirty().map((document) => document.path),
    );
    const title = session.history[index]?.content ?? 'этому вопросу';
    const confirmed = await deps.confirm({
      title: 'Откатиться к состоянию до вопроса?',
      message: `Вернуть файлы к состоянию до «${title.slice(0, 60)}»?`,
      detail: `${revertSummary(preview, title.slice(0, 60))}\n\nВернуть откат будет нельзя.`,
      confirmLabel: 'Откатить',
      // Кнопка по умолчанию в диалоге — ПЕРВАЯ, то есть «Откатить». Значит Enter
      // подтвердит необратимое. Так уже живёт весь проект (Cancel — вторая кнопка),
      // и менять поведение ради одного места хуже: люди привыкли к порядку.
    });
    if (!confirmed) return;

    // Сперва файлы: не вышло — историю не трогаем. Вопрос, которого нет в ленте,
    // с оставленными правками хуже, чем неоткаченный вовсе.
    const edits: FileEdit[] = [];
    const created: string[] = [];
    for (const [file, snapshot] of plan) {
      if (!snapshot.existed) {
        // Файла до этого вопроса не было: агент его создал — откат значит убрать.
        created.push(file);
        continue;
      }
      const lines = snapshot.text.split('\n');
      const last = lines[lines.length - 1] ?? '';
      edits.push({
        path: file,
        edits: [
          { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: last.length + 1, newText: snapshot.text },
        ],
      });
    }
    const failed: string[] = [];
    if (edits.length > 0) {
      // Тем же путём, что и «Отменить»: правка идёт и в документ, и на диск.
      const result = await deps.edits.applyFileEdits(edits, 'programmatic');
      await persistPaths(edits.map((file) => file.path));
      failed.push(...result.failed.map((item) => item.path));
    }
    for (const file of created) {
      try {
        await deps.rpc.request('workspace.trash', { path: file });
      } catch {
        failed.push(file);
      }
    }
    if (failed.length > 0) {
      showToast(`Не удалось вернуть файлов: ${failed.length}. История не тронута`, 'error');
      return;
    }

    // История и лента — только после файлов.
    session.history.length = index;
    session.transcript.length = index;
    truncateCheckpoints(session, at);
    // Счётчики «Изменён N файл» от откаченных ходов тоже сбрасываем.
    for (const file of plan.keys()) session.touched.delete(file);
    session.files = (session.files ?? []).filter((file) => !plan.has(file.path));
    session.activeCheckpoint = undefined;
    session.queue = [];
    renderQueue(session);
    renderHistory(session);
    renderChanges();
    showToast(`Всё вернулось к состоянию до этого вопроса: файлов ${plan.size}`, 'success');
  }

  // Композер и всё, что под лентой. Кнопка «к последнему сообщению» живёт здесь
  // же и позиционируется от футера: иначе фиксированный отступ при высоком
  // поле ввода оставлял бы кнопку поверх него.
  // Ряд настроек беседы лежит ПОД карточкой композера, в самой полосе футера:
  // режим, права, набор, модель и усилие — свойства беседы, а не набираемого
  // вопроса, и внутри узкой карточки они теснили поле ввода.
  const footer = h('div', { class: 'chat-footer' }, composer.element, composer.settingsBar, menu.element);
  footer.appendChild(jumpButton);

  // План, изменённые файлы и приложенный контекст — ВНУТРИ карточки композера, над
  // полем ввода: они относятся к вопросу, который человек набирает, а не к беседе.
  // Порядок стопки — сверху вниз: план, изменения, чипы.
  composer.extras.append(goalPanel.element, planPanel.element, changesPanel.element, attachments.element);

  // Поиск по ленте. Полоса стоит между лентой и футером, а не поверх: она не
  // закрывает найденное сообщение, когда к нему прыгаешь.
  const findBar = createChatFindBar({
    targets: () =>
      [...active().thread.querySelectorAll('.msg')].map((node) => ({
        text: node.textContent ?? '',
        element: node as HTMLElement,
      })),
    reveal: (target, query, index) => revealFindMatch(target, query, index),
    clearHighlight: () => {
      for (const session of sessions) {
        for (const marked of session.thread.querySelectorAll('.is-search-hit')) {
          marked.classList.remove('is-search-hit');
        }
      }
      clearFindMarks();
    },
    // Вернуть фокус тому, кто открывал поиск: без этого он улетал в `body`, и
    // следующий символ, набранный «в никуда», терялся.
    onClose: () => input.focus(),
  });

  const element = h('div', { class: 'chat' }, tabs.element, tabs.searchBar, body, findBar.element, footer);
  /**
   * `Ctrl+F` — поиск по ленте открытой беседы.
   *
   * Висит на корне панели, а не на `document`: иначе перехватывал бы `Ctrl+F`
   * у редактора и у встроенного браузера, где он ищет по файлу и по странице.
   * Панель ловит событие только когда фокус внутри неё.
   *
   * В поле ввода композера `Ctrl+F` НЕ перехватываем: там он ищет по набранному
   * тексту и не должен переключать внимание на ленту.
   */
  element.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (event.key !== 'f' && event.key !== 'F') return;
    if (event.target === input) return;
    event.preventDefault();
    findBar.open();
  });

  const promptNav = createChatPromptNav({ active });
  const jumpToPrompt = promptNav.jumpToPrompt;

  /**
   * На `document`, а не на корне панели: прыгать хочется и когда фокус в поле
   * ввода — человек только что отправил вопрос и хочет вернуться к прошлому.
   *
   * Чужое `Alt+↑/↓` не трогаем: панель и редактор делят один документ, поэтому
   * проверяем, что панель вообще видна. Курсор сбрасывается при смене беседы —
   * индексы другой ленты означают совсем другие сообщения.
   */
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!element.isConnected || element.offsetParent === null) return;
    event.preventDefault();
    jumpToPrompt(event.key === 'ArrowUp' ? -1 : 1);
  });

  // Перетаскивание изображения на панель чата — тот же путь, что вставка из буфера.
  // Слушатели на корне: файл можно бросить в любое место панели, не только в поле.
  element.addEventListener('dragover', (event) => {
    const hasImage = [...(event.dataTransfer?.items ?? [])].some(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    );
    const hasPath = [...(event.dataTransfer?.types ?? [])].includes('application/x-chui-path');
    if (!hasImage && !hasPath) return;
    event.preventDefault();
    element.classList.add('is-dropping');
  });
  element.addEventListener('dragleave', (event) => {
    // Событие приходит и при переходе между детьми — снимаем подсветку только
    // когда курсор ушёл с самой панели.
    if (event.target === element) element.classList.remove('is-dropping');
  });
  element.addEventListener('drop', (event) => {
    const path = event.dataTransfer?.getData('application/x-chui-path') ?? '';
    const files = [...(event.dataTransfer?.files ?? [])];
    const hasImage = files.some((file) => file.type.startsWith('image/'));
    if (!path && !hasImage) return;
    event.preventDefault();
    element.classList.remove('is-dropping');
    // Путь из дерева и картинки из буфера идут разными путями.
    if (path) void attachments.attachPath(path);
    else void attachments.attachFiles(files);
  });

  /* ── провайдер и модель ────────────────────────────────────────────────── */

  // Настройками владеет модальное окно; здесь только читаем то, что пришло
  // из main push-событием, чтобы подписать кнопку и выбрать модель для запроса.
  function currentProvider() {
    return (
      settings.ai.providers.find((provider) => provider.id === settings.ai.activeProviderId) ?? settings.ai.providers[0]
    );
  }

  function currentModel(): string {
    const provider = currentProvider();
    return settings.ai.activeModel || provider?.defaultModel || provider?.models[0] || '';
  }

  /**
   * Модель или провайдер сменились — история писалась для другой модели: у новой
   * другое окно, другая цена и другой счёт кеша. По умолчанию переносим беседу в
   * сводку тем же `compactSession`, что и при переполнении. Выключатель —
   * `ai.compactOnModelSwitch`: `false` пишется только осознанно.
   *
   * Сжимаем только активную беседу с историей и только пока модель поддерживает
   * сжатие. Смена модели во время ответа (`applySettings` приходит и с `settings:changed`)
   * не должна обрывать ход: пустая история — самый частый случай при настройке.
   */
  async function compactAfterModelSwitch(previous: { providerId: string; model: string }): Promise<void> {
    if (settings.ai.compactOnModelSwitch === false) return;
    if (previous.model === currentModel() && previous.providerId === currentProvider()?.id) return;
    const session = active();
    if (session.history.length < 2) return;
    if (!modelCapabilities(currentModel()).compactCapable) return;
    const compacted = await compactSession(session);
    if (compacted) showToast('Беседа сжата под новую модель');
  }

  function syncProviderFields(): void {
    syncModelLabel();
  }

  /* ── рендер сообщений ──────────────────────────────────────────────────── */

  /**
   * Лента в конце — когда браузер уже знает её итоговую высоту.
   *
   * `scrollTop = scrollHeight` в тот же кадр, когда разметка только вставлена,
   * работает только если всё содержимое уже сверстано. При восстановлении беседы
   * это не так: картинки и карточки файлов получают высоту позже, и лента
   * остаётся прокрученной на старое, меньшее значение — «при старте чат не в конце».
   * Ждём двух кадров: первый отдаёт разметку планировщику, второй — уже
   * с измеренной высотой.
   */
  function scrollToEndSoon(session: ChatSession = active()): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        autoScroll = true;
        scrollToEnd(session, true);
      });
    });
  }

  function scrollToEnd(session: ChatSession = active(), force = false): void {
    // Фоновая беседа может генерировать, но прокручивать чужую ленту нельзя:
    // полоса прокрутки у панели одна, и она принадлежит активной вкладке.
    if (session.id !== activeId) return;
    // Пользователь читает выше — не дёргаем ленту под ним.
    if (!autoScroll && !force) return;
    body.scrollTop = body.scrollHeight;
  }

  /**
   * Окно отрисовки: сколько последних ходов показываем сразу. Всю беседу
   * в DOM держать дорого, а читают её обычно с конца. Важно: это не замена
   * `MAX_MESSAGES` — тот режет сохранённую историю, этот только видимость.
   */
  const VISIBLE_TURNS = 20;

  /**
   * Спрятать старые ходы и повесить кнопку «показать раньше». Прячем
   * атрибутом `data-hidden`, а не удалением: за ним же ходят
   * `revealAncestors` и поиск по ленте.
   */
  function windowTurns(session: ChatSession): void {
    const turns = Array.from(session.thread.querySelectorAll<HTMLElement>('.chat-turn'));
    const stale = turns.slice(0, Math.max(0, turns.length - VISIBLE_TURNS));
    if (stale.length === 0) return;
    session.thread.querySelector('.chat-earlier')?.remove();
    let hidden = 0;
    for (const turn of stale) {
      if (turn.dataset.hidden === 'true') continue;
      turn.dataset.hidden = 'true';
      hidden += 1;
    }
    if (hidden === 0) return;
    const count = stale.length;
    const button = h('button', { class: 'chat-earlier', type: 'button' }, `Показать раньше (${count})`);
    button.addEventListener('click', () => {
      for (const turn of stale) delete turn.dataset.hidden;
      button.remove();
      scrollToEnd(session, true);
    });
    session.thread.prepend(button);
  }

  /**
   * Ход беседы: вопрос и все ответы на него. Обёртка держит их вместе, чтобы
   * вопрос не отрывался от своего ответа при разметке ленты.
   */
  function beginTurn(session: ChatSession): HTMLElement {
    const node = h('div', { class: 'chat-turn' });
    session.thread.appendChild(node);
    return node;
  }

  /** Текущий ход — последний в ленте; нет его (приветствие, сводка) — заводим новый. */
  function currentTurn(session: ChatSession): HTMLElement {
    const last = session.thread.lastElementChild;
    if (last instanceof HTMLElement && last.classList.contains('chat-turn')) return last;
    return beginTurn(session);
  }

  /** Картинки вопроса: показываем прямо в ленте, чтобы было видно отправленное. */
  function imagesNode(images: readonly string[]): HTMLElement | null {
    if (images.length === 0) return null;
    return h(
      'div',
      { class: 'msg-images' },
      ...images.map((src) => h('img', { class: 'msg-image', src, alt: 'Изображение к вопросу' })),
    );
  }

  function appendMessage(
    session: ChatSession,
    role: 'user' | 'assistant',
    text: string,
    onEdit?: () => void,
    images: readonly string[] = [],
    onRevert?: () => void,
  ): HTMLElement {
    const content = h('div', { class: 'msg-body' });
    if (text) markdown.renderInto(content, text);
    const messageEl = h('div', { class: `msg msg-${role}` }, content, imagesNode(images));
    // Действия есть только у вопросов пользователя — у ответов они рисуются
    // отдельно, когда ответ завершён (см. chat-stream.ts / renderHistory).
    if (role === 'user' && onEdit) attachUserActions(messageEl, text, onEdit, onRevert);
    // Вопрос открывает новый ход, ответ дописывается в текущий.
    (role === 'user' ? beginTurn(session) : currentTurn(session)).appendChild(messageEl);
    scrollToEnd(session);
    return content;
  }

  const queueView = createChatQueueView({
    activeId: () => activeId,
    renderAttachments: () => attachments.render(),
    scrollToEnd,
  });
  const renderQueue = queueView.renderQueue;

  function renderIntro(session: ChatSession): void {
    clear(session.thread);
    session.thread.appendChild(
      h(
        'div',
        { class: 'chat-intro' },
        h('p', {}, 'Ассистент видит проект и файл, открытый в редакторе.'),
        h(
          'p',
          { class: 'field-hint' },
          'Выделите код и выберите AI → «Объяснить выделение»: фрагмент уйдёт вместе с запросом.',
        ),
      ),
    );
  }

  /* ── отправка ──────────────────────────────────────────────────────────── */

  /**
   * Сводка «чем кончилось» в конец ленты беседы.
   *
   * Показывается только при падении и остановке: удачный прогон и так виден —
   * ответом и сделанными делами, а лишняя плашка в конце каждого раза была бы
   * шумом. Своя для каждой беседы: прогоны в разных вкладках не смешиваются.
   */
  function threadEnd(session: ChatSession, how: RunEndHow, report: RunEndReport): void {
    const block = h(
      'div',
      { class: `run-end is-${how}` },
      h('div', { class: 'run-end-title' }, report.title),
      h('div', { class: 'run-end-detail' }, report.detail),
      ...(report.hasWork
        ? report.facts.map((fact) => h('div', { class: 'run-end-fact' }, fact))
        : [h('div', { class: 'run-end-fact is-none' }, 'Ничего не изменилось: файлов не трогали.')]),
    );
    session.thread.append(block);
    // Конец прогона — событие, о котором можно не узнать, если смотреть выше.
    // Прокрутка сама решит, активна ли эта вкладка и можно ли дёргать ленту.
    scrollToEnd(session);
  }

  /** Текст ответа из всех его сегментов — для «Копировать». */
  function assistantText(messageEl: HTMLElement): string {
    return [...messageEl.querySelectorAll('.msg-body')]
      .map((node) => node.textContent ?? '')
      .join('\n')
      .trim();
  }

  /** Копирование с сообщением об успехе: буфер обмена доступен не всегда. */
  function copyText(text: string): void {
    if (!text.trim()) {
      showToast('Нечего копировать');
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => showToast('Скопировано'),
      () => showToast('Не удалось скопировать', 'error'),
    );
  }

  /** Действие над сообщением — иконка-кнопка: подпись заменяет подсказка, ряд не шумит. */
  function messageAction(icon: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const button = h(
      'button',
      { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onClick },
      svgIcon(icon, 14),
    );
    // Копирование и оценка вид кнопки не меняют — нажатие подтверждаем пульсом.
    pulseOnClick(button);
    return button;
  }

  /**
   * Кнопки под сообщением пользователя: править, скопировать и вернуть всё назад.
   *
   * «Назад» есть только если для этого вопроса есть снимок: без него обещать
   * откат нечего, и серая кнопка путала бы.
   */
  function attachUserActions(messageEl: HTMLElement, text: string, onEdit: () => void, onRevert?: () => void): void {
    messageEl.appendChild(
      h(
        'div',
        { class: 'msg-actions' },
        messageAction('pencil', 'Править', onEdit),
        messageAction('copy', 'Копировать', () => copyText(text)),
        ...(onRevert ? [messageAction('clock', 'Всё как было до этого вопроса', onRevert)] : []),
      ),
    );
  }

  /** Оценка ответа: хранится в истории и переживает перезапуск. */
  interface MessageFeedback {
    get(): 'up' | 'down' | undefined;
    set(value: 'up' | 'down' | undefined): void;
  }

  function feedbackFor(session: ChatSession, index: number): MessageFeedback {
    return {
      get: () => session.history[index]?.rating,
      set: (value) => {
        const message = session.history[index];
        if (!message) return;
        if (value) message.rating = value;
        else delete message.rating;
        scheduleSave();
      },
    };
  }

  /** Кнопки под ответом: скопировать, повторить и оценить (👍/👎). */
  function attachAssistantActions(
    messageEl: HTMLElement,
    getText: () => string,
    onRegenerate?: () => void,
    feedback?: MessageFeedback,
  ): void {
    const actions = h(
      'div',
      { class: 'msg-actions' },
      messageAction('copy', 'Копировать', () => copyText(getText())),
    );
    if (onRegenerate) {
      actions.appendChild(messageAction('refresh', 'Повторить', onRegenerate));
    }
    if (feedback) {
      const rate = feedback;
      let sync = (): void => {};
      const up = messageAction('thumbUp', 'Полезный ответ', () => {
        rate.set(rate.get() === 'up' ? undefined : 'up');
        sync();
      });
      const down = messageAction('thumbDown', 'Неудачный ответ', () => {
        rate.set(rate.get() === 'down' ? undefined : 'down');
        sync();
      });
      sync = (): void => {
        up.classList.toggle('is-active', rate.get() === 'up');
        down.classList.toggle('is-active', rate.get() === 'down');
      };
      sync();
      actions.append(up, down);
    }
    messageEl.appendChild(actions);
  }

  /**
   * «Править»: новый ход в НОВОЙ ветке — старая беседа остаётся целиком.
   *
   * `threadIndex` — номер в ЛЕНТЕ (`transcript`). Раньше он же шел в `history`, а
   * после сжатия беседы это разные массивы: правка отрезала не тот вопрос и
   * ломала контекст (вопрос человека улетал, а резюме оставалось). Теперь номер
   * переводится через `contextIndexOf` — это делает `forkPlan`.
   *
   * Отрезать историю на месте — потеря без выгоды: человек часто сам не знает,
   * какая формулировка была лучше. Ветка решает это без потерь: прежняя вкладка
   * живёт с прежним ответом, новая — с новым вопросом.
   */
  function editUserMessage(session: ChatSession, threadIndex: number, text: string): void {
    if (busy) {
      showToast('Дождитесь ответа или остановите генерацию');
      return;
    }
    const index = contextIndexOf(session.transcript, session.history, threadIndex);
    if (index < 0) {
      // Вопрос уже за резюме сжатия: в контексте его нет, отрезать нечего. Ветку
      // всё равно заводим (с копией всей беседы), но текст кладём в поле, а не
      // отправляем сами: человек только что правил формулировку.
      showToast('Этот вопрос уже вне контекста: правка уйдёт новым вопросом в ветке');
      const fork = forkActive(session, null, '', text);
      syncTabTitle(fork, text);
      renderTabs();
      return;
    }

    const fork = forkActive(session, threadIndex, '', text);
    // Имя ветки — по новому вопросу, а не по старому: так вкладки различаются
    // тем, чем они отличаются, а не общим началом.
    syncTabTitle(fork, text);
    renderTabs();
    showToast('Вопрос поправлен в новой ветке — старая осталась во вкладке');
  }

  /** «Повторить»: выбросить ответы после последнего вопроса и спросить снова. */
  async function regenerate(session: ChatSession = active()): Promise<void> {
    if (busy) {
      showToast('Дождитесь ответа или остановите генерацию');
      return;
    }

    let lastUser = -1;
    for (let i = session.history.length - 1; i >= 0; i -= 1) {
      if (session.history[i]!.role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser < 0) {
      showToast('Нет вопроса для повтора');
      return;
    }

    const provider = currentProvider();
    // Повтор — обычный вопрос, а не сжатие: идём активной моделью беседы, а не
    // моделью сжатия (`ai.compactModel`), иначе ответ придёт не тем, чем просили.
    const model = currentModel();
    if (!provider || !model) {
      showToast('Провайдер не настроен', 'error');
      return;
    }

    session.history = session.history.slice(0, lastUser + 1);
    // Ленту — тоже. Раньше резался только контекст, и лента показывала прошлый
    // ответ рядом с новым: два ответа на один вопрос, и человек не понимал, какой
    // из них настоящий. Номер ищем по содержимому (`contextIndexOf`): индексы
    // истории и ленты расходятся после сжатия, да и просто не совпадают.
    const asked = session.history[lastUser]!;
    const fromEnd = findThreadIndex(session, asked, lastUser);
    if (fromEnd >= 0) session.transcript = session.transcript.slice(0, fromEnd + 1);
    session.usage = undefined;
    session.usageFresh = false;
    session.turnsSinceCompact = turnsSinceCompact(session.history);
    // Повтор — тот же вопрос заново, и снимок для отката нужен СВЕЖИЙ: файлы
    // сейчас в том виде, в каком их оставила прошлая попытка, и вернуть надо
    // именно это. Без пересоздания `addCheckpointFile` увидел бы файлы уже
    // записанными в старом снимке и молча пропустил их — правки второй попытки
    // пережили бы откат к вопросу.
    session.activeCheckpoint = beginCheckpoint(session, lastUser, asked.content);
    renderHistory(session);
    await stream.run(session, provider.id, model, []);
  }

  /**
   * Ветка беседы: копия (можно — до какого-то вопроса) в новой вкладке.
   *
   * Новая вкладка, а не пометка внутри одной: ветка живёт дальше как обычная
   * беседа — свои правки, свои файлы, своё сохранение. Старая остаётся как
   * была, поэтому «правка вопроса» больше не стирает продолжение.
   */
  function forkActive(source: ChatSession, cut: number | null, name = '', draft = ''): ChatSession {
    const plan = forkPlan(source, cut, name);
    const fork = createSession();
    fork.title = plan.title;
    fork.transcript = plan.transcript;
    fork.history = plan.history;
    if (plan.compacted) fork.compacted = true;
    // Правила уже сказаны в ленте источника — не повторяем в ветке.
    if (source.instructions) fork.instructions = [...source.instructions];
    fork.touched = new Map(source.touched);
    fork.files = [...source.files];
    if (source.kept) fork.kept = [...source.kept];
    fork.draft = draft;
    renderHistory(fork);
    if (draft) {
      input.value = draft;
      composer.focusInput();
    }
    renderTabs();
    syncSessionInfo();
    scheduleSave();
    return fork;
  }

  /**
   * Своя команда беседы. Живёт здесь, а не в main: это управление вкладками и
   * контекстом, модели тут делать нечего.
   */
  async function runChatAction(action: ChatAction, argument: string): Promise<PromptRun> {
    if (busy) {
      showToast('Дождитесь ответа или остановите генерацию');
      return 'busy';
    }
    if (action.id === 'compact') {
      await compactActive();
      return 'started';
    }
    if (action.id === 'new') {
      createSession();
      showToast('Новая беседа: прежняя осталась во вкладке');
      return 'started';
    }
    if (action.id === 'compare') {
      // Сравнение показывает панель, а не отвечает в ленте: это разговор
      // о беседах, и место ему — в окне поверх, а не в истории одной из них.
      showForkCompare(
        {
          sessions: () => sessions.map((item) => ({ title: item.title, transcript: item.transcript })),
          open: (title) => {
            const target = sessions.find((item) => item.title === title);
            if (target) activate(target.id);
          },
        },
        argument.trim() || undefined,
      );
      return 'started';
    }
    const fork = forkActive(active(), null, argument);
    showToast(`Ветка открыта в новой вкладке: ${fork.title}`);
    return 'started';
  }

  /**
   * Идёт ли хоть один соседний прогон в ТОМ ЖЕ каталоге, что и этот.
   *
   * Увести вторую задачу могло не выйти (не git, нет прав): тогда предупреждение
   * остаётся верным. Но если соседняя беседа уже в своём worktree — каталоги
   * разные, и говорить не о чем. Пусто у обеих — обе правят активный корень окна.
   */
  function sharedRootWithRunning(current: ChatSession): boolean {
    const mine = current.workspace ?? deps.workspace.root ?? '';
    for (const id of runningIds) {
      if (id === current.id) continue;
      const other = sessions.find((item) => item.id === id);
      if (!other) continue;
      if ((other.workspace ?? deps.workspace.root ?? '') === mine) return true;
    }
    return false;
  }

  async function send(raw: string): Promise<PromptRun> {
    const written = raw.trim();
    if (!written) return 'busy';
    // Идёт ответ — вопрос не теряем: встаём в очередь и уйдём сами, когда прогон
    // закончится. Тихо проглоченный Enter — худшее из поведений: человек уверен,
    // что написал, а спросить не спросил.
    if (busy) return enqueue(written);
    // Свои команды беседы (`/compact`, `/new`, `/fork`) — раньше команд проекта:
    // они управляют самой беседой, а не уходят вопросом модели. Вопрос
    // «сожми переписку» в чате бесполезен: модель пересказывает только то, что
    // ей дали, а сжимать надо контекст, который копится в приложении.
    const session = active();
    const special = parseChatAction(written);
    if (special) {
      input.value = '';
      session.draft = '';
      resetRecall();
      menu.hide();
      return runChatAction(special.action, special.argument);
    }
    // `/имя хвост` — это команда проекта, а не вопрос модели: подставляем её текст.
    const text = await expandProjectCommand(written);

    const provider = currentProvider();
    if (!provider) {
      showToast('Провайдер не настроен', 'error');
      return 'unavailable';
    }

    const model = currentModel();
    if (!model) {
      showToast('Укажите модель в настройках', 'error');
      return 'unavailable';
    }

    // Вторая задача в том же каталоге — не запрет и уже не просто предупреждение:
    // уводим её в свой worktree (п.31). Уводим эту, а не первую: первая уже
    // правит файлы и может быть на полпути. Тост от увода говорит, ГДЕ она теперь.
    if (runningIds.size > 0) await branchSpace?.isolateQuietly();
    // Увести не удалось (не git, нет прав, уже отдельный каталог) — тогда честно
    // говорим о риске: молчание здесь хуже всего.
    const stillShared = runningIds.size > 0 && parallelRunNotice(runningIds.size + 1);
    if (stillShared && sharedRootWithRunning(session)) showToast(stillShared, 'info');

    // Не влезает в окно — сначала освобождаем контекст, потом спрашиваем.
    // Вес самого вопроса тоже учитываем: в историю он попадёт лишь ниже.
    // Сжать не вышло — не отправляем: иначе запрос уйдёт обрезанным.
    if (!(await ensureContextFits(session, text))) return 'failed';

    input.value = '';
    session.draft = '';
    // Вопрос ушёл, поле пустое — история вопросов начинается заново.
    resetRecall();
    menu.hide();
    // Контекст приложен к конкретному вопросу: дальше он только мешает.
    const sent = attachments.takeForSend();
    // Картинки кладём и в историю, и в ленту: в ленте видно, что ушло модели,
    // а в истории они переживают повторную отрисовку (правка вопроса, «Повторить»).
    // На провод их отдаёт не история, а вложения — см. `chat-stream.ts`.
    const images = sent.filter((item) => item.kind === 'image' && item.dataUrl).map((item) => item.dataUrl!);

    const question: ChatMessage = { role: 'user', content: text, ...(images.length > 0 ? { images } : {}) };
    session.history.push(question);
    session.transcript.push(question);
    // Чекпойнт — раньше первой правки: `applyAgentEdits` досыпает в него снимки.
    session.activeCheckpoint = beginCheckpoint(session, session.history.length - 1, text);
    if (session.history.length === 1) {
      // Первый вопрос убирает приветствие: беседа началась, подсказка больше не нужна.
      clear(session.thread);
      syncTabTitle(session, text);
    }
    const index = session.history.length - 1;
    appendMessage(
      session,
      'user',
      text,
      () => editUserMessage(session, index, text),
      images,
      () => void revertToCheckpoint(session, index),
    );

    // Новый вопрос — снова следим за низом ленты.
    autoScroll = true;
    jumpButton.hidden = true;

    const outcome = await stream.run(session, provider.id, model, sent);
    // Исход запоминаем здесь: `setBusy(false)` зовётся в `finally` стрима, где его уже не видно.
    streamingOutcome = outcome;
    // Название — после ответа и не в очередь отправки: человек не должен ждать
    // лишний запрос, чтобы увидеть ответ.
    void maybeNameSession(session);
    void drainQueue(session);
    return outcome === 'done' ? 'started' : outcome;
  }

  /**
   * Вопрос во время ответа — в очередь этой беседы.
   *
   * Поле чистим и вложения забираем сейчас же: иначе следующий вопрос унёс бы
   * контекст прошлого (а `takeForSend` чистит всё разом — вернуть его потом нечем).
   */
  function enqueue(text: string): PromptRun {
    const session = active();
    enqueuePrompt(session, { text, attachments: attachments.takeForSend() });
    input.value = '';
    session.draft = '';
    resetRecall();
    renderQueue(session);
    showToast('Вопрос в очереди — уйдёт после ответа');
    return 'busy';
  }

  /**
   * Сказать в идущий прогон (Alt+Enter).
   *
   * В отличие от `enqueue` это не «подожди конца»: main вставляет реплику в
   * историю на границе ближайшего шага, и агент узнаёт о поправке, пока ещё
   * работает. Поэтому и в ленту она попадает сразу, с меткой «на ходу» — человек
   * должен видеть, что его услышали, не дожидаясь ответа.
   *
   * Отказ (`accepted: false`) — прогон уже кончился, пока человек печатал.
   * Тогда не теряем набранное, а отдаём его в очередь: обычный путь.
   */
  async function interject(raw: string): Promise<void> {
    const written = raw.trim();
    if (!written) return;
    input.value = '';
    const session = active();
    session.draft = '';
    // Адресат — беседа, в которой пишет человек: при двух прогонах слова иначе
    // уехали бы чужой задаче.
    const answer = await deps.rpc
      .request('ai.interject', { text: written, conversation: session.uid })
      .catch(() => ({ accepted: false }));
    if (!answer.accepted) {
      // Прогон кончился между Enter и вызовом: сказанное стало обычным вопросом.
      enqueue(written);
      return;
    }
    // Вложения тут не переносим: прогон уже идёт со своим набором картинок, а
    // подмешать их в историю задним числом — значит поменять смысл прошлых шагов.
    session.history.push({ role: 'user', content: written });
    // В ленту — тем же путём, что и обычный вопрос: своя карточка, свои кнопки.
    // Править её задним числом нельзя (`editUserMessage` переписал бы историю,
    // которую агент уже видел), поэтому четвёртый аргумент — пусто.
    appendMessage(session, 'user', written, () => undefined);
    session.transcript.push({ role: 'user', content: written });
    showToast('Сказано на ходу — агент узнает на следующем шаге');
  }

  /**
   * Достать из очереди следующее — после прогона.
   *
   * Отправляем по одному и именно этим же путём (`send`), а не напрямую в поток:
   * так сохраняются проверки влезания контекста, разбор `/команд` и правила ленты.
   * Один ход за раз, по той же причине, по какой в окне один активный стрим.
   */
  async function drainQueue(session: ChatSession): Promise<void> {
    // Вложения отложенного вопроса отправляем только если он из открытой беседы.
    // Иначе они попали бы в чужое поле — человек видит чипы другой вкладки и тыкает
    // в них, а на деле добавляет контекст к вопросу из этой.
    if (session.id !== activeId) return;
    const next = takeNextPrompt(session);
    if (!next) return;
    renderQueue(session);
    // Очередь идёт тем же путём, что и обычная отправка: одна дорога для картинок,
    // одна проверка влезания контекста, один разбор `/команд`.
    restoreSent(session, next.attachments);
    attachments.render();
    await send(next.text);
  }

  function setBusy(value: boolean, session: ChatSession = active()): void {
    if (value) runningIds.add(session.id);
    else runningIds.delete(session.id);
    // Прогон в соседней беседе — её дело: у активной поле должно остаться живым,
    // иначе человек не сможет поставить вторую задачу, пока идёт первая.
    if (session.id !== activeId) {
      if (!value && session === streamingSession) finishRun(session);
      renderTabs();
      return;
    }
    busy = value;
    renderTabs();
    // Инструменты видно только на ходу: между ходами полосу не опрашиваем.
    runningBar.follow(value);
    // Искра в кнопке «Информация о сессии»: цвет говорит, что ассистент работает.
    aiSparkle.classList.toggle('is-busy', busy);
    aiSparkle.title = busy ? 'AI: генерация…' : 'AI: готов';
    // Тот же факт — диктору. `setBusy` — единственное место, где прогон
    // начинается и кончается, поэтому регион обновляется только здесь.
    const spoken = runStatusLine(busy);
    // Без проверки `aria-live` проговорит «Готово» второй раз после каждого
    // прогона: текст-то тот же, но узел переписан — для диктора это новое.
    if (runStatus.textContent !== spoken) runStatus.textContent = spoken;
    // Поле ввода гасит прогон, а он в окне один (см. `rpc.ts`: активный стрим —
    // один). Поэтому блокируем поле разом для всех вкладок: композер ставит
    // `disabled` на общее поле и меняет кнопку отправки на «стоп».
    composer.setBusy(value);
    // Конец прогона — конец и паузе: кнопка не должна остаться в «продолжить».
    if (!value) composer.setPaused(false);
    // Прогон кончился, а человек, может быть, ушёл в другое окно.
    //
    // Сверяем с `streamingSession` ДО того, как его обнулят: стрим зовёт
    // `setStreaming(null)`, а следом `setBusy(false)` (см. `chat-stream.ts`,
    // `finally`). Раньше порядок был обратный — к этому моменту `streamingSession`
    // уже null, условие не срабатывало НИКОГДА, и заметка о конце прогона
    // не выходила вовсе.
    if (!value && session === streamingSession) finishRun(session);
  }

  /** Пересчитать «занято» по активной беседе: при переключении вкладки оно разное. */
  function syncBusy(): void {
    const value = runningIds.has(activeId);
    if (value === busy) return;
    busy = value;
    aiSparkle.classList.toggle('is-busy', busy);
    aiSparkle.title = busy ? 'AI: генерация…' : 'AI: готов';
    composer.setBusy(value);
    if (!value) composer.setPaused(false);
  }

  /**
   * Прогон кончился: сказать об этом, если человек не смотрел, и вернуть фокус.
   *
   * Два разных повода, одно место — чтобы порядок был один: сперва заметка, потом
   * фокус. Фокус в поле — последний акт заботы: следующее действие после ответа —
   * чаще всего новый вопрос, и лишний клик по полю бесит сильнее, чем кажется.
   */
  function finishRun(session: ChatSession): void {
    const how = runEnd(streamingOutcome ?? 'started');
    if (!how) return;
    const focused = document.hasFocus();
    // Смотрел — значит видел ленту, а не просто «окно в фокусе»: свёрнутая правая
    // колонка фокуса не отбирает, и без этой проверки человек не узнавал бы,
    // что ответ пришёл в скрытый чат.
    const seen = focused && session.id === activeId && (deps.isChatVisible?.() ?? true);
    const name = session.title?.trim() || 'Беседа';
    const message = announceMessage(how, name, tailOf(session.history), seen);
    if (message) {
      // Заметка вместо системного окна: разрешений у ОС не спрашивает и не звенит.
      showToast(message, how === 'failed' ? 'error' : 'info');
      // Док и заголовок вкладки — если человек смотрит на окно, но не на ленту.
      deps.onRunEnd?.(how, announceTitle(how, name));
    }
    // Печатать человек начал, пока шёл ответ? Значит поле ему мешать не надо: он в нём.
    const typed = session.draft.trim().length > 0;
    if (shouldRefocus(how, { typed, menuOpen: isPopupOpen(), windowFocused: focused })) {
      composer.focusInput();
    }
  }

  /**
   * Пауза пришла из main — там цикл шагов, здесь только вид.
   * Кнопка паузы живёт в композере, поэтому нить короткая.
   */
  /**
   * Стоит ли прогон на паузе прямо сейчас — в ОДНОМ месте.
   *
   * У кнопки в композере своё состояние, но `stop()` решает по вот этому:
   * читая чужое, он бы не знал, что паузу поставил main (её включает и он:
   * событием `paused`), и не снял бы её перед стопом — пауза ждала бы
   * в main неведомо кого.
   */
  let paused = false;

  function setPaused(value: boolean, session: ChatSession = active()): void {
    // Пауза принадлежит беседе: при двух прогонах жать её по всей панели нельзя —
    // человек поставил её одной задаче, а встали бы обе.
    if (session.id === activeId) {
      paused = value;
      composer.setPaused(value);
    }
    // И строку в ленте — сразу, не на границе шага. `stream` создан ниже, но
    // эта функция зовётся только из уведомления main, то есть после старта.
    stream.notePause(value, session);
  }

  /** Найти беседу по uid — по нему main адресует паузу и события прогона. */
  function sessionByUid(uid: string | undefined): ChatSession {
    if (uid) {
      const found = sessions.find((item) => item.uid === uid);
      if (found) return found;
    }
    return active();
  }

  /** Выполнить действие, выбранное по клавише в поле ввода. */
  function runAction(action: Exclude<ComposerAction, 'none'>): void {
    if (action === 'stop') {
      stop();
      return;
    }
    const next = action === 'pause';
    setPaused(next);
    // main подтвердит своё событием, но человек должен увидеть отклик СРАЗУ:
    // между нажатием и границей шага может пройти минута (идёт терминал).
    void deps.rpc.request('ai.setPaused', { paused: next, conversation: active().uid }).catch(() => undefined);
    showToast(next ? 'Пауза после текущего шага' : 'Продолжаем');
  }

  function stop(): void {
    if (!busy) {
      showToast('Сейчас ничего не генерируется');
      return;
    }
    // Пауза, поставленная перед стопом, осталась бы в main и ждала неведомо кого.
    // Снимаем её тем же способом, каким ставили.
    if (paused) setPaused(false);
    // Останавливаем свою беседу: при двух прогонах «текущая» — та, что видна.
    const running = active();
    void deps.rpc.request('ai.setPaused', { paused: false, conversation: running.uid }).catch(() => undefined);
    // Гасим свой поток. Своей ручки нет (прогон открылся до этой правки или уже
    // закрылся) — бьём по последнему открытому, как раньше.
    const handle = liveStreams.get(running.id);
    if (!handle || !handle.cancel()) deps.rpc.cancelActive();
    // И то, что живёт в main помимо потока: команда, чтение, запись. Без этого
    // «стоп» гасил ответ, а запущенный терминал продолжал работать — процесс
    // оставался сиротой, и человек об этом не знал.
    void deps.rpc.request('ai.abortConversation', { conversationUid: running.uid }).catch(() => undefined);
  }

  /**
   * Новая беседа — новая вкладка: старые остаются на месте.
   *
   * Генерацию в старой беседе останавливаем: она продолжает писать в СВОЮ ленту,
   * и человек её уже не видит. Ответ придёт в никуда, а занятость будет держать
   * новый диалог — кнопка «Стоп» в нём борется с чужим ходом.
   */
  function newChat(): void {
    stop();
    // Набранное в прежней беседе остаётся в ней: поле одно на всё окно, и без этой
    // строки новая вкладка стирала бы чужой черновик.
    active().draft = input.value;
    const session = createSession();
    for (const item of sessions) item.thread.hidden = item.id !== session.id;
    activeId = session.id;
    input.value = '';
    attachments.render();
    renderChanges();
    renderTabs();
    sessionInfo.hide();
    scheduleSave();
    requestAnimationFrame(() => {
      // Новая беседа — низ тоже не «слежение» в смысле флага: лента пустая, а
      // `scroll` за ним никто не пришлёт. Иначе флаг остался бы от старой беседы
      // и первый же ответ «полистал» бы ленту без спроса.
      autoScroll = true;
      jumpButton.hidden = true;
      body.scrollTop = 0;
      input.focus();
    });
  }

  /**
   * Готовый запрос в поле ввода новой беседы — без отправки.
   *
   * Так приходит автоматизация: она будит человека, но прогон начинает его Enter.
   */
  function draftPrompt(text: string): void {
    newChat();
    const session = active();
    input.value = text;
    session.draft = text;
    input.focus();
    scheduleSave();
  }

  async function askAboutSelection(mode: 'explain' | 'fix'): Promise<void> {
    const selection = deps.editors.selectedText();
    if (!selection.trim()) {
      showToast('Сначала выделите фрагмент кода в редакторе', 'error');
      return;
    }

    const path = deps.editors.currentPath;
    const language = path ? (deps.documents.get(path)?.languageId ?? '') : '';
    const where = path ? ` из файла ${path}` : '';
    const prompt =
      mode === 'explain'
        ? `Объясни этот код${where}:\n\n\`\`\`${language}\n${selection}\n\`\`\``
        : `Найди ошибки в этом коде${where} и предложи исправление. Ответь минимальным диффом:\n\n\`\`\`${language}\n${selection}\n\`\`\``;

    await send(prompt);
  }

  /* ── ревью правок от агента ────────────────────────────────────────────── */

  /** Прерванный вызов агента не должен оставить решение в подвешенном состоянии. */
  function closeApprovals(): void {
    for (const cancel of [...pendingApprovals]) cancel();
  }

  /**
   * Текст, против которого сводится якорь агента.
   *
   * Не прямо из `documents`: открытый буфер мог отстать от диска (файл переписал
   * `git stash` в терминале), и якорь сошёлся бы с текстом, которого никто не
   * увидит. Сверка и правка обязаны смотреть одно и то же — поэтому спрашиваем
   * у того, кто будет применять (`textForAnchor` делает `refreshStale`).
   */
  async function currentText(target: string): Promise<string | null> {
    return deps.edits.textForAnchor(target);
  }

  /** Разрешения на правку из настроек: пути, про которые больше не спрашиваем. */
  function editGrants(): EditGrant[] {
    return settings.ai.editGrants ?? [];
  }

  // Решения (ревью правок, подтверждение команды) живут в `chat-approvals.ts`:
  // там разметка карточек, а панель только подключает их к ленте и к отмене.
  // Карточка ложится в ту ленту, откуда пришёл вызов, даже если человек успел
  // переключить вкладку: беседу берёт замыкание `mount`.
  const approvals: ApprovalHost = {
    readText: currentText,
    // Чья беседа спросила — туда и карточка: при двух прогонах вопрос фоновой
    // задачи не должен всплыть поверх открытой.
    mount: (block, session) => currentTurn(session ?? streamingSession ?? active()).appendChild(block),
    // Ответ на карточку стёр кнопку вместе с фокусом. Куда его вернуть,
    // решает shared/run-keys: идёт прогон — в ленту (следующий вопрос придёт
    // туда), прогон кончился — в поле ввода (самое время писать дальше).
    returnFocus: () => {
      if (focusAfterCard(busy) === 'composer') input.focus();
      else body.focus({ preventScroll: true });
    },
    scrollToEnd: () => scrollToEnd(),
    // «Не спрашивать про этот файл (папку)» — разрешение живёт в настройках,
    // а не в беседе: иначе следующий прогон спросил бы заново.
    rememberEdit: (scope, path) => {
      const target = scope === 'dir' ? parentOf(path) : path;
      const next = addEditGrant(settings.ai.editGrants ?? [], rememberedEditGrant(scope, target));
      void deps.rpc.request('settings.update', { ai: { editGrants: next } }).then((updated) => {
        settings = updated;
      });
    },
    register: (cancel) => {
      pendingApprovals.add(cancel);
      return () => pendingApprovals.delete(cancel);
    },
    // Клик по файлу в карточке ставит на место правки: первое изменение и есть то,
    // что человек только что утвердил или собирается утвердить.
    ...(deps.revealAt ? { revealAt: deps.revealAt } : {}),
  };

  const editReview = createEditReview(approvals);
  const commandApproval = createCommandApproval(approvals);
  const askPrompt = createAskPrompt(approvals);
  const planApproval = createPlanApproval(approvals);

  deps.host.handle('ai.confirmCommand', async (params) =>
    // `review` приходит, только если проверка модели не решилась разрешить сама:
    // её причина нужна человеку в карточке. `cwd` — чтобы предложить «больше не
    // спрашивать в этой папке».
    commandApproval.confirm(params.command, params.review?.reason, params.cwd, sessionByUid(params.conversation)),
  );

  // Действия в браузере — тоже карточка в ленте: страница может сделать что угодно
  // от имени пользователя, поэтому вопрос задаётся тем же способом.
  deps.host.handle('ai.confirmBrowser', async (params) =>
    commandApproval.confirmBrowser(params.action, params.args, sessionByUid(params.conversation)),
  );

  // Вопрос агенту к человеку: карточка с полем ввода (и кнопками вариантов).
  // Ответ уходит модели результатом вызова — прогон ждёт его и продолжается.
  deps.host.handle('ai.ask', async (params) => ({
    answer: await askPrompt.ask(params.question, params.options, sessionByUid(params.conversation)),
  }));

  // «Утвердить план»: карточка с планом и решением. Утверждение переводит композер
  // в «Агента» — режим обещал чтение без изменений, и дальше он уже врёт. Режим
  // меняется здесь, а не в main: композер живёт в renderer.
  deps.host.handle('ai.exitPlan', async (params) => {
    const decision = await planApproval.ask(params.plan, sessionByUid(params.conversation));
    if (decision.approved) composer.setMode('agent');
    return decision;
  });

  deps.host.handle('ai.applyEdits', async (params) => applyAgentEdits(params));

  // Правки по якорю: позиции считаем здесь, потому что только здесь есть текст
  // документа — в том числе несохранённый. Дальше набор правок идёт тем же путём,
  // что правка по позициям: ревью, undo и панель изменений работают как обычно.
  deps.host.handle('ai.applyPatches', async (params) => applyAgentPatches(params));

  // Пометки языка живут в renderer (в редакторе), поэтому их отдаёт он. `folder` —
  // папка: пометки её файлов и вложенных, в том числе закрытых (они всё равно в хранилище).
  deps.host.handle('ai.getDiagnostics', async (params) => ({
    items: deps.editors.markers(params.path, params.folder),
  }));

  // Несохранённый текст: форматировать надо то, что человек видит, а не что на диске.
  deps.host.handle('ai.documentText', async (params) => ({ text: deps.editors.documentText(params.path) }));

  // Какие файлы открыты и где стоят курсоры — знает только renderer: у main
  // нет ни вкладок, ни текста. Агенту это нужно постоянно («что открыто?»).
  deps.host.handle('ai.openFiles', async () => {
    const positions = deps.editors.cursorPositions();
    const active = deps.editors.currentPath;
    return {
      files: Object.entries(positions).map(([path, position]) => ({
        path,
        line: position.line,
        column: position.column,
        active: path === active,
      })),
    };
  });

  // Показать файл в редакторе: открытие вкладки и позиция курсора — дело renderer.
  deps.host.handle('ai.openFile', async (params) => {
    await revealFile(params.path, params.line ?? 1, params.column ?? 1);
    return { ok: true };
  });

  /**
   * Правки агента: при полном доступе применяем сразу, иначе сперва показываем ревью.
   * Запись в историю и панель изменений — в обоих случаях: пользователь должен
   * видеть, что агент сделал, даже когда не спрашивал.
   */
  async function applyAgentEdits(params: ApplyEditsHostParams): Promise<ApplyEditsHostResult> {
    // При полном доступе применяем всё сразу. Иначе спрашиваем, но не про те
    // файлы, про которые человек уже ответил «не спрашивать»: без этого
    // разрешение работало бы только в режиме без ревью вовсе.
    const trustAll = params.autoApprove === true;
    const trusted = new Set(
      trustAll
        ? []
        : params.edits.filter((file) => matchingEditGrant(editGrants(), file.path)).map((file) => file.path),
    );
    const approved = trustAll ? params.edits : params.edits.filter((file) => trusted.has(file.path));
    const asks = trustAll ? [] : params.edits.filter((file) => !trusted.has(file.path));
    const reviewed = asks.length > 0 ? await editReview.review(asks, sessionByUid(params.conversation)) : [];
    // Разрешённые файлы применяются даже при отмене остального: «Отмена»
    // относится к карточке, а не к прошлому решению человека.
    const selected = [...approved, ...(reviewed ?? [])];
    if (selected.length === 0) return { rejected: true };

    // Вызов пришёл из конкретной беседы: правки принадлежат ей, даже если
    // пользователь успел переключить вкладку.
    const session = streamingSession ?? active();

    // Текст до правок нужен панели «Изменён N файл»: по нему работает «Отменить».
    const before = new Map<string, string>();
    for (const file of selected) {
      const text = await currentText(file.path);
      if (text !== null) before.set(file.path, text);
      // И в чекпойнт хода — но только если файл уже существовал. Созданный агентом
      // файла "до" не имеет, и откат его просто удалит — об этом см. `existed`.
      addCheckpointFile(session.activeCheckpoint, file.path, { existed: text !== null, text: text ?? '' });
    }

    const result = await deps.edits.applyFileEdits(selected, 'programmatic');
    // На диск пишем только там, где вопроса не было: полный доступ или
    // выданное ранее разрешение на этот файл (папку). Остальное ложится
    // в документы в памяти, файлы помечаются «не сохранён», а записывает их
    // человек кнопкой «Сохранить» в панели изменений. Без записи на диск
    // следующий read_file/search (main читает с диска) показывал бы старый
    // текст, хотя инструмент уже отчитался «применено».
    const applied = result.reports.length > 0;
    // За какой путь не спрашивали — тот и пишем молча.
    const silent = (path: string): boolean => trustAll || trusted.has(path);
    // Причины незаписи собираем, а не только показываем тостом: по ним агент
    // понимает, что смотреть, а не просто «правка не на диске».
    const reasons = applied
      ? await persistPaths(result.reports.map((report) => report.path).filter(silent))
      : new Map<string, string>();

    // Что осталось только в буфере. Раньше здесь ничего не делалось: агент
    // получал строку «правку сохранит человек» и шёл дальше, а файл на диске
    // оставался старым — следующий read видел не то, что агент только что
    // написал. В open-беседе так и накопились два грязных буфера.
    //
    // Теперь на полном доступе дожимаем запись: `persistPaths` выше мог не
    // справиться (конфликт времени, ошибка ввода-вывода), а признак — всё тот
    // же `dirty` у документа.
    if (applied) {
      for (const [path, reason] of await persistPaths(
        result.reports
          .map((report) => report.path)
          .filter((target) => silent(target) && deps.documents.get(target)?.dirty),
      )) {
        reasons.set(path, reason);
      }
    }

    const unwritten = result.reports
      .map((report) => report.path)
      .filter((target) => deps.documents.get(target)?.dirty === true);

    for (const report of result.reports) {
      const { added, removed } = countLines(selected, report.path);
      const seen = session.touched.get(report.path);
      if (seen) {
        seen.added += added;
        seen.removed += removed;
        continue;
      }
      const original = before.get(report.path);
      if (original !== undefined) session.touched.set(report.path, { original, added, removed });
    }
    renderChanges();

    return {
      rejected: false,
      result,
      ...(unwritten.length > 0 ? { unwritten } : {}),
      ...(reasons.size > 0 ? { unwrittenReasons: Object.fromEntries(reasons) } : {}),
    };
  }

  /**
   * Правки по якорю: сперва разбираем якоря в позиции по тексту документа, потом
   * применяем обычным путём. В чём смысл: модель не называет столбцы, поэтому
   * промах мимо места невозможен по построению. Не сошёлся якорь — файл не
   * применяется вовсе, и в ответе будет сказано, что именно не нашлось: агент
   * перечитает файл, а не «поправит» похожее место.
   */
  async function applyAgentPatches(params: ApplyPatchesHostParams): Promise<ApplyEditsHostResult> {
    const edits: FileEdit[] = [];
    const failed: ApplyFailure[] = [];

    for (const file of params.patches) {
      const text = await currentText(file.path);
      if (text === null) {
        failed.push({ path: file.path, message: 'не удалось прочитать файл — проверь путь' });
        continue;
      }
      // Грязный буфер — единственный случай, где повтор того же якоря бессмысленен:
      // модель читает диск, а правка ложится в буфер с правками человека.
      const unsavedBuffer = deps.documents.get(file.path)?.dirty === true;
      const resolved = resolvePatches(text, file.patches, { unsavedBuffer });
      if (!resolved.ok) {
        failed.push({ path: file.path, message: resolved.message });
        continue;
      }
      edits.push({ path: file.path, edits: resolved.edits });
    }

    // Ни один файл не разрешился — ревью показывать нечего: сразу говорим причину.
    if (edits.length === 0) {
      return { rejected: false, result: { reports: [], failed } };
    }

    const outcome = await applyAgentEdits({ edits, autoApprove: params.autoApprove });
    if (outcome.rejected) return outcome;
    // Несведённые якоря — к тому же ответу, что и применённые файлы: оговорку
    // «осталось в буфере» свод сохраняет (см. `mergePatchResult`).
    return mergePatchResult(outcome, failed);
  }

  /** Разбор ответа в узлы: движок markdown живёт в отдельном модуле. */
  const markdown = createMarkdownRenderer({
    insertCode: (code) => deps.editors.insertAtCursor(code),
    // Путь в ответе модели ведёт в файл: открываем и встаём на названную строку.
    openPath: (path, line, column) => void revealFile(path, line, column),
  });

  /**
   * Стриминг ответа вынесен в отдельный модуль: он умеет всё сам и лишь просит
   * панель про прокрутку, занятость и панели — эти действия передаём сюда.
   */
  const stream = createStreamRunner({
    rpc: deps.rpc,
    markdown,
    messageHost: (session) => currentTurn(session),
    scrollToEnd: (session) => scrollToEnd(session),
    renderPlan: (steps, session) => {
      // План — свойство беседы, а не панели: без этого переключение вкладки
      // показывало бы чужой чек-лист, а сохранение не знало бы, что писать.
      session.planHistory = archivePlan(session.planHistory, session.plan, Date.now());
      session.plan = steps.length > 0 ? steps.map((step) => ({ ...step })) : undefined;
      if (session.id === activeId) {
        planPanel.render(steps);
        planPanel.renderHistory(session.planHistory ?? []);
      }
      scheduleSave();
    },
    setGoal: (goal, session) => {
      // Цель пишем в СВОЮ беседу: прогон мог идти в фоновой вкладке, а панель
      // показывает активную. Перерисовываем только если она и есть активная.
      session.goal = goal ?? undefined;
      if (session.id === activeId) goalPanel.render(goal);
      scheduleSave();
    },
    hidePlan: (session) => {
      // Новый ход начинает план заново: старые шаги в беседе не оставляем, иначе
      // они вернулись бы на экран после перезапуска как чужая работа.
      if (session.plan) {
        session.plan = undefined;
        scheduleSave();
      }
      if (session.id === activeId) planPanel.hide();
    },
    renderChanges,
    presentArtifacts: (items, session) => {
      // Тот же путь, что у `files`: сначала в беседу — прогон мог идти в фоновой
      // вкладке, — и только активная показывает список на панели.
      for (const item of items) {
        const known = session.artifacts ?? [];
        session.artifacts = [
          { path: item.path, note: item.note ?? '', at: Date.now() },
          ...known.filter((other) => other.path !== item.path),
        ].slice(0, MAX_RUN_ARTIFACTS);
      }
      if (session.id === activeId) deps.artifacts?.set(session.artifacts ?? []);
    },
    setBusy,
    // Событие паузы внутри стрима приходит от конкретной беседы.
    setPaused: (value, session) => setPaused(value, session),
    busyHint: (hint, session) => {
      // Запоминаем в сессии, а не только в UI: прогон мог идти в фоновой вкладке,
      // и при переключении туда шапка должна сразу показать работу, а не ждать
      // следующего вызова инструмента — его может и не быть.
      // Сессия — из довода: при двух прогонах `streamingSession` уже не одна.
      session.busyHint = hint ?? undefined;
      if (session.id !== activeId) return;
      deps.onBusyHint?.(hint);
    },
    trackStream: (session, handle) => {
      // Ручка прогона — на беседу, а не «одна на панель»: «стоп» должен бить
      // по своему потоку, даже если вторым шагом открылся чужой.
      if (handle) liveStreams.set(session.id, handle);
      else liveStreams.delete(session.id);
    },
    closeApprovals,
    setStreaming: (session, ended) => {
      // Прогонов может быть два: конец одного не должен стирать сессию другого.
      // Держим их по беседе, а `streamingSession` — та, что идёт сейчас и видна.
      if (session) runningSessions.set(session.id, session);
      if (ended) runningSessions.delete(ended.id);
      streamingSession = runningSessions.get(activeId) ?? [...runningSessions.values()][0] ?? null;
    },
    attachActions: (messageEl, session) =>
      attachAssistantActions(
        messageEl,
        () => assistantText(messageEl),
        () => void regenerate(session),
        feedbackFor(session, session.history.length - 1),
      ),
    continueAnswer: () => void send('Продолжи ответ с того места, где остановился.'),
    // Файлы-результаты (present) открываются тем же путём, что клик по файлу в дереве.
    openFile: (path, position) => openPresented(path, position),
    openRunLog: (session) => {
      runInspector.open(session.run ?? null, session.title ? `беседа: ${session.title}` : undefined);
    },
    afterStream: () => {
      renderTabs();
      renderChanges();
      syncSessionInfo();
      scheduleSave();
    },
    /*
      Что осталось сделанным — прямо в ленте.

      Собираем из того, что беседа уже знает: несохранённые правки (их надо
      заметить первыми — они пропадут при закрытии окна), изменения файлов из
      инструментов и предъявленные заметки. Ничего дополнительно не спрашиваем:
      в момент падения ещё один запрос — лишняя точка отказа.
    */
    runEndNote: (session, how, reason) => {
      const unsaved = [...session.touched.keys()].filter((path) => deps.documents.get(path)?.dirty === true);
      // Правки буфера — отдельная карта с путём в ключе: у `ToggledFile`
      // самого пути нет, его держит `touched`.
      const unsavedPaths = new Set(unsaved);
      const unsavedFiles: RunEndFile[] = [...session.touched.keys()].map((path) => ({
        path,
        kind: 'edited' as const,
      }));
      // Файловые операции — создано/удалено/перемещено: другой вид следа,
      // и складывать его с правками в одно «изменено» нельзя.
      const fileOps: RunEndFile[] = session.files.map((file) => ({ path: file.path, kind: file.kind }));
      const files = [...fileOps, ...unsavedFiles.filter((file) => !unsavedPaths.has(file.path))];
      const report = runEndReport({
        how,
        reason,
        unsaved,
        files,
        artifacts: (session.artifacts ?? []).map((artifact) => artifact.path),
      });
      // Куда вставить: в конец ленты текущей беседы — сразу под ошибкой или
      // пометкой об остановке. Беседа могла уже закрыться, пока прогон шёл:
      // тогда показывать некому, и сводка не нужна — история всё равно не та.
      const target = sessions.find((item) => item.id === session.id);
      if (!target) return;
      threadEnd(target, how, report);
    },
    /*
      Счётчик файлов из шапки группы ведёт в панель изменений.

      Свежесть — главное: панель одна на беседу и показывает её текущее
      состояние, а сообщение, из которого кликнули, может быть старым. Поэтому
      перед открытием перерисовываем панель по живой беседе: откатили файл
      после ответа — раскроется то, что есть сейчас, и это правильный ответ.
    */
    openChanges: (session, path) => {
      const live = sessions.find((item) => item.id === session.id);
      // Беседа закрыта — открывать некуда.
      if (!live) return;
      changesPanel.render({
        touched: live.touched,
        files: live.files,
        unsaved: [...live.touched.keys()].filter((path) => deps.documents.get(path)?.dirty).length,
      });
      changesPanel.open(path);
    },
    /*
      «Повторить» у ошибки. Идёт через `regenerate`, а не через новый `send`:
      вопрос уже лежит в истории, и повтор — тот же вопрос заново, а не второй.

      Через `void`: обработчик клика не ждёт длины прогона, а `regenerate`
      сам сторожит занятость — двойной щелчок не запустит две копии.
    */
    retryRun: (session) => {
      // Повторять в закрытой беседе некуда: `regenerate` резал бы ленту узла,
      // которого уже нет.
      if (!sessions.some((item) => item.id === session.id)) return;
      void regenerate(session);
    },
    modes: () => composer.modes(),
    // Правила и навыки из подпапок: берём папку открытого файла, а не корень —
    // `src/AGENTS.md` должен дойти до агента, когда работа идёт в `src`.
    workingFolder: workingFolder,
  });

  /** Папка открытого файла от корня проекта (`src/app`); `undefined` — не видно или файла нет. */
  function workingFolder(): string | undefined {
    const root = deps.workspace.root;
    const path = deps.editors.currentPath;
    if (!root || !path) return undefined;
    const rel = relativePath(root, path);
    if (!rel || rel === path) return undefined;
    const cut = rel.lastIndexOf('/');
    return cut < 0 ? '' : rel.slice(0, cut);
  }

  /** Вопросы этой беседы — то, что человек сам писал. Служебный дострой и пустышки — не вопрос. */
  function askedQuestions(): string[] {
    return active()
      .transcript.filter(
        (message) =>
          message.role === 'user' && message.content !== CONTINUE_PROMPT && message.content.trim().length > 0,
      )
      .map((message) => message.content);
  }

  /** Новая беседа, вкладка или отправка — история вопросов начинается заново. */
  function resetRecall(): void {
    recallIndex = null;
    recallDraft = '';
  }

  input.addEventListener('input', () => {
    // Набранный текст — уже не прошлый вопрос: следующее ↑ начинает с конца.
    resetRecall();
    menu.sync();
  });

  input.addEventListener('keydown', (event) => {
    // Стоп, пауза и «продолжить» — с клавиш, а не только мышью. Разбор
    // события — в shared/run-keys (чистый): здесь только действие.
    // Проверяем РАНЬШЕ меню: прогон надо уметь остановить всегда, не глядя
    // на то, открыт ли список подсказок.
    const action = composerAction(
      {
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
      { busy, paused },
    );
    if (action !== 'none') {
      event.preventDefault();
      runAction(action);
      return;
    }

    // Пока открыт список — стрелки, Enter и Esc принадлежат ему, а не отправке.
    if (menu.isOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        menu.moveCursor(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        menu.hide();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        menu.pickCurrent();
        return;
      }
    }

    // ↑/↓ без модификаторов — история вопросов. ↑ берём только там, где она
    // никому не мешает: поле пустое (или мы уже в истории) и каретка в начале.
    // Стрелка посреди набранного текста — движение по строкам, и отнимать её нельзя.
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const up = event.key === 'ArrowUp';
      const inHistory = recallIndex !== null;
      const caretAtStart = (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) === 0;
      const wanted = up ? inHistory || (input.value.trim() === '' && caretAtStart) : inHistory;
      if (wanted) {
        const questions = askedQuestions();
        const next = recallStep(recallIndex, up ? -1 : 1, questions.length);
        // Нечего вспоминать: пускай стрелка двигает каретку, как обычно.
        if (recallIndex !== null || next !== null) {
          event.preventDefault();
          if (recallIndex === null) recallDraft = input.value;
          recallIndex = next;
          input.value = next === null ? recallDraft : (questions[next] ?? '');
          // Программная правка события `input` не даёт: каретку в конец и подсказки обновляем сами.
          input.setSelectionRange(input.value.length, input.value.length);
          menu.sync();
          return;
        }
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    // Alt+Enter — сказать это в ИДУЩИЙ прогон, а не после него. Обычный Enter
    // остаётся очередью: там слова ждут, здесь — меняют курс агента на лету.
    if (event.altKey && busy) {
      void interject(input.value);
      return;
    }
    void send(input.value);
  });

  // Первая беседа и восстановление истории — до отрисовки композера: чипы и
  // панель изменений читают состояние активной беседы, без неё им нечего показывать.
  persistence.start();
  if (!persistence.root()) {
    // Проект открывается позже (окно IDE стартует после лаунчера): пустая беседа.
    createSession();
    renderTabs();
  }
  // Список путей для `@` собираем заранее: подсказка должна открыться мгновенно.
  attachments.requestMentions();
  // Команды проекта — тоже заранее: первое `/` покажет их сразу.
  void loadProjectCommands();
  syncProviderFields();
  syncEffort();
  syncToolPreset();
  attachments.render();
  renderChanges();

  /**
   * Мастер-выключатель из настроек: AI выключен — панель не работает. Гасим и
   * заодно останавливаем текущую генерацию, чтобы запрос не продолжал жечь токены
   * после того, как пользователь снял галочку.
   */
  function syncAiAvailability(): void {
    const enabled = settings.ai.enabled;
    element.classList.toggle('is-ai-disabled', !enabled);
    // Строка статуса живёт вне композера — гасим её тем же классом, чтобы
    // выключенный ассистент не выглядел работающим и в статус-баре.
    statusElement.classList.toggle('is-ai-disabled', !enabled);
    // Останавливаем только идущую генерацию: иначе stop() сообщит «ничего не генерируется».
    if (!enabled && busy) stop();
  }

  syncAiAvailability();

  return {
    element,
    statusElement,
    newChat,
    draftPrompt,
    stop,
    flushHistory,
    currentToolPreset,
    setPaused: (value, uid) => setPaused(value, sessionByUid(uid)),
    askAboutSelection,
    openRunLog: () => {
      // Трасса есть только у прогонов этого запуска: она живёт в памяти беседы,
      // а не в файле истории — выводы инструментов там заняли бы мегабайты.
      runInspector.open(active().run ?? null, active().title ? `беседа: ${active().title}` : undefined);
    },
    noteApprovalReview: (command, reason) => {
      // Тот же адрес, что у карточек решений: лента идущего хода, а если он уже
      // закончился — активная вкладка. Ход не прерываем и ничего не ждём.
      approvals.mount(approvalReviewNote(command, reason));
      approvals.scrollToEnd();
    },
    attachImage: (image: PickedImage) => attachments.attachImage(image),
    attachCommit: (hash: string) => void attachments.attachCommit(hash),
    attachScreen: () => void attachments.attachScreen(),
    attachContext: (item: ChatAttachment) => attachments.attachContext(item),
    applySettings(next: Settings) {
      // До подмены: после неё `currentModel()` уже новая, и сравнить не с чем.
      const previous = { providerId: currentProvider()?.id ?? '', model: currentModel() };
      settings = next;
      syncProviderFields();
      syncEffort();
      syncToolPreset();
      // Размер контекстного окна тоже в настройках: кольцо должно пересчитаться
      // сразу, а не после следующего ответа модели.
      syncSessionInfo();
      syncAiAvailability();
      // Смена модели — не только подпись: история писалась под другое окно.
      void compactAfterModelSwitch(previous);
    },
  };
}

/* Карточки вызовов инструментов и лента действий живут в `chat-tools.ts`. */
