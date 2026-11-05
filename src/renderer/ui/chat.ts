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
import type { ApplyFailure, FileEdit } from '../../shared/edits';
import { expandCommandPrompt, findCommand, parseCommandInvocation, type ProjectCommand } from '../../shared/commands';
import { sessionAttachment } from '../../shared/session-context';
import { leaveQuestion, type RunLeaving } from '../../shared/run-keep';
import { composerAction, focusAfterCard, type ComposerAction } from '../../shared/run-keys';
import { isAutoTitle } from '../../shared/chat-title';
import { resolvePatches } from '../../shared/patch';
import { turnsSinceCompact } from './compact-turns';
import { keptContextMessage, restoreSent } from '../../shared/chat-attachments';
import {
  answerReserve,
  compactionBudgetChars,
  compactionMessage,
  needsCompaction,
  contextUsage,
  splitTranscript,
} from '../../shared/context-fit';
import { contextWindow, maxOutputTokens, modelCapabilities } from '../../shared/providers';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { EditService } from '../core/edits';
import type { EditorApi } from '../core/editor-api';
import type { HostService } from '../core/host';
import type { WorkspaceModel } from '../core/workspace-model';
import type { GitModel } from '../core/git-model';
import { type RpcClient, RpcError } from '../core/rpc';
import { basename, clear, h, type IconName, pulseOnClick, svgIcon } from './dom';
import { createSessionInfo, createUsageRing, type SessionInfoData } from './session-info';
import { createAttachments } from './chat-attachments';
import { clearQueuedPrompts, dropQueuedPrompt, enqueuePrompt, moveQueuedPrompt, takeNextPrompt } from './chat-queue';
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
import { createRunFold, nextFoldIcon, nextFoldLabel } from './run-fold';
import { runEndReport, type RunEndFile, type RunEndHow, type RunEndReport } from './run-end';
import { createMarkdownRenderer } from './chat-markdown';
import { createChatComposer } from './chat-composer';
import { createComposerMenu } from './chat-composer-menu';
import { createChangesPanel } from './chat-changes';
import { archivePlan, createPlanPanel } from './chat-plan';
import { createGoalPanel } from './chat-goal';
import { CONTINUE_PROMPT, createStreamRunner } from './chat-stream';
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
import { createChatTabs, type ChatSearchHit } from './chat-tabs';
import { createRunInspector } from './run-inspector';
import { createChatPersistence, newChatUid } from './chat-persistence';
import { chatExportFileName, chatToMarkdown } from '../../shared/chat-export';
import { segmentsOf } from '../../shared/chat-find';
import { promptNeighbour } from '../../shared/chat-nav';
import { createChatFindBar } from './chat-find-bar';
import { showContextMenu } from './context-menu';
import { isPopupOpen } from './popup-menu';
import { showToast } from './toast';
import {
  announceMessage,
  announceTitle,
  runEnd,
  shouldRefocus,
  tailOf,
  type RunEnd,
  type RunOutcome,
} from './chat-notify';

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
   */
  setPaused(value: boolean): void;
  /** Открыть окно «Прогон» для активной беседы (трасса последнего хода). */
  openRunLog(): void;
  askAboutSelection(mode: 'explain' | 'fix'): Promise<void>;
  applySettings(settings: Settings): void;
  /**
   * Приложить готовое изображение к вопросу — снимок страницы из встроенного браузера.
   * Через этот метод вложение кладётся в активную беседу, как из скрепки или Ctrl+V.
   */
  attachImage(image: PickedImage): void;
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
  settings: Settings;
  /** Модальное окно со всеми настройками приложения. */
  settingsModal: SettingsOpener;
  /** Приёмник хостовых вызовов: правки приходят из main. */
  host: HostService;
}

/**
 * Сжатие беседы: старая история заменяется резюме. Пересказ просим у модели сжатия —
 * по умолчанию той же, что и беседа, но её можно задать в настройках (`ai.compactModel`).
 */
