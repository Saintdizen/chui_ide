import {
  ChatStreamEvent,
  type ApplyEditsHostParams,
  type ApplyEditsHostResult,
  type ApplyPatchesHostParams,
  type ChatAttachment,
  type ChatDeltaPayload,
  type ChatMessage,
  type PickedImage,
  type ReasoningEffort,
  type Settings,
} from '../../shared/api';
import { sanitizeToolPreset, toolPresetSpec, type ToolPresetId } from '../../shared/tool-presets';
import type { ApplyFailure, FileEdit } from '../../shared/edits';
import { expandCommandPrompt, findCommand, parseCommandInvocation, type ProjectCommand } from '../../shared/commands';
import { sessionAttachment } from '../../shared/session-context';
import { isAutoTitle } from '../../shared/chat-title';
import { resolvePatches } from '../../shared/patch';
import { compactionBudgetChars, contextUsage, splitTranscript } from '../../shared/context-fit';
import { contextWindow, modelCapabilities } from '../../shared/providers';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { EditService } from '../core/edits';
import type { EditorApi } from '../core/editor-api';
import type { HostService } from '../core/host';
import type { WorkspaceModel } from '../core/workspace-model';
import { type RpcClient, RpcError } from '../core/rpc';
import { basename, clear, h, type IconName, pulseOnClick, svgIcon } from './dom';
import { createSessionInfo, createUsageRing, type SessionInfoData } from './session-info';
import { createAttachments } from './chat-attachments';
import { createToolFeed, type ToolCardView } from './chat-tools';
import { createMarkdownRenderer } from './chat-markdown';
import { createChatComposer } from './chat-composer';
import { createComposerMenu } from './chat-composer-menu';
import { createChangesPanel } from './chat-changes';
import { createPlanPanel } from './chat-plan';
import { createGoalPanel } from './chat-goal';
import { CONTINUE_PROMPT, createStreamRunner } from './chat-stream';
import type { ChatSession } from './chat-session';
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
import { showContextMenu } from './context-menu';
import { showToast } from './toast';

/**
 * Чем кончился ход по готовому тексту (расписание).
 *
 * Не «получилось ли», а именно исход: `busy` — ассистент уже занят и вопрос не
 * ушёл, `unavailable` — не выбраны провайдер или модель, `failed` — модель
 * отказала, `stopped` — человек остановил генерацию. Список задач показывает это
 * словами, и «готово» не должно стоять там, где ответа не было.
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
  stop(): void;
  /**
   * Начать ход по готовому тексту в новой беседе — вход для расписания: вопрос
   * формулирует файл задачи, а не человек в поле ввода.
   */
  sendPrompt(text: string): Promise<PromptRun>;
  /**
   * Проверка модели разрешила команду без человека. Строка ложится в ленту того
   * хода, что идёт сейчас: молча выполненное действие должно быть видно.
   */
  noteApprovalReview(command: string, reason: string): void;
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
  commands: CommandRegistry;
  /** Рабочая папка: её корень — ключ, по которому main находит историю бесед. */
  workspace: WorkspaceModel;
  settings: Settings;
  /** Модальное окно со всеми настройками приложения. */
  settingsModal: SettingsOpener;
  /** Приёмник хостовых вызовов: правки приходят из main. */
  host: HostService;
  /** Переключить чат между боковой панелью и областью редактора. */
  toggleEditor?: () => void;
  /** Чат уже в области редактора — от этого зависит подпись пункта меню. */
  isInEditor?: () => boolean;
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
 * Доля окна, после которой освобождаем контекст заранее.
 *
 * Проверять «в упор» (used + ответ = всё окно) бесполезно: пока считаешь, история
 * успевает дорасти, а провайдер отклонить запрос. Поэтому сжимаем с запасом —
 * когда до предела остаётся 20%.
 */