const COMPACT_PROMPT = [
  'Сожми нашу беседу в краткое резюме, чтобы продолжить работу с ним вместо истории.',
  'Сохрани: что просил пользователь, какие файлы менялись, принятые решения, найденные ошибки',
  'и что осталось сделать. Пиши по пунктам, без вступлений и без кода целиком.',
].join('\n');

/**
 * Второй проход и дальше: продолжаем уже начатое резюме, а не начинаем заново —
 * иначе каждый блок вытеснял бы из резюме предыдущий, и середина беседы терялась
 * ровно так же, как при старом «сжимаем только хвост».
 */
const COMPACT_CONTINUE_PROMPT = [
  'Дополни существующее резюме с учётом новой части беседы. Не пересказывай заново,',
  'добавь только то, что в резюме ещё нет: запросы пользователя, изменённые файлы,',
  'принятые решения, найденные ошибки, что осталось сделать. Пиши по пунктам, без кода целиком.',
].join('\n');
/**
 * Панель ассистента — правый «остров» в стиле панели инструментов.
 *
 * Сама панель только ведёт беседу: отправляет запрос потоком (`rpc.stream`),
 * рисует ответ, правки и чек-лист плана по событиям. Агентный цикл — вызовы
 * инструментов шаг за шагом — живёт в main (`ai/service.ts`), а их описания
 * лежат в shared/tools.ts. Режим (ask/agent/plan) решает, какие инструменты
 * доступны и что подтверждается у пользователя.
 */
export function createChatPanel(deps: ChatDeps): ChatView {
  let settings = deps.settings;
  let busy = false;
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
   * Чем кончился последний прогон: `setBusy(false)` зовётся и в `finally` стрима, где
   * исхода уже не видно, а сказать в доке надо именно исход.
   */
  let streamingOutcome: RunOutcome | null = null;
  const active = (): ChatSession => sessions.find((session) => session.id === activeId) ?? sessions[0]!;

  // `tabindex` — чтобы в ленту можно было вернуть фокус после ответа на
  // карточку. Без него фокус уходит в `document.body`, и следующий Tab
  // начинает обход страницы с начала — мимо чата.
  const body = h('div', { class: 'chat-body', tabindex: '-1' });

  /** Кнопка возврата к низу: появляется, когда лента прокручена вверх. */
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
    onOpenSettings: () => deps.settingsModal.open(),
    onContext: () => menu.toggleContext(),
    onPasteImages: (files) => void attachments.attachFiles(files),
    onEffortChange: (effort) => void saveEffort(effort),
    // Набор меняется и во время беседы: следующее действие увидит новый набор.
    onToolPresetChange: (preset) => void saveToolPreset(preset),
  });
  const input = composer.input;

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
  const planPanel = createPlanPanel();
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
    // Места проекта — тот же поиск по смыслу, что у палитры: `#codebase` спрашивает его
    // по тому, что уже набрано в поле ввода.
    ...(deps.codebase ? { codebase: deps.codebase } : {}),
    ...(deps.browserUrl ? { browserUrl: deps.browserUrl } : {}),
    composerText: () => input.value,
    session: () => active(),
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

  /** Контекстное меню вкладки беседы: выгрузить в .md или закрыть. */
  function openTabMenu(id: number, event: MouseEvent): void {
    showContextMenu(
      [
        {
          label: 'Экспорт в Markdown…',
          onSelect: () => void exportSession(id),
        },
        {
          label: 'Закрыть беседу',
          danger: true,
          onSelect: () => closeSession(id),
        },
      ],
      event.clientX,
      event.clientY,
    );
  }

  /**
   * Экспорт беседы в `.md`: путь спрашивает main (`chat.export`), файл пишет он же.
   *
   * Берём `transcript`, а не `history`: после сжатия в контексте осталось резюме,
   * и выгружать оттуда — значит отдать файл, где половины разговора нет. Именно ту
   * половину и хотят показать.
   */
  async function exportSession(id: number): Promise<void> {
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
    const contents = chatToMarkdown(messages, {
      title: session.title,
      date: today,
      model: currentModel(),
      workspace: deps.workspace.root ?? undefined,
    });

    try {
      const result = await deps.rpc.request('chat.export', {
        contents,
        name: chatExportFileName(session.title, today),
      });
      // Отмена в диалоге — не ошибка и не повод для тоста.
      if (result.path) showToast(`Беседа выгружена: ${result.path}`, 'info');
    } catch (error) {
      showToast(`Не удалось выгрузить беседу: ${String(error)}`, 'error');
    }
  }

  /** Поиск по беседам: одна строка на беседу, в которой нашлось совпадение. */
  function searchChats(query: string): ChatSearchHit[] {
    const hits: ChatSearchHit[] = [];
    for (const session of sessions) {
      for (const message of session.history) {
        const snippet = snippetFor(message.content ?? '', query);
        if (snippet === null) continue;
        hits.push({ id: session.id, title: session.title, snippet });
        break; // одна строка на беседу — список читается легче
      }
    }
    return hits;
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
      sessions.map((session) => ({
        id: session.id,
        title: session.title,
        streaming: session.id === streamingSession?.id,
      })),
      activeId,
    );
  }

  function createSession(uid = newChatUid()): ChatSession {
    const session: ChatSession = {
      id: nextId,
      uid,
      title: `Беседа ${nextId}`,
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

    for (const session of sessions) session.thread.hidden = session.id !== id;
    const next = active();
    input.value = next.draft;
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
    // Раскрытие ленты своё у каждой беседы: подпись кнопки без этого осталась бы
    // от прошлой вкладки и обещала бы не то действие.
    syncFoldButton(next);

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
    if (leavingRun.id === streamingSession?.id && !safelyLeaveRun(leavingRun)) return;

    const [removed] = sessions.splice(index, 1);
    removed?.thread.remove();
    if (removed?.id === streamingSession?.id) deps.rpc.cancelActive();

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
        if (message.content) {
          // Текст, за которым последовал вызов инструмента, — промежуточный:
          // показываем пузырём, чтобы он не сливался со строками действий.
          const content = h('div', { class: message.toolCalls?.length ? 'msg-body msg-note' : 'msg-body' });
          markdown.renderInto(content, message.content);
          el.appendChild(content);
        }
        if (message.toolCalls?.length) {
          const feed = createToolFeed(el, null, undefined, async (path) => {
            await revealFile(path);
          });
          for (const call of message.toolCalls) {
            cards.set(call.id, feed.add({ id: call.id, name: call.name, args: call.arguments }));
          }
          feed.seal();
        }
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
    if (session.compacted) appendCompactedNote(session, session.thread);
    // Очередь — последней: она всегда под историей, а не внутри неё.
    renderQueue(session);
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
  // Значок режима и искра генерации — рядом в начале кнопки, за ними кольцо.
  contextRing.element.prepend(composer.modeBadge, aiSparkle);

  /**
   * Статус ассистента живёт в общей полосе окна (статус-баре), а не в композере:
   * там он не занимает высоту панели. Композер отдаёт готовую строку наружу
   * (`statusElement`), а окно «Информация о сессии» раскрывается вверх от неё же.
   */
  const statusElement = h('div', { class: 'chat-status' }, contextRing.element, sessionInfo.element);

  function sessionInfoData(session: ChatSession = active(), pending = ''): SessionInfoData {
    return {
      provider: currentProvider()?.label ?? 'провайдер не задан',
      model: currentModel(),
      history: session.history,
      attachments: session.attachments,
      systemPrompt: settings.ai.systemPrompt,
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
   * Сжать указанную беседу: вернуть true, если резюме получено и история заменена.
   *
   * Длинную историю сжимаем каскадом: режем на части (см. `splitTranscript`) и ведём
   * одно резюме, достраивая его на каждой части. Так в резюме попадает вся беседа, а
   * не только хвост, — раньше на сжатие уезжал лишь последний кусок, и всё, что было
   * до него, пропадало бесследно.
   */
  async function compactSession(session: ChatSession): Promise<boolean> {
    const provider = currentProvider();
    const model = compactionModel();
    if (!provider || !model) {
      showToast('Провайдер не настроен', 'error');
      return false;
    }

    const blocks = splitTranscript(session.history, compactBudget());
    if (blocks.length === 0) {
      showToast('Беседа пуста — сжимать нечего');
      return false;
    }

    sessionInfo.hide();
    setBusy(true, session);
    if (blocks.length > 1) {
      showToast(`Сжимаю беседу: ${blocks.length} ${plural(blocks.length, 'этап', 'этапа', 'этапов')}`);
    }
    try {
      let summary = '';
      for (let index = 0; index < blocks.length; index += 1) {
        // Первый проход — резюме с нуля; дальше достраиваем накопленное, чтобы
        // каждая новая часть не вытесняла предыдущие.
        const prompt =
          index === 0
            ? `${COMPACT_PROMPT}\n\n---\n${blocks[index]}`
            : `${COMPACT_CONTINUE_PROMPT}\n\n---\nТекущее резюме:\n${summary}\n\n---\nНовая часть беседы:\n${blocks[index]}`;

        let streamed = '';
        const done = await deps.rpc.stream(
          'ai.chat',
          {
            providerId: provider.id,
            model,
            messages: [{ role: 'user', content: prompt }],
            useTools: false,
          },
          (event, payload) => {
            if (event === ChatStreamEvent.Delta) streamed += (payload as ChatDeltaPayload).text;
          },
        );

        summary = (done.text || streamed).trim();
        if (!summary) {
          showToast('Модель не вернула резюме', 'error');
          return false;
        }
      }

      const before = session.history.length;
      // Меняем ТОЛЬКО контекст: `transcript` (то, что человек читает) остаётся целым,
      // и после перезапуска лента соберётся из него же.
      session.history = [
        { role: 'user', content: `Контекст сжатой беседы:\n\n${summary}` },
        { role: 'assistant', content: 'Принято, продолжаем с этим контекстом.' },
      ];
      // Резюме пересказывает разговор, но не присланные файлы. Вопрос снова
      // прикладывает их сам (history его не несёт), поэтому кладём приложения
      // служебным сообщением сразу за резюме — в конец, где кеш их и оставит.
      const kept = keptContextMessage(session.kept);
      if (kept) session.history.push(kept);
      session.usage = undefined;
      // Сжатие само перестроило префикс: старое попадание в кеш больше ничего не
      // говорит, а расписание начинается заново.
      session.usageFresh = false;
      session.turnsSinceCompact = 0;
      renderCompacted(session, before, summary);
      showToast(`Беседа сжата: ${before} ${plural(before, 'сообщение', 'сообщения', 'сообщений')} → краткое резюме`);
      return true;
    } catch (error) {
      if (error instanceof RpcError && error.cancelled) showToast('Сжатие отменено');
      else showToast(error instanceof Error ? error.message : String(error), 'error');
      return false;
    } finally {
      setBusy(false, session);
      renderTabs();
      syncSessionInfo();
      scheduleSave();
    }
  }

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
  function renderCompacted(session: ChatSession, before: number, summary: string): void {
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

  /**
   * Отметка о сжатии для восстановленной беседы.
   *
   * Ставится перед ПЕРВЫМ последним ходом, а не в начало ленты: отметка
   * относится к последнему сжатию, а лента растёт вниз. Раньше её вешали
   * в конец при восстановлении (`appendCompactedNote`), и на границе
   * «восстановлено из файла → сжали снова» в ленте оказывалось две отметки в
   * двух разных местах — одна у конца, другая там, где сжали на самом деле.
   * `tail` — лента после первого кадра `renderHistory`: тот очищает `thread`.
   */
  function appendCompactedNote(session: ChatSession, tail: HTMLElement | null = null): void {
    const summary = session.history[0]?.content ?? '';
    const note = h(
      'details',
      { class: 'thread-summary' },
      h('summary', { class: 'thread-summary-head' }, svgIcon('collapse', 12), 'Контекст беседы сжат'),
      h(
        'div',
        { class: 'thread-summary-text' },
        'Выше — вся переписка, её можно перечитать. Модель дальше получает только это резюме:',
        h('div', { class: 'thread-summary-body' }, summary),
      ),
    );
    // Последний ход ленты — тот, с которого беседа продолжается. Нет ходов
    // (сжали сразу после сводки) — отметке место в ленте.
    const last = tail?.lastElementChild instanceof HTMLElement ? tail.lastElementChild : null;
    const host = last?.classList.contains('chat-turn') ? last : (tail ?? session.thread);
    host.appendChild(note);
  }

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
      showToast(error instanceof Error ? error.message : String(error), 'error');
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
  /*
    Кнопка «свернуть всё» живёт в ряду настроек беседы: раскрытие ленты — такое
    же свойство беседы, как режим и модель, и своя у каждой вкладки. Стоит
    перед рядом действий, чтобы не спорить с «отправить» у правого края.
  */
  const foldButton = h('button', {
    class: 'composer-fold',
    type: 'button',
    onClick: () => {
      const session = active();
      session.fold?.cycle();
      syncFoldButton(session);
    },
  });
  composer.settingsBar.prepend(foldButton);

  /** Подпись и значок кнопки — всегда про ДЕЙСТВИЕ следующего нажатия. */
  function syncFoldButton(session: ChatSession): void {
    const mode = session.fold?.mode() ?? 'auto';
    foldButton.replaceChildren(svgIcon(nextFoldIcon(mode), 14));
    const label = nextFoldLabel(mode);
    foldButton.title = label;
    foldButton.setAttribute('aria-label', label);
    foldButton.setAttribute('aria-pressed', String(mode !== 'auto'));
  }
  syncFoldButton(active());

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

  /**
   * `Alt+↑/↓` — переход по СВОИМ вопросам.
   *
   * Где сейчас стоим, помним явно (`promptCursor`), а не выводим из прокрутки.
   * Выводить казалось честнее, но в короткой ленте прокручивать нечего —
   * `scrollIntoView` ничего не сдвигает, `current` остаётся тем же, и второе
   * нажатие топчется на месте. Прокрутка нужна только чтобы ПОКАЗАТЬ вопрос.
   *
   * Курсор — индекс в ленте; -1 значит «не выбрано».
   */
  let promptCursor = -1;

  function jumpToPrompt(delta: number): void {
    const session = active();
    const nodes = [...session.thread.querySelectorAll<HTMLElement>('.msg')];
    if (nodes.length === 0) return;
    const roles = nodes.map((node) => ({ role: node.classList.contains('msg-user') ? 'user' : 'assistant' }));

    // Курсор мог остаться от прошлой ленты (беседа перерисована) — тогда его
    // нет: `promptNeighbour` сам начнёт с края в нужную сторону.
    const from = promptCursor >= 0 && promptCursor < nodes.length ? promptCursor : -1;
    const target = promptNeighbour(roles, from, delta);
    if (target < 0) return;

    promptCursor = target;
    const node = nodes[target]!;
    node.scrollIntoView({ block: 'start', behavior: 'auto' });
    for (const other of session.thread.querySelectorAll('.is-prompt-current')) {
      other.classList.remove('is-prompt-current');
    }
    node.classList.add('is-prompt-current');

    // Проговорить для скринридера: обводка — единственный признак, что прыжок
    // состоялся, а её не видят.
    const index = roles.slice(0, target + 1).filter((message) => message.role === 'user').length;
    const total = roles.filter((message) => message.role === 'user').length;
    node.setAttribute('aria-label', `Вопрос ${index} из ${total}`);
  }

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

  /**
   * Очередь вопросов в ленте, в самом низу.
   *
   * Рисуем отдельно от истории и перерисовываем целиком при каждом изменении: так
   * проще всего не расходиться с `session.queue`, а строк в ней мало (человек
   * пишет во время ответа несколько, а не сотни).
   */
  function renderQueue(session: ChatSession): void {
    session.queueNode?.remove();
    session.queueNode = undefined;
    const queued = session.queue ?? [];
    if (queued.length === 0) return;
    const list = h('ol', { class: 'queue-list' });
    queued.forEach((item, index) => {
      const text = item.text.length > 120 ? `${item.text.slice(0, 119)}…` : item.text;
      list.appendChild(
        h(
          'li',
          { class: 'queue-item' },
          h('span', { class: 'queue-index' }, String(index + 1)),
          h('span', { class: 'queue-text' }, text),
          h('button', {
            class: 'queue-move',
            type: 'button',
            title: 'Выше',
            'aria-label': `Переставить вопрос ${index + 1} выше`,
            // Край серый, а не спрятан: пропавшая кнопка ломает навигацию с экрана,
            // а серая говорит, что ход есть, но отсюда нельзя.
            disabled: index === 0,
            'aria-disabled': String(index === 0),
            onClick: () => moveQueued(session, index, -1),
          }),
          h('button', {
            class: 'queue-move',
            type: 'button',
            title: 'Ниже',
            'aria-label': `Переставить вопрос ${index + 1} ниже`,
            disabled: index === queued.length - 1,
            'aria-disabled': String(index === queued.length - 1),
            onClick: () => moveQueued(session, index, 1),
          }),
          h('button', {
            class: 'queue-drop',
            type: 'button',
            title: 'Снять с очереди',
            'aria-label': `Снять с очереди вопрос ${index + 1}`,
            onClick: () => dropQueued(session, index),
          }),
        ),
      );
    });
    session.queueNode = h(
      'div',
      { class: 'chat-queue' },
      h(
        'div',
        { class: 'chat-queue-head' },
        `В очереди: ${queued.length}`,
        h('button', { class: 'chat-queue-clear', type: 'button', onClick: () => clearQueue(session) }, 'Снять все'),
      ),
      list,
    );
    session.thread.appendChild(session.queueNode);
    // Лента скроллится снаружи: очередь дописана снизу, и без протяжки её не видно.
    if (session.id === activeId) scrollToEnd(session);
  }

  /** Убрать один отложенный вопрос: вложения возвращаются в поле, чтобы не пропали. */
  function dropQueued(session: ChatSession, index: number): void {
    // Вложения возвращаются всегда, а поле чипов показывает только открытая беседа —
    // закрытой они не нужны, и перерисовка не вредит.
    if (dropQueuedPrompt(session, index) && session.id === activeId) attachments.render();
    renderQueue(session);
  }

  /**
   * Переставить отложенный вопрос и вернуть фокус на ту же кнопку.
   *
   * `renderQueue` перерисовывает список целиком, поэтому головы строки после
   * перестановки уже нет в документе — фокус упал бы в `body` (в начало ленты для
   * того, кто идёт с клавиатуры). Поэтому ищем новую строку по номеру и ставим
   * фокус на кнопку того же направления.
   *
   * `scrollToEnd` тут не нужен (и `renderQueue` его зовёт только для активной
   * беседы): порядок в ЛЕНТЕ не изменился, двигается только очередь.
   */
  function moveQueued(session: ChatSession, index: number, delta: number): void {
    if (!moveQueuedPrompt(session, index, delta)) return;
    renderQueue(session);
    const node = session.queueNode;
    if (!node || session.id !== activeId) return;
    const row = node.querySelectorAll('.queue-item')[index + delta];
    const button = row?.querySelectorAll('.queue-move')[delta < 0 ? 0 : 1];
    (button as HTMLElement | undefined)?.focus({ preventScroll: true });
  }

  function clearQueue(session: ChatSession): void {
    if (clearQueuedPrompts(session) && session.id === activeId) attachments.render();
    renderQueue(session);
  }

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
   * «Править»: отрезать этот вопрос и всё после него, вернуть текст в поле ввода.
   *
   * `threadIndex` — номер в ЛЕНТЕ (`transcript`). Раньше он же шёл в `history`, а
   * после сжатия беседы это разные массивы: правка отрезала не тот вопрос и
   * ломала контекст (вопрос человека улетал, а резюме оставалось). Теперь номер
   * переводится через `contextIndexOf`.
   */
  function editUserMessage(session: ChatSession, threadIndex: number, text: string): void {
    if (busy) {
      showToast('Дождитесь ответа или остановите генерацию');
      return;
    }
    const index = contextIndexOf(session.transcript, session.history, threadIndex);
    if (index < 0) {
      // Вопрос уже за резюме сжатия: в контексте его нет, резать нечего. Вернуть
      // текст в поле всё равно полезно — человек хотел его поправить.
      showToast('Этот вопрос уже вне контекста: беседа сжата, поправка не отрежет историю');
      input.value = text;
      session.draft = text;
      input.focus();
      return;
    }

    session.history = session.history.slice(0, index);
    // Ленту режем тем же номером — по `threadIndex`, не по индексу контекста: без
    // этого переписанный вопрос оставался бы на экране, а модель его уже не видит.
    session.transcript = session.transcript.slice(0, threadIndex);
    session.usage = undefined;
    // После обрезки продолжение другое: по старому расходу про кеш не судим.
    session.usageFresh = false;
    session.turnsSinceCompact = turnsSinceCompact(session.history);
    renderHistory(session);
    syncSessionInfo();
    scheduleSave();
    input.value = text;
    session.draft = text;
    input.focus();
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

  async function send(raw: string): Promise<PromptRun> {
    const written = raw.trim();
    if (!written) return 'busy';
    // Идёт ответ — вопрос не теряем: встаём в очередь и уйдём сами, когда прогон
    // закончится. Тихо проглоченный Enter — худшее из поведений: человек уверен,
    // что написал, а спросить не спросил.
    if (busy) return enqueue(written);
    // `/имя хвост` — это команда проекта, а не вопрос модели: подставляем её текст.
    const text = await expandProjectCommand(written);

    const session = active();
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

    // Не влезает в окно — сначала освобождаем контекст, потом спрашиваем.
    // Вес самого вопроса тоже учитываем: в историю он попадёт лишь ниже.
    // Сжать не вышло — не отправляем: иначе запрос уйдёт обрезанным.
    if (!(await ensureContextFits(session, text))) return 'failed';

    input.value = '';
    session.draft = '';
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
    const answer = await deps.rpc.request('ai.interject', { text: written }).catch(() => ({ accepted: false }));
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
    busy = value;
    // Искра в кнопке «Информация о сессии»: цвет говорит, что ассистент работает.
    aiSparkle.classList.toggle('is-busy', busy);
    aiSparkle.title = busy ? 'AI: генерация…' : 'AI: готов';
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

  function setPaused(value: boolean, _session: ChatSession = active()): void {
    paused = value;
    composer.setPaused(value);
    // И строку в ленте — сразу, не на границе шага. `stream` создан ниже, но
    // эта функция зовётся только из уведомления main, то есть после старта.
    stream.notePause(value);
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
    void deps.rpc.request('ai.setPaused', { paused: next }).catch(() => undefined);
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
    void deps.rpc.request('ai.setPaused', { paused: false }).catch(() => undefined);
    deps.rpc.cancelActive();
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

  // Решения (ревью правок, подтверждение команды) живут в `chat-approvals.ts`:
  // там разметка карточек, а панель только подключает их к ленте и к отмене.
  // Карточка ложится в ту ленту, откуда пришёл вызов, даже если человек успел
  // переключить вкладку: беседу берёт замыкание `mount`.
  const approvals: ApprovalHost = {
    readText: currentText,
    mount: (block) => currentTurn(streamingSession ?? active()).appendChild(block),
    // Ответ на карточку стёр кнопку вместе с фокусом. Куда его вернуть,
    // решает shared/run-keys: идёт прогон — в ленту (следующий вопрос придёт
    // туда), прогон кончился — в поле ввода (самое время писать дальше).
    returnFocus: () => {
      if (focusAfterCard(busy) === 'composer') input.focus();
      else body.focus({ preventScroll: true });
    },
    scrollToEnd: () => scrollToEnd(),
    register: (cancel) => {
      pendingApprovals.add(cancel);
      return () => pendingApprovals.delete(cancel);
    },
  };
  const editReview = createEditReview(approvals);
  const commandApproval = createCommandApproval(approvals);
  const askPrompt = createAskPrompt(approvals);
  const planApproval = createPlanApproval(approvals);

  deps.host.handle('ai.confirmCommand', async (params) => ({
    // `review` приходит, только если проверка модели не решилась разрешить сама:
    // её причина нужна человеку в карточке.
    allowed: await commandApproval.confirm(params.command, params.review?.reason),
  }));

  // Действия в браузере — тоже карточка в ленте: страница может сделать что угодно
  // от имени пользователя, поэтому вопрос задаётся тем же способом.
  deps.host.handle('ai.confirmBrowser', async (params) => ({
    allowed: await commandApproval.confirmBrowser(params.action),
  }));

  // Вопрос агенту к человеку: карточка с полем ввода (и кнопками вариантов).
  // Ответ уходит модели результатом вызова — прогон ждёт его и продолжается.
  deps.host.handle('ai.ask', async (params) => ({
    answer: await askPrompt.ask(params.question, params.options),
  }));

  // «Утвердить план»: карточка с планом и решением. Утверждение переводит композер
  // в «Агента» — режим обещал чтение без изменений, и дальше он уже врёт. Режим
  // меняется здесь, а не в main: композер живёт в renderer.
  deps.host.handle('ai.exitPlan', async (params) => {
    const decision = await planApproval.ask(params.plan);
    if (decision.approved) composer.setMode('agent');
    return decision;
  });

  deps.host.handle('ai.applyEdits', async (params) => applyAgentEdits(params));

  // Правки по якорю: позиции считаем здесь, потому что только здесь есть текст
  // документа — в том числе несохранённый. Дальше набор правок идёт тем же путём,
  // что правка по позициям: ревью, undo и панель изменений работают как обычно.
  deps.host.handle('ai.applyPatches', async (params) => applyAgentPatches(params));

  // Пометки языка живут в renderer (в редакторе), поэтому их отдаёт он.
  deps.host.handle('ai.getDiagnostics', async (params) => ({ items: deps.editors.markers(params.path) }));

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
    // При полном доступе применяем всё сразу, иначе спрашиваем: какие файлы применить.
    const selected = params.autoApprove === true ? [...params.edits] : await editReview.review(params.edits);
    if (!selected || selected.length === 0) return { rejected: true };

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
    // На диск пишем только при полном доступе (экрана ревью не было — значит,
    // правки применяются сразу, как и говорит эта настройка). Иначе они ложатся
    // в документы в памяти, файлы помечаются «не сохранён», а записывает их
    // человек кнопкой «Сохранить» в панели изменений. Без записи на диск при
    // полном доступе следующий read_file/search (main читает с диска) показывал
    // бы старый текст, хотя инструмент уже отчитался «применено».
    const applied = result.reports.length > 0;
    // Причины незаписи собираем, а не только показываем тостом: по ним агент
    // понимает, что смотреть, а не просто «правка не на диске».
    const reasons = applied
      ? await persistPaths(result.reports.map((report) => report.path))
      : new Map<string, string>();

    // Что осталось только в буфере. Раньше здесь ничего не делалось: агент
    // получал строку «правку сохранит человек» и шёл дальше, а файл на диске
    // оставался старым — следующий read видел не то, что агент только что
    // написал. В open-беседе так и накопились два грязных буфера.
    //
    // Теперь на полном доступе дожимаем запись: `persistPaths` выше мог не
    // справиться (конфликт времени, ошибка ввода-вывода), а признак — всё тот
    // же `dirty` у документа.
    if (params.autoApprove === true && applied) {
      for (const [path, reason] of await persistPaths(
        result.reports.map((report) => report.path).filter((path) => deps.documents.get(path)?.dirty),
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
    setPaused,
    busyHint: (hint) => {
      // Запоминаем в сессии, а не только в UI: прогон мог идти в фоновой вкладке,
      // и при переключении туда шапка должна сразу показать работу, а не ждать
      // следующего вызова инструмента — его может и не быть.
      const session = streamingSession;
      if (session) session.busyHint = hint ?? undefined;
      if (session && session.id !== activeId) return;
      deps.onBusyHint?.(hint);
    },
    closeApprovals,
    setStreaming: (session) => {
      streamingSession = session;
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
      const unsaved = [...session.touched.keys()].filter(
        (path) => deps.documents.get(path)?.dirty === true,
      );
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
    modes: () => composer.modes(),
  });

  input.addEventListener('input', () => menu.sync());

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
    setPaused,
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