const COMPACT_AT_RATIO = 0.8;

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
  const active = (): ChatSession => sessions.find((session) => session.id === activeId) ?? sessions[0]!;

  const body = h('div', { class: 'chat-body' });

  /** Кнопка возврата к низу: появляется, когда лента прокручена вверх. */
  const jumpButton = h(
    'button',
    {
      class: 'chat-jump',
      type: 'button',
      title: 'К последнему сообщению',
      onClick: () => {
        autoScroll = true;
        jumpButton.hidden = true;
        body.scrollTop = body.scrollHeight;
      },
    },
    svgIcon('chevronDown', 16),
  );
  jumpButton.hidden = true;

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
    return command ? expandCommandPrompt(command, invocation.tail) : written;
  }

  /* ── панель изменений, план агента и контекст к вопросу ──────────────────── */

  /**
   * Показать файл человеку: сперва открыть, потом встать на место. Документа может
   * не быть вовсе — созданный агентом файл в редакторе ещё не открывали, — и тогда
   * `editors.reveal` молчит: модели документа у него нет.
   */
  const revealFile = async (path: string, line = 1, column = 1): Promise<void> => {
    await deps.openFile?.(path);
    deps.editors.reveal(path, line, column);
  };

  // Панель изменений и план агента — отдельные модули: они только рисуют по
  // состоянию беседы, а работа с документами и редактором остаётся здесь.
  const changesPanel = createChangesPanel({
    reveal: (path, line, column) => void revealFile(path, line, column),
    onRevert: () => void revertTouched(),
    onSave: () => void saveTouched(),
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

  /**
   * Контекстное меню вкладки беседы: перенос в окно редактора и закрытие.
   * Перенос — не свойство одной беседы, панель переезжает целиком, но открыть
   * меню логично на той вкладке, с которой работаешь.
   */
  function openTabMenu(id: number, event: MouseEvent): void {
    const inEditor = deps.isInEditor?.() === true;
    showContextMenu(
      [
        {
          label: inEditor ? 'Вернуть в боковую панель' : 'Перенести в окно редактора',
          // Клавиша только открывает: подпись для возврата была бы обманом.
          hint: inEditor ? undefined : 'Ctrl+Alt+E',
          onSelect: () => {
            activate(id);
            void deps.commands.execute(inEditor ? 'ai.backToPanel' : 'ai.openInEditor');
          },
        },
        { separator: true },
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
      thread: h('div', { class: 'chat-thread' }),
      history: [],
      transcript: [],
      touched: new Map(),
      files: [],
      attachments: [],
      draft: '',
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
    closeApprovals();
    menu.hide();
    activeId = id;

    for (const session of sessions) session.thread.hidden = session.id !== id;
    const next = active();
    input.value = next.draft;
    attachments.render();
    renderChanges();
    goalPanel.render(next.goal ?? null);
    renderTabs();
    syncSessionInfo();

    // Занятость общая: прогон в окне один, поэтому и поле одно на все вкладки.
    input.disabled = busy;
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
      input.focus();
    });
  }

  /** Закрытие вкладки. Последнюю не закрываем — вместо неё появляется пустая. */
  function closeSession(id: number): void {
    if (sessions.length === 1) {
      newChat();
      return;
    }

    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;
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
        session.trace = conversation.trace;
        session.goal = conversation.goal;
        renderHistory(session);
      }
      if (sessions.length === 0) createSession();

      const restored = history.activeUid ? sessions.find((item) => item.uid === history.activeUid) : undefined;
      activeId = (restored ?? sessions[0]!).id;
      syncActiveView();
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
    if (session.transcript.length === 0) {
      renderIntro(session);
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
          const feed = createToolFeed(el);
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
    if (session.compacted) appendCompactedNote(session);
    scrollToEnd(session);
  }

  /* ── информация о сессии ───────────────────────────────────────────────── */

  const sessionInfo = createSessionInfo({ onCompact: () => void compactActive() });

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
      reservedTokens: settings.ai.maxTokens,
      usage: session.usage,
      speed: session.speed,
      trace: session.trace,
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
    return compactionBudgetChars(contextWindow(model, override), settings.ai.maxTokens + 2_000);
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
      session.usage = undefined;
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
   * Перед отправкой решаем, не пора ли освободить контекст. Триггеров два:
   * заполнение подошло к пределу окна (`COMPACT_AT_RATIO`, с запасом, а не «в упор»)
   * либо история переросла абсолютный предел — он выручает на моделях с огромным
   * окном, где доля недостижима. Предел равен `COMPACT_AT_TOKENS` по умолчанию, но
   * его можно поднять в настройках (`ai.compactAtTokens`); 0 — только по окну.
   * Иначе провайдер обрежет запрос или вернёт ошибку лимита. Сжимать нечего —
   * просто предупреждаем.
   */
  async function ensureContextFits(session: ChatSession, pending: string): Promise<boolean> {
    const usage = contextUsage(sessionInfoData(session, pending));
    const nearWindow = usage.used + settings.ai.maxTokens > usage.limit * COMPACT_AT_RATIO;
    const absolute = settings.ai.compactAtTokens;
    const tooLong = absolute > 0 && usage.used > absolute;
    if (!nearWindow && !tooLong) return true;

    if (session.history.length < 2) {
      showToast('Контекст переполнен, но сжимать почти нечего — ответ может обрезаться', 'error');
      return true;
    }
    showToast(
      nearWindow
        ? 'Контекст переполнен — сжимаю беседу перед отправкой'
        : 'Беседа слишком длинная — сжимаю перед отправкой',
    );
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
    session.thread.appendChild(note);
    session.compacted = true;
    // Прокручиваем к отметке: новый вопрос встанет ниже неё. Прыжка в начало
    // ленты (как было) нет — человек продолжает читать с того же места.
    if (session.id === activeId) note.scrollIntoView({ block: 'nearest' });
  }

  /** Отметка о сжатии для восстановленной беседы: резюме берём из её контекста. */
  function appendCompactedNote(session: ChatSession): void {
    const summary = session.history[0]?.content ?? '';
    session.thread.appendChild(
      h(
        'details',
        { class: 'thread-summary' },
        h('summary', { class: 'thread-summary-head' }, svgIcon('collapse', 12), 'Контекст беседы сжат'),
        h(
          'div',
          { class: 'thread-summary-text' },
          'Выше — вся переписка, её можно перечитать. Модель дальше получает только это резюме:',
          h('div', { class: 'thread-summary-body' }, summary),
        ),
      ),
    );
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
        ? 'Усилие размышления: сколько модель думает перед ответом'
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

  /** Набор инструментов — из настроек: он общий для всех бесед и переживает перезапуск. */
  function syncToolPreset(): void {
    composer.setToolPreset(sanitizeToolPreset(settings.ai.toolPreset));
  }

  async function saveToolPreset(preset: ToolPresetId): Promise<void> {
    try {
      settings = await deps.rpc.request('settings.update', { ai: { toolPreset: preset } });
      syncToolPreset();
      showToast(`Набор инструментов: ${toolPresetSpec(preset).label}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
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
  async function persistPaths(paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      const document = deps.documents.get(path);
      if (!document?.dirty) continue;
      try {
        // Пишем через сервис правок: он сверяет время файла и не даёт молча
        // перетереть чужую правку (того же файла мог коснуться другой инструмент).
        const result = await deps.edits.saveDocument(document);
        if (result === 'conflict') {
          showToast(`Файл изменён на диске, не перезаписан: ${basename(path)}`, 'error');
        }
      } catch {
        // не записалось — файл останется «грязным», следующая правка повторит
      }
    }
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

  // Композер и всё, что под лентой. Кнопка «к последнему сообщению» живёт здесь
  // же и позиционируется от футера: иначе фиксированный отступ при высоком
  // поле ввода оставлял бы кнопку поверх него.
  const footer = h('div', { class: 'chat-footer' }, composer.element, menu.element);
  footer.appendChild(jumpButton);

  // План, изменённые файлы и приложенный контекст — ВНУТРИ карточки композера, над
  // полем ввода: они относятся к вопросу, который человек набирает, а не к беседе.
  // Порядок стопки — сверху вниз: план, изменения, чипы.
  composer.extras.append(goalPanel.element, planPanel.element, changesPanel.element, attachments.element);

  const element = h('div', { class: 'chat' }, tabs.element, tabs.searchBar, body, footer);

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

  function syncProviderFields(): void {
    syncModelLabel();
  }

  /* ── рендер сообщений ──────────────────────────────────────────────────── */

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
  ): HTMLElement {
    const content = h('div', { class: 'msg-body' });
    if (text) markdown.renderInto(content, text);
    const messageEl = h('div', { class: `msg msg-${role}` }, content, imagesNode(images));
    // Действия есть только у вопросов пользователя — у ответов они рисуются
    // отдельно, когда ответ завершён (см. chat-stream.ts / renderHistory).
    if (role === 'user' && onEdit) attachUserActions(messageEl, text, onEdit);
    // Вопрос открывает новый ход, ответ дописывается в текущий.
    (role === 'user' ? beginTurn(session) : currentTurn(session)).appendChild(messageEl);
    scrollToEnd(session);
    return content;
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

  /** Кнопки под сообщением пользователя: править текст вопроса и скопировать. */
  function attachUserActions(messageEl: HTMLElement, text: string, onEdit: () => void): void {
    messageEl.appendChild(
      h(
        'div',
        { class: 'msg-actions' },
        messageAction('pencil', 'Править', onEdit),
        messageAction('copy', 'Копировать', () => copyText(text)),
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

  /** «Править»: отрезать этот вопрос и всё после него, вернуть текст в поле ввода. */
  function editUserMessage(session: ChatSession, index: number, text: string): void {
    if (busy) {
      showToast('Дождитесь ответа или остановите генерацию');
      return;
    }
    if (index < 0 || index >= session.history.length) return;

    session.history = session.history.slice(0, index);
    session.usage = undefined;
    session.speed = undefined;
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
    session.usage = undefined;
    session.speed = undefined;
    renderHistory(session);
    await stream.run(session, provider.id, model, []);
  }

  async function send(raw: string): Promise<PromptRun> {
    const written = raw.trim();
    if (!written || busy) return 'busy';
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
    if (session.history.length === 1) {
      // Первый вопрос убирает приветствие: беседа началась, подсказка больше не нужна.
      clear(session.thread);
      syncTabTitle(session, text);
    }
    const index = session.history.length - 1;
    appendMessage(session, 'user', text, () => editUserMessage(session, index, text), images);

    // Новый вопрос — снова следим за низом ленты.
    autoScroll = true;
    jumpButton.hidden = true;

    const outcome = await stream.run(session, provider.id, model, sent);
    // Название — после ответа и не в очередь отправки: человек не должен ждать
    // лишний запрос, чтобы увидеть ответ.
    void maybeNameSession(session);
    return outcome === 'done' ? 'started' : outcome;
  }

  function setBusy(value: boolean, _session: ChatSession = active()): void {
    busy = value;
    // Искра в кнопке «Информация о сессии»: цвет говорит, что ассистент работает.
    aiSparkle.classList.toggle('is-busy', busy);
    aiSparkle.title = busy ? 'AI: генерация…' : 'AI: готов';
    // Поле ввода гасит прогон, а он в окне один (см. `rpc.ts`: активный стрим —
    // один). Поэтому блокируем поле разом для всех вкладок: композер ставит
    // `disabled` на общее поле и меняет кнопку отправки на «стоп».
    composer.setBusy(value);
  }

  function stop(): void {
    if (!busy) {
      showToast('Сейчас ничего не генерируется');
      return;
    }
    deps.rpc.cancelActive();
  }

  /** Новая беседа — новая вкладка: старые остаются на месте. */
  function newChat(): void {
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
      body.scrollTop = 0;
      input.focus();
    });
  }

  /**
   * Запустить ход по готовому тексту — так в беседу входит задача расписания.
   *
   * Возвращает не «получилось ли», а ПОЧЕМУ нет: расписание отмечает итог, и
   * «ассистент занят» — это пропуск, а не ошибка настроек.
   */
  async function sendPrompt(text: string): Promise<PromptRun> {
    if (busy) return 'busy';
    if (!currentProvider() || !currentModel()) return 'unavailable';
    return send(text);
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

  async function currentText(target: string): Promise<string | null> {
    const open = deps.documents.get(target);
    if (open) return open.value;
    try {
      const file = await deps.rpc.request('workspace.readFile', { path: target });
      return file.text;
    } catch {
      return null; // файла нет или путь вне проекта — покажем это в карточке
    }
  }

  // Решения (ревью правок, подтверждение команды) живут в `chat-approvals.ts`:
  // там разметка карточек, а панель только подключает их к ленте и к отмене.
  // Карточка ложится в ту ленту, откуда пришёл вызов, даже если человек успел
  // переключить вкладку: беседу берёт замыкание `mount`.
  const approvals: ApprovalHost = {
    readText: currentText,
    mount: (block) => currentTurn(streamingSession ?? active()).appendChild(block),
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

  // Действия git спрашивают тем же способом, что и команды: карточка в ленте.
  deps.host.handle('ai.confirmGit', async (params) => ({
    allowed: await commandApproval.confirmGit(params.action),
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
  // что apply_edit: ревью, undo и панель изменений работают как обычно.
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
    }

    const result = await deps.edits.applyFileEdits(selected, 'programmatic');
    // На диск пишем только при полном доступе (экрана ревью не было — значит,
    // правки применяются сразу, как и говорит эта настройка). Иначе они ложатся
    // в документы в памяти, файлы помечаются «не сохранён», а записывает их
    // человек кнопкой «Сохранить» в панели изменений. Без записи на диск при
    // полном доступе следующий read_file/search (main читает с диска) показывал
    // бы старый текст, хотя инструмент уже отчитался «применено».
    if (params.autoApprove === true && result.reports.length > 0) {
      await persistPaths(result.reports.map((report) => report.path));
    }

    // Что осталось только в буфере: без полного доступа файл пишет человек, а при
    // конфликте запись не проходит вовсе. Об этом говорим наружу — main читает файлы
    // с диска, и агент без этой оговорки счёл бы старый текст уже применённым.
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

    return { rejected: false, result, ...(unwritten.length > 0 ? { unwritten } : {}) };
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
      const resolved = resolvePatches(text, file.patches);
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
  const markdown = createMarkdownRenderer({ insertCode: (code) => deps.editors.insertAtCursor(code) });

  /**
   * Стриминг ответа вынесен в отдельный модуль: он умеет всё сам и лишь просит
   * панель про прокрутку, занятость и панели — эти действия передаём сюда.
   */
  const stream = createStreamRunner({
    rpc: deps.rpc,
    markdown,
    messageHost: (session) => currentTurn(session),
    scrollToEnd: (session) => scrollToEnd(session),
    renderPlan: (steps) => planPanel.render(steps),
    setGoal: (goal, session) => {
      // Цель пишем в СВОЮ беседу: прогон мог идти в фоновой вкладке, а панель
      // показывает активную. Перерисовываем только если она и есть активная.
      session.goal = goal ?? undefined;
      if (session.id === activeId) goalPanel.render(goal);
      scheduleSave();
    },
    hidePlan: () => planPanel.hide(),
    renderChanges,
    setBusy,
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
    openRunLog: (session) => {
      runInspector.open(session.run ?? null, session.title ? `беседа: ${session.title}` : undefined);
    },
    afterStream: () => {
      renderTabs();
      renderChanges();
      syncSessionInfo();
      scheduleSave();
    },
    modes: () => composer.modes(),
  });

  input.addEventListener('input', () => menu.sync());

  input.addEventListener('keydown', (event) => {
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
    stop,
    askAboutSelection,
    sendPrompt,
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
      settings = next;
      syncProviderFields();
      syncEffort();
      syncToolPreset();
      // Размер контекстного окна тоже в настройках: кольцо должно пересчитаться
      // сразу, а не после следующего ответа модели.
      syncSessionInfo();
      syncAiAvailability();
    },
  };
}

/* Карточки вызовов инструментов и лента действий живут в `chat-tools.ts`. */
