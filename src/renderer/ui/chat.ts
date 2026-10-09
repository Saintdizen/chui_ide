import {
  ChatStreamEvent,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BYTES,
  type ApplyEditsHostParams,
  type ApplyEditsHostResult,
  type ChatAttachment,
  type ChatConversation,
  type ChatDeltaPayload,
  type ChatHistory,
  type ChatMessage,
  type ChatPlanPayload,
  type ChatReasoningPayload,
  type ChatStreamDone,
  type ChatToolResultPayload,
  type ToolFileChange,
  type ChatToolStartPayload,
  type ChatUsage,
  type DirEntry,
  type PickedImage,
  type ReasoningEffort,
  type Settings,
} from '../../shared/api';
import type { FileEdit } from '../../shared/edits';
import { modelCapabilities } from '../../shared/providers';
import { languageFromPath } from '../core/languages';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { EditService } from '../core/edits';
import type { EditorService } from '../core/editor-service';
import type { HostService } from '../core/host';
import type { WorkspaceModel } from '../core/workspace-model';
import { relativePath } from '../core/workspace-model';
import { type RpcClient, RpcError } from '../core/rpc';
import { basename, clear, h, type IconName, svgIcon } from './dom';
import { createSelect } from './select';
import { createSessionInfo, createUsageRing, contextUsage, type SessionInfoData } from './session-info';
import { createToolFeed, toolLabel, type ReasoningRowView, type ToolCardView } from './chat-tools';
import { createMarkdownRenderer } from './chat-markdown';
import { createComposerMenu } from './chat-composer-menu';
import { createChangesPanel } from './chat-changes';
import { createPlanPanel } from './chat-plan';
import {
  createCommandApproval,
  createEditReview,
  type ApprovalHost,
} from './chat-approvals';
import { countLines, formatBytes, plural, snippetFor, titleFrom } from './chat-text';
import { showContextMenu } from './context-menu';
import { showToast } from './toast';

export interface ChatView {
  element: HTMLElement;
  newChat(): void;
  stop(): void;
  askAboutSelection(mode: 'explain' | 'fix'): Promise<void>;
  applySettings(settings: Settings): void;
}

/** Что чату нужно от окна настроек: только показать его. */
export interface SettingsOpener {
  open(): void;
}

export interface ChatDeps {
  rpc: RpcClient;
  documents: DocumentStore;
  editors: EditorService;
  edits: EditService;
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

/** Режим работы панели: спросить, поработать с подтверждениями или наметить план. */
type ChatMode = 'ask' | 'agent' | 'plan';

/**
 * Сжатие беседы: старая история заменяется резюме. Пересказ просим у той же модели —
 * пересказывать код она умеет, а своего суммаризатора у нас нет.
 */
const COMPACT_PROMPT = [
  'Сожми нашу беседу в краткое резюме, чтобы продолжить работу с ним вместо истории.',
  'Сохрани: что просил пользователь, какие файлы менялись, принятые решения, найденные ошибки',
  'и что осталось сделать. Пиши по пунктам, без вступлений и без кода целиком.',
].join('\n');

/** Сколько символов беседы уезжает на сжатие: хвост важнее начала. */
const MAX_COMPACT_CHARS = 40_000;

/**
 * Обрыв по лимиту токенов достраиваем сами, но с пределом: иначе зацикленная
 * модель жгла бы токены без конца. Дальше — ручная кнопка «Продолжить».
 */
const MAX_AUTO_CONTINUE = 2;
const CONTINUE_PROMPT = 'Ответ оборвался по лимиту токенов. Продолжи ровно с того места, где остановился, без повторов.';


/**
 * Панель ассистента — правый «остров» в стиле tool window.
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
  /** Режим панели: ответ на вопрос, агент с подтверждениями или план без изменений. */
  let mode: ChatMode = 'ask';
  let useTools = false;
  let planMode = false;
  // Права доступа: кнопка в композере. Включено — команды и правки без вопросов.
  let autoApprove = false;
  let streamBuffer = '';
  let frame = 0;
  /**
   * Тянем ли ленту вниз автоматически. Пользователь прокрутил вверх —
   * стрим не дёргает ленту; вернулся к низу (или нажал кнопку) — снова тянем.
   */
  let autoScroll = true;
  /** Ожидания решений пользователя (ревью правок, подтверждение команды). */
  const pendingApprovals = new Set<() => void>();

  /**
   * Беседа. Вкладок может быть много, поэтому всё, что относится к диалогу —
   * история, ленты сообщений, правки и приложенный контекст, — живёт здесь,
   * а не в переменных панели: иначе вторая вкладка затирала бы первую.
   */
  interface ChatSession {
    id: number;
    /** Стабильный идентификатор для сохранения: номер вкладки перезапуск не переживёт. */
    uid: string;
    title: string;
    /** Лента сообщений: своя у каждой беседы, при переключении не перерисовывается. */
    thread: HTMLElement;
    history: ChatMessage[];
    /** Файлы, которые агент изменил именно в этой беседе (правки документов). */
    touched: Map<string, { original: string; added: number; removed: number }>;
    /** Файлы, которых агент коснулся без правки документа: создал, удалил, перенёс. */
    files: ToolFileChange[];
    attachments: ChatAttachment[];
    /** Недописанный вопрос: вернулся на вкладку — текст на месте. */
    draft: string;
    /** Последний ответ: реальный размер контекста, каким его увидел провайдер. */
    usage?: ChatUsage;
    /** Скорость последнего ответа в токенах в секунду (для «Информации о сессии»). */
    speed?: number;
  }

  const sessions: ChatSession[] = [];
  let activeId = 0;
  let nextId = 1;
  /** Беседа, которая сейчас генерирует: хостовые вызовы приходят именно от неё. */
  let streamingSession: ChatSession | null = null;
  /** Корень папки, к которой привязана текущая история: ключ сохранения. */
  let chatRoot: string | null = null;
  let saveTimer = 0;
  let uidSeq = 0;
  /** Идентификатор беседы: переживает перезапуск, поэтому не равен номеру вкладки. */
  const newUid = (): string => `chat_${Date.now().toString(36)}_${(uidSeq += 1).toString(36)}`;

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
  const input = h('textarea', {
    class: 'chat-input',
    rows: 3,
    placeholder: 'Спросите о коде. «/» — команды, «#» — контекст, «@» — файл проекта (Enter — отправить)',
    spellcheck: false,
  });

  /* ── композер: панель изменений, чипы, тулбар, статус ──────────────────── */

  // Панель изменений и план агента — отдельные модули: они только рисуют по
  // состоянию беседы, а работа с документами и редактором остаётся здесь.
  const changesPanel = createChangesPanel({
    reveal: (path, line, column) => deps.editors.reveal(path, line, column),
    onRevert: () => void revertTouched(),
  });
  const planPanel = createPlanPanel();

  /* ── контекст, который прикладывает пользователь ───────────────────────── */

  const attachmentChips = h('div', { class: 'composer-chips', hidden: true });

  /** Больше в промпт не влезет: файл целиком нужен редко, а место занимает всегда. */
  const MAX_ATTACHMENT_CHARS = 40_000;

  /** Контекст приложен к конкретной беседе: у каждой вкладки свои чипы. */
  function renderAttachments(): void {
    const attachments = active().attachments;
    clear(attachmentChips);
    attachmentChips.hidden = attachments.length === 0;

    attachments.forEach((item, index) => {
      const image = item.kind === 'image' && item.dataUrl ? item : null;
      attachmentChips.appendChild(
        h(
          'span',
          {
            class: `chip chip-static${image ? ' chip-image' : ''}`,
            title: image ? `${item.title} · ${formatBytes(item.bytes ?? 0)}` : `${item.title}\n\n${item.text.slice(0, 300)}`,
          },
          // У картинки вместо значка — она сама: по миниатюре видно, что приложено,
          // и не приходится открывать файл, чтобы это проверить.
          image ? h('img', { class: 'chip-thumb', src: image.dataUrl!, alt: item.label }) : svgIcon(item.kind === 'problems' ? 'warning' : 'file', 12),
          h('span', { class: 'chip-name' }, item.label),
          image ? h('span', { class: 'chip-hint' }, formatBytes(item.bytes ?? 0)) : null,
          h(
            'button',
            {
              class: 'chip-remove',
              type: 'button',
              title: 'Убрать из контекста',
              onClick: () => removeAttachment(index),
            },
            svgIcon('close', 10),
          ),
        ),
      );
    });
  }

  function addAttachment(item: ChatAttachment | null): void {
    if (!item) return;
    const session = active();
    if (session.attachments.some((existing) => existing.label === item.label)) {
      showToast('Этот контекст уже приложен');
      return;
    }
    session.attachments = [...session.attachments, item];
    renderAttachments();
  }

  function removeAttachment(index: number): void {
    const session = active();
    session.attachments = session.attachments.filter((_, position) => position !== index);
    renderAttachments();
  }

  /* ── изображения ───────────────────────────────────────────────────────── */

  /** Файл из буфера или перетаскивания — в data-URL средствами браузера. */
  function readAsDataUrl(file: File): Promise<string | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function addImage(image: PickedImage): void {
    const session = active();
    if (session.attachments.length >= MAX_CHAT_IMAGES) {
      showToast(`К вопросу можно приложить не больше ${MAX_CHAT_IMAGES} изображений`, 'error');
      return;
    }

    // Подпись у картинки — имя файла, а имя у двух разных вставок может совпасть:
    // считаем повтором только те же имя, размер и данные.
    const duplicate = session.attachments.some(
      (item) => item.kind === 'image' && item.label === image.name && item.bytes === image.bytes,
    );
    if (duplicate) {
      showToast('Это изображение уже приложено');
      return;
    }

    session.attachments = [
      ...session.attachments,
      {
        kind: 'image',
        label: image.name,
        title: `Изображение ${image.name}`,
        text: '',
        dataUrl: image.dataUrl,
        bytes: image.bytes,
      },
    ];
    renderAttachments();
  }

  /** Файлы из буфера и из перетаскивания идут одним путём: и там, и там это File. */
  async function attachFiles(files: readonly File[]): Promise<void> {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) {
      showToast('Можно приложить только изображения', 'error');
      return;
    }

    for (const file of images.slice(0, MAX_CHAT_IMAGES)) {
      if (file.size > MAX_IMAGE_BYTES) {
        showToast(`${file.name || 'изображение'}: ${formatBytes(file.size)} — больше предела ${formatBytes(MAX_IMAGE_BYTES)}`, 'error');
        continue;
      }
      const dataUrl = await readAsDataUrl(file);
      if (dataUrl) addImage({ name: file.name || 'вставка из буфера', mime: file.type, bytes: file.size, dataUrl });
    }
    input.focus();
  }

  /** Кнопка меню: выбор файла системным диалогом (читает файлы main). */
  async function attachImagesFromDialog(): Promise<void> {
    try {
      const picked = await deps.rpc.request('dialog.pickImages');
      for (const image of picked) addImage(image);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
    input.focus();
  }

  /** Собрать вложение из того, что сейчас открыто в редакторе. */
  function attachmentFrom(kind: 'selection' | 'file' | 'problems'): ChatAttachment | null {
    const path = deps.editors.currentPath;

    if (kind === 'problems') {
      const items = deps.editors.markers(path ?? undefined);
      if (items.length === 0) {
        showToast('Ошибок и предупреждений нет');
        return null;
      }
      return {
        kind,
        label: `ошибки: ${items.length}`,
        title: path ? `Пометки языка в ${path}` : 'Пометки языка',
        text: items
          .map((item) => `${basename(item.path)}:${item.line}:${item.column} [${item.severity}] ${item.message}`)
          .join('\n'),
      };
    }

    const document = path ? deps.documents.get(path) : undefined;
    if (!path || !document) {
      showToast('Нет открытого файла', 'error');
      return null;
    }

    if (kind === 'selection') {
      const selection = deps.editors.selectedText();
      if (!selection.trim()) {
        showToast('Сначала выделите фрагмент в редакторе', 'error');
        return null;
      }
      return {
        kind,
        label: `выделение · ${basename(path)}`,
        title: `Выделение из ${path}`,
        text: `\`\`\`${document.languageId}\n${selection}\n\`\`\``,
      };
    }

    const text =
      document.value.length > MAX_ATTACHMENT_CHARS
        ? `${document.value.slice(0, MAX_ATTACHMENT_CHARS)}\n… (файл обрезан)`
        : document.value;
    return {
      kind: 'file',
      label: basename(path),
      title: `Файл ${path}`,
      text: `\`\`\`${document.languageId}\n${text}\n\`\`\``,
    };
  }

  /** Выделение, а если его нет — файл целиком. */
  function attachBest(): void {
    if (deps.editors.selectedText().trim()) addAttachment(attachmentFrom('selection'));
    else addAttachment(attachmentFrom('file'));
  }

  /** Собрать вложение по произвольному пути: файл целиком или список папки. */
  async function attachmentFromPath(target: string, kind: 'file' | 'dir'): Promise<ChatAttachment | null> {
    try {
      if (kind === 'dir') {
        const entries = await deps.workspace.readDir(target);
        const list = entries.map((entry) => `${entry.name}${entry.kind === 'directory' ? '/' : ''}`).join('\n');
        return {
          kind: 'note',
          label: `${basename(target)}/`,
          title: `Папка ${target}`,
          text: `Содержимое папки ${target}:\n\n${list}`,
        };
      }
      const file = await deps.rpc.request('workspace.readFile', { path: target });
      const text = file.text.length > MAX_ATTACHMENT_CHARS ? `${file.text.slice(0, MAX_ATTACHMENT_CHARS)}\n… (файл обрезан)` : file.text;
      return {
        kind: 'file',
        label: basename(target),
        title: `Файл ${target}`,
        text: `\`\`\`${languageFromPath(target)}\n${text}\n\`\`\``,
      };
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return null;
    }
  }

  /** Вложение из пути: тип определяем через stat, чтобы папка и файл шли разными путями. */
  async function attachPath(target: string): Promise<void> {
    try {
      const stat = await deps.rpc.request('workspace.stat', { path: target });
      addAttachment(await attachmentFromPath(target, stat.kind === 'directory' ? 'dir' : 'file'));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /* ── @-упоминания: список путей проекта ─────────────────────────────────── */

  /** Плоский список путей для подсказки `@`: пересобирается при смене папки. */
  let mentionCache: string[] | null = null;
  const MENTION_SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.cache', '__pycache__', '.venv', 'release']);
  const MAX_MENTIONS = 4000;

  async function collectMentions(): Promise<void> {
    const root = deps.workspace.root;
    if (!root) {
      mentionCache = [];
      return;
    }

    const result: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || result.length >= MAX_MENTIONS) return;
      let entries: DirEntry[];
      try {
        entries = await deps.workspace.readDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (result.length >= MAX_MENTIONS) return;
        const rel = relativePath(root, entry.path);
        if (entry.kind === 'directory') {
          if (MENTION_SKIP.has(entry.name)) continue;
          result.push(`${rel}/`);
          await walk(entry.path, depth + 1);
        } else {
          result.push(rel);
        }
      }
    };
    await walk(root, 0);
    mentionCache = result;
  }

  /* ── меню композера: слэш-команды и контекст ───────────────────────────── */

  // Меню (слэш-команды, `#`-контекст и `@`-файлы) живёт в отдельном модуле:
  // сама панель только строит его и слушает поле ввода. Работа с редактором и
  // проектом остаётся здесь — модуль просит её через колбэки.
  const menu = createComposerMenu({
    input,
    onContext: (kind) => addAttachment(attachmentFrom(kind)),
    onAttachBest: () => attachBest(),
    onPickImage: () => void attachImagesFromDialog(),
    onMention: (path) => {
      const root = deps.workspace.root ?? '';
      void attachPath(root ? `${root}/${path.replace(/\/$/, '')}` : path);
    },
    mentionPaths: () => mentionCache,
    requestMentions: () => void collectMentions(),
  });

  /** Кнопка «+» открывает тот же список контекста: так его видно и без `#`. */
  const contextButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Приложить контекст', onClick: () => menu.toggleContext() },
    svgIcon('plus', 14),
  );

  // Вставка из буфера: screenshot в буфере — самое частое, что прикладывают к
  // вопросу. Текст с картинкой вместе вставляется как текст: картинку берём только
  // тогда, когда она в буфере есть отдельным файлом.
  input.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const files = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;

    event.preventDefault();
    void attachFiles(files);
  });

  // Перетаскивание файла на панель чата: тот же результат, что вставка из буфера.
  // Слушатели вешаются ниже, когда корневой элемент уже собран.

  // Меню живёт поверх панели: закрываем его кликом мимо, как всплывающие слои.
  document.addEventListener('pointerdown', (event) => {
    if (!menu.isOpen()) return;
    const node = event.target as Node;
    if (menu.element.contains(node) || input.contains(node) || contextButton.contains(node)) return;
    menu.hide();
  });

  const actionButton = h('button', {
    class: 'icon-btn composer-action',
    type: 'button',
    onClick: () => {
      if (busy) stop();
      else void send(input.value);
    },
  });

  /**
   * Отправка и остановка — одна кнопка: во время генерации она превращается
   * в «стоп». Двух кнопок рядом не бывает: нажимать их одновременно нельзя.
   */
  function syncActionButton(): void {
    clear(actionButton);
    actionButton.appendChild(svgIcon(busy ? 'stop' : 'send', 15));
    actionButton.title = busy ? 'Остановить генерацию' : 'Отправить (Enter)';
    actionButton.classList.toggle('composer-action-send', !busy);
    actionButton.classList.toggle('composer-action-stop', busy);
  }

  const modeSelect = createSelect({
    class: 'composer-select',
    title:
      'Вопрос — просто ответ без инструментов. Агент — сам читает проект, правит файлы и запускает команды, ' +
      'но действия подтверждаете вы (права — кнопкой рядом). План — только читает проект и составляет план, ничего не меняя.',
  });
  modeSelect.setOptions([
    { value: 'ask', label: 'Вопрос', icon: 'bubble' },
    { value: 'agent', label: 'Агент', icon: 'wrench' },
    { value: 'plan', label: 'План', icon: 'checklist' },
  ]);
  modeSelect.onChange((value) => {
    mode = value as ChatMode;
    syncMode();
  });

  const modelButton = h(
    'button',
    {
      class: 'composer-model',
      type: 'button',
      title: 'Провайдер, модель, ключ',
      onClick: () => deps.settingsModal.open(),
    },
    svgIcon('sparkle', 12),
    h('span', {}, 'модель не выбрана'),
  );
  const effortSelect = createSelect({
    class: 'composer-select',
    title: 'Усилие размышления: сколько модель думает перед ответом',
  });
  effortSelect.setOptions([
    { value: 'off', label: 'Без размышлений' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ]);
  effortSelect.onChange((value) => void saveEffort(value as ReasoningEffort));

  /**
   * Подсказку вешаем на обёртку: у выключенного контрола браузер не показывает
   * `title`, а именно там и нужно объяснить, почему он выключен.
   */
  const effortField = h('span', { class: 'composer-field' }, effortSelect.element);

  /** Значок статуса — тот же, что у режима в селекте: картинка и подпись совпадают. */
  const modeIcon = h('span', { class: 'composer-status-icon' }, svgIcon('bubble', 12));
  const modeName = h('span', {}, '');
  const modeBadge = h('span', { class: 'composer-status-item' }, modeIcon, modeName);

  /**
   * Права доступа — отдельный тумблер, а не часть режима: включён — команды и правки
   * выполняются без вопросов, выключен — на каждое действие спрашиваем. В «Вопросе»
   * и «Плане» смысла не имеет: там менять нечего, поэтому кнопка недоступна.
   */
  const permButton = h('button', {
    class: 'icon-btn composer-perm',
    type: 'button',
    onClick: () => {
      autoApprove = !autoApprove;
      syncPermButton();
      // Сообщаем main: если агент уже работает, следующее действие возьмёт новые права.
      void deps.rpc.request('ai.setPermission', { autoApprove }).catch(() => undefined);
    },
  });

  /** Состояние кнопки прав: значок, подпись и активный вид — по текущему режиму. */
  function syncPermButton(): void {
    // Только в «Агенте» есть что разрешать: в «Вопросе» и «Плане» изменений нет.
    const canToggle = mode === 'agent';
    permButton.disabled = !canToggle;
    clear(permButton);
    permButton.appendChild(svgIcon(canToggle && autoApprove ? 'unlock' : 'lock', 14));
    permButton.classList.toggle('is-active', canToggle && autoApprove);
    permButton.title = !canToggle
      ? 'Права доступа: доступно в режиме «Агент»'
      : autoApprove
        ? 'Полный доступ: команды и правки выполняются без подтверждений'
        : 'Спрашивать разрешение на каждое действие';
  }

  /* ── беседы: вкладки в стиле вкладок редактора ───────────────────── */

  const tabList = h('div', { class: 'tabs chat-tab-list' });
  const newChatButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Новая беседа', onClick: () => newChat() },
    svgIcon('plus', 15),
  );

  /* ── поиск по беседам ──────────────────────────────────────────────────── */

  const searchInput = h('input', {
    class: 'chat-search-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'Поиск по всем беседам',
  });
  const searchResults = h('div', { class: 'chat-search-results', hidden: true });
  const searchBar = h('div', { class: 'chat-search', hidden: true }, searchInput, searchResults);
  const searchButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Поиск по беседам', onClick: () => toggleSearch() },
    svgIcon('search', 14),
  );

  function toggleSearch(): void {
    searchBar.hidden = !searchBar.hidden;
    if (searchBar.hidden) {
      searchInput.value = '';
      searchResults.hidden = true;
      clear(searchResults);
      input.focus();
    } else {
      searchInput.focus();
    }
  }

  function runSearch(): void {
    const query = searchInput.value.trim().toLowerCase();
    clear(searchResults);
    if (!query) {
      searchResults.hidden = true;
      return;
    }

    const matches: Array<{ session: ChatSession; snippet: string }> = [];
    for (const session of sessions) {
      for (const message of session.history) {
        const snippet = snippetFor(message.content ?? '', query);
        if (snippet === null) continue;
        matches.push({ session, snippet });
        break; // одна строка на беседу — список читается легче
      }
      if (matches.length >= 30) break;
    }

    searchResults.hidden = false;
    if (matches.length === 0) {
      searchResults.appendChild(h('div', { class: 'chat-search-empty' }, 'Ничего не найдено'));
      return;
    }

    for (const match of matches) {
      searchResults.appendChild(
        h(
          'button',
          {
            class: 'chat-search-item',
            type: 'button',
            onClick: () => {
              const target = match.session;
              activate(target.id);
              requestAnimationFrame(() => {
                const node = [...target.thread.querySelectorAll('.msg')].find((el) =>
                  (el.textContent ?? '').toLowerCase().includes(query),
                );
                node?.scrollIntoView({ block: 'center' });
                node?.classList.add('is-search-hit');
              });
            },
          },
          h('span', { class: 'chat-search-title' }, match.session.title),
          h('span', { class: 'chat-search-snippet' }, match.snippet),
        ),
      );
    }
  }

  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      toggleSearch();
    }
  });

  /**
   * Контекстное меню вкладки беседы: перенос в окно редактора и закрытие.
   * Перенос — не свойство одной беседы, панель переезжает целиком, но открыть
   * меню логично на той вкладке, с которой работаешь.
   */
  function openTabMenu(session: ChatSession, event: MouseEvent): void {
    const inEditor = deps.isInEditor?.() === true;
    showContextMenu(
      [
        {
          label: inEditor ? 'Вернуть в боковую панель' : 'Перенести в окно редактора',
          // Клавиша только открывает: подпись для возврата была бы обманом.
          hint: inEditor ? undefined : 'Ctrl+Alt+E',
          onSelect: () => {
            activate(session.id);
            void deps.commands.execute(inEditor ? 'ai.backToPanel' : 'ai.openInEditor');
          },
        },
        { separator: true },
        {
          label: 'Закрыть беседу',
          danger: true,
          onSelect: () => closeSession(session.id),
        },
      ],
      event.clientX,
      event.clientY,
    );
  }

  function renderTabs(): void {
    clear(tabList);
    for (const session of sessions) {
      const isActive = session.id === activeId;
      const isStreaming = session.id === streamingSession?.id;
      // Классы — как у вкладок редактора: одна полоса, одно поведение, один вид.
      const classes = ['tab', 'chat-tab'];
      if (isActive) classes.push('is-active');
      if (isStreaming) classes.push('is-busy');

      const tab = h(
        'div',
        {
          class: classes.join(' '),
          role: 'tab',
          tabindex: '0',
          'aria-selected': String(isActive),
          title: session.title,
        },
        svgIcon('chat', 13),
        h('span', { class: 'tab-label' }, session.title),
      );

      tab.addEventListener('click', () => activate(session.id));
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openTabMenu(session, event);
      });
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate(session.id);
      });
      // Средняя кнопка мыши закрывает вкладку — так же, как вкладки файлов.
      tab.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeSession(session.id);
      });

      // Крестик есть и у единственной беседы: без него вкладка выглядит
      // незаконченной, а отступы справа и слева расходятся (слева иконка, справа пусто).
      tab.appendChild(
        h(
          'button',
          {
            class: 'tab-close',
            type: 'button',
            title: 'Закрыть беседу',
            onClick: (event) => {
              event.stopPropagation();
              closeSession(session.id);
            },
          },
          svgIcon('close', 11),
        ),
      );

      tabList.appendChild(tab);
    }
  }

  function createSession(uid = newUid()): ChatSession {
    const session: ChatSession = {
      id: nextId,
      uid,
      title: `Беседа ${nextId}`,
      thread: h('div', { class: 'chat-thread' }),
      history: [],
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
    renderAttachments();
    renderChanges();
    renderTabs();
    syncSessionInfo();

    if (busy) input.disabled = true;
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
      renderAttachments();
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

  /* ── сохранение бесед ─────────────────────────────────────────────────────
   * Источник истины — renderer: он собирает ленту и историю. main пишет файл
   * по корню проекта, поэтому при смене папки сначала сохраняется старая, а
   * затем восстанавливается новая. Пишем с задержкой: история меняется пачкой
   * (вопрос → ответ → инструменты), а файл нужен один на всю пачку.
   */

  /** Сериализация беседы: лента DOM и незаписанные правки на диск не уходят. */
  function serializeSession(session: ChatSession): ChatConversation {
    return {
      uid: session.uid,
      title: session.title,
      updatedAt: Date.now(),
      messages: session.history.map((message) => {
        const copy: ChatMessage = { role: message.role, content: message.content };
        if (message.name) copy.name = message.name;
        if (message.toolCallId) copy.toolCallId = message.toolCallId;
        if (message.rating) copy.rating = message.rating;
        if (message.toolCalls?.length) copy.toolCalls = message.toolCalls.map((call) => ({ ...call }));
        return copy;
      }),
      ...(session.usage ? { usage: { ...session.usage } } : {}),
    };
  }

  /** Записать беседы этой папки немедленно: снимок берём синхронно, до отправки. */
  function persistTo(root: string): void {
    const conversations = sessions.map(serializeSession);
    const activeUid = active()?.uid;
    void deps.rpc
      .request('ai.chats.save', { root, conversations, ...(activeUid ? { activeUid } : {}) })
      .catch(() => undefined); // не сохранилось — не повод показывать ошибку в чате
  }

  function scheduleSave(): void {
    if (!chatRoot) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      if (chatRoot) persistTo(chatRoot);
    }, 400);
  }

  /** Обновить вид активной беседы после восстановления вкладок. */
  function syncActiveView(): void {
    const next = active();
    for (const session of sessions) session.thread.hidden = session.id !== next.id;
    input.value = next.draft;
    renderAttachments();
    renderChanges();
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
    if (session.history.length === 0) {
      renderIntro(session);
      return;
    }

    const cards = new Map<string, ToolCardView>();
    const lastIndex = session.history.length - 1;
    session.history.forEach((message, index) => {
      if (message.role === 'user') {
        // Служебный дострой обрезанного ответа — не вопрос человека: в ленте не показываем.
        if (message.content === CONTINUE_PROMPT) return;
        appendMessage(session, 'user', message.content, () => editUserMessage(session, index, message.content));
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
    scrollToEnd(session);
  }

  async function loadChats(root: string): Promise<void> {
    let history: ChatHistory;
    try {
      history = await deps.rpc.request('ai.chats.load', { root });
    } catch {
      return; // история — не то, ради чего стоит ломать открытие проекта
    }
    if (chatRoot !== root) return; // проект сменился, пока грузили

    for (const session of sessions) session.thread.remove();
    sessions.length = 0;
    nextId = 1;

    for (const conversation of history.conversations) {
      const session = createSession(conversation.uid);
      session.title = conversation.title;
      session.history = [...conversation.messages];
      session.usage = conversation.usage;
      renderHistory(session);
    }
    if (sessions.length === 0) createSession();

    const restored = history.activeUid ? sessions.find((item) => item.uid === history.activeUid) : undefined;
    activeId = (restored ?? sessions[0]!).id;
    syncActiveView();
  }

  function initPersistence(): void {
    const applyRoot = (root: string | null): void => {
      if (root === chatRoot) return;
      // Прежняя папка сохраняется до смены chatRoot: сессии ещё её.
      if (chatRoot) persistTo(chatRoot);
      chatRoot = root;
      if (root) void loadChats(root);
    };

    applyRoot(deps.workspace.root);
    if (!chatRoot) {
      // Проект открывается позже (окно IDE стартует после лаунчера): пустая беседа.
      createSession();
      renderTabs();
    }
    // Список путей для `@` собираем заранее: подсказка должна открыться мгновенно.
    void collectMentions();
    deps.workspace.onDidChange((info) => {
      applyRoot(info?.root ?? null);
      void collectMentions();
    });
  }

  /* ── информация о сессии ───────────────────────────────────────────────── */

  const sessionInfo = createSessionInfo({ onCompact: () => void compactActive() });
  /** Кольцо в углу композера показывает то же число, что и окно информации. */
  const contextRing = createUsageRing(() => toggleSessionInfo());

  function sessionInfoData(session: ChatSession = active()): SessionInfoData {
    return {
      provider: currentProvider()?.label ?? 'провайдер не задан',
      model: currentModel(),
      history: session.history,
      attachments: session.attachments,
      systemPrompt: settings.ai.systemPrompt,
      tools: useTools,
      reservedTokens: settings.ai.maxTokens,
      usage: session.usage,
      speed: session.speed,
      contextWindow: settings.ai.contextWindow,
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

  /** Сжать указанную беседу: вернуть true, если резюме получено и история заменена. */
  async function compactSession(session: ChatSession): Promise<boolean> {
    const provider = currentProvider();
    const model = currentModel();
    if (!provider || !model) {
      showToast('Провайдер не настроен', 'error');
      return false;
    }

    const transcript = session.history
      .map((message) => `${message.role}: ${message.content ?? ''}`)
      .join('\n\n')
      .slice(-MAX_COMPACT_CHARS);

    sessionInfo.hide();
    setBusy(true, session);
    try {
      let streamed = '';
      const done = await deps.rpc.stream(
        'ai.chat',
        {
          providerId: provider.id,
          model,
          messages: [{ role: 'user', content: `${COMPACT_PROMPT}\n\n---\n${transcript}` }],
          useTools: false,
        },
        (event, payload) => {
          if (event === ChatStreamEvent.Delta) streamed += (payload as ChatDeltaPayload).text;
        },
      );

      const summary = (done.text || streamed).trim();
      if (!summary) {
        showToast('Модель не вернула резюме', 'error');
        return false;
      }

      const before = session.history.length;
      session.history = [
        { role: 'user', content: `Контекст сжатой беседы:\n\n${summary}` },
        { role: 'assistant', content: 'Принято, продолжаем с этим контекстом.' },
      ];
      session.usage = undefined;
      renderCompacted(session, before, summary);
      showToast(
        `Беседа сжата: ${before} ${plural(before, 'сообщение', 'сообщения', 'сообщений')} → краткое резюме`,
      );
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
   * Перед отправкой сверяемся с окном модели: если запрос плюс зарезервированный
   * ответ не помещаются, сначала сжимаем беседу — иначе провайдер обрежет запрос
   * или вернёт ошибку лимита. Сжимать нечего (короткая история) — просто предупреждаем.
   */
  async function ensureContextFits(session: ChatSession): Promise<void> {
    const usage = contextUsage(sessionInfoData(session));
    if (usage.used + settings.ai.maxTokens <= usage.limit) return;

    if (session.history.length < 2) {
      showToast('Контекст переполнен, но сжимать почти нечего — ответ может обрезаться', 'error');
      return;
    }
    showToast('Контекст переполнен — сжимаю беседу перед отправкой');
    await compactSession(session);
  }

  /** После сжатия в ленте остаётся отметка и само резюме — его стоит видеть. */
  function renderCompacted(session: ChatSession, before: number, summary: string): void {
    clear(session.thread);
    session.thread.appendChild(
      h(
        'details',
        { class: 'thread-summary', open: true },
        h('summary', { class: 'thread-summary-head' }, svgIcon('collapse', 12), `Беседа сжата · было сообщений: ${before}`),
        h('div', { class: 'thread-summary-text' }, summary),
      ),
    );
    if (session.id === activeId) body.scrollTop = 0;
  }

  /** Режим задаёт доступ к инструментам; права на изменения — отдельный тумблер. */
  function syncMode(): void {
    useTools = mode !== 'ask';
    planMode = mode === 'plan';
    modeSelect.setValue(mode);
    // Класс режима красит и селект, и статус одним цветом — см. main.css.
    for (const name of ['ask', 'agent', 'plan'] as const) {
      modeSelect.element.classList.toggle(`is-mode-${name}`, mode === name);
      modeBadge.classList.toggle(`is-mode-${name}`, mode === name);
    }
    // Значок статуса повторяет значок режима: «Вопрос» — реплика, «Агент» — ключ,
    // «План» — чек-лист. Раньше здесь всегда висел предупреждающий треугольник.
    const badgeIcon = mode === 'plan' ? 'checklist' : mode === 'agent' ? 'wrench' : 'bubble';
    clear(modeIcon);
    modeIcon.appendChild(svgIcon(badgeIcon, 12));
    modeName.textContent =
      mode === 'plan'
        ? 'План: только чтение, без изменений'
        : mode === 'agent'
          ? 'Инструменты разрешены'
          : 'Инструменты выключены';
    syncPermButton();
  }

  /** Подпись кнопки модели — «Провайдер - Модель»: где и чем спрашиваем, видно сразу. */
  function syncModelLabel(): void {
    const provider = currentProvider()?.label ?? 'провайдер не задан';
    const label = currentModel() || 'модель не выбрана';
    const text = modelButton.lastElementChild;
    if (text) text.textContent = `${provider} - ${label}`;
    modelButton.title = `${provider} · ${label}\nНажмите, чтобы сменить провайдера, модель или ключ`;
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
    effortSelect.setValue(effort);

    const capabilities = modelCapabilities(currentModel());
    effortSelect.setDisabled(!capabilities.reasoningEffort);
    effortField.title = capabilities.reasoningEffort
      ? 'Усилие размышления: сколько модель думает перед ответом'
      : `Модель не принимает усилие размышления: ${capabilities.note ?? 'параметр не поддерживается'}`;
  }

  async function saveEffort(effort: ReasoningEffort): Promise<void> {
    try {
      settings = await deps.rpc.request('settings.update', { ai: { reasoningEffort: effort } });
      showToast(effort === 'off' ? 'Размышления выключены' : `Усилие размышления: ${effort}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** Отрисовать панель изменений по активной беседе. */
  function renderChanges(): void {
    changesPanel.render(active());
  }

  /**
   * Записать документы на диск. Правки агента ложатся в файл сразу: дерево
   * файлов, git и внешние инструменты работают с диском и без этого не видят
   * изменений. Список правок при этом остаётся — по нему можно откатиться.
   */
  async function persistPaths(paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      const document = deps.documents.get(path);
      if (!document?.dirty) continue;
      try {
        await deps.rpc.request('workspace.writeFile', { path, text: document.value });
        document.markSaved();
      } catch {
        // не записалось — файл останется «грязным», следующая правка повторит
      }
    }
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
        undone > 0 ? `Отменено файловых операций: ${undone}` : skipped > 0 ? 'Удалённые файлы в корзине — верните их вручную' : 'Нечего отменять',
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
      failed > 0 ? 'error' : 'info',
    );
  }

  // Композер и всё, что под лентой. Кнопка «к последнему сообщению» живёт здесь
  // же и позиционируется от футера: иначе фиксированный отступ при высоком
  // поле ввода оставлял бы кнопку поверх него.
  const footer = h(
    'div',
    { class: 'chat-footer' },
    planPanel.element,
    changesPanel.element,
    attachmentChips,
    h(
      'div',
      { class: 'composer-box' },
      input,
      h(
        'div',
        { class: 'composer-toolbar' },
        h(
          'div',
          { class: 'composer-group' },
          contextButton,
          modeSelect.element,
          permButton,
          modelButton,
          effortField,
        ),
        h('div', { class: 'composer-group' }, actionButton),
      ),
      // Информация о сессии — индикатор заполнения контекста в правом нижнем углу:
      // он всегда перед глазами и не занимает места в шапке.
      h('div', { class: 'composer-status' }, modeBadge, contextRing.element, sessionInfo.element),
    ),
    menu.element,
  );
  footer.appendChild(jumpButton);

  const element = h(
    'div',
    { class: 'chat' },
    h(
      'div',
      { class: 'panel-header chat-tabs' },
      tabList,
      h('div', { class: 'panel-actions' }, searchButton, newChatButton),
    ),
    searchBar,
    body,
    footer,
  );

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
    if (path) void attachPath(path);
    else void attachFiles(files);
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
   * Ход беседы: вопрос и все ответы на него. Вопрос внутри хода липнет к верху,
   * пока ход виден, — при прокрутке длинного ответа ясно, на какой запрос он дан.
   * Без обёртки все вопросы прилипали бы к верху разом и наслаивались друг на друга.
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

  function appendMessage(
    session: ChatSession,
    role: 'user' | 'assistant',
    text: string,
    onEdit?: () => void,
  ): HTMLElement {
    const content = h('div', { class: 'msg-body' });
    if (text) markdown.renderInto(content, text);
    const messageEl = h('div', { class: `msg msg-${role}` }, content);
    // Действия есть только у вопросов пользователя — у ответов они рисуются
    // отдельно, когда ответ завершён (см. streamReply / renderHistory).
    if (role === 'user' && onEdit) attachUserActions(messageEl, text, onEdit);
    // Вопрос открывает новый ход, ответ дописывается в текущий.
    (role === 'user' ? beginTurn(session) : currentTurn(session)).appendChild(messageEl);
    scrollToEnd(session);
    return content;
  }

  function scheduleRender(target: HTMLElement, session: ChatSession): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      markdown.renderInto(target, streamBuffer);
      scrollToEnd(session);
    });
  }

  function cancelFrame(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function renderIntro(session: ChatSession): void {
    clear(session.thread);
    session.thread.appendChild(
      h(
        'div',
        { class: 'chat-intro' },
        h('p', {}, 'Ассистент видит рабочую папку и файл, открытый в редакторе.'),
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
    return h(
      'button',
      { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onClick },
      svgIcon(icon, 14),
    );
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
    const actions = h('div', { class: 'msg-actions' }, messageAction('copy', 'Копировать', () => copyText(getText())));
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
    const model = currentModel();
    if (!provider || !model) {
      showToast('Провайдер не настроен', 'error');
      return;
    }

    session.history = session.history.slice(0, lastUser + 1);
    session.usage = undefined;
    session.speed = undefined;
    renderHistory(session);
    await streamReply(session, provider.id, model, []);
  }

  /**
   * Индикатор работы ассистента. Живёт внизу сообщения всю генерацию: пока модель
   * думает или выполняется инструмент, в ленте видно движение — иначе ответ «висит»
   * без единого признака жизни и кажется, что приложение зависло.
   */
  function createActivity(): {
    element: HTMLElement;
    state(label: string): void;
    hide(): void;
    dispose(): void;
  } {
    const label = h('span', { class: 'msg-activity-label' });
    const dots = h('span', { class: 'msg-activity-dots' }, h('i', {}), h('i', {}), h('i', {}));
    const element = h('div', { class: 'msg-activity', hidden: true }, dots, label);
    return {
      element,
      state(text: string) {
        label.textContent = text;
        element.hidden = false;
      },
      hide() {
        element.hidden = true;
      },
      dispose() {
        element.remove();
      },
    };
  }

  async function send(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || busy) return;

    const session = active();
    const provider = currentProvider();
    if (!provider) {
      showToast('Провайдер не настроен', 'error');
      return;
    }

    const model = currentModel();
    if (!model) {
      showToast('Укажите модель в настройках', 'error');
      return;
    }

    // Не влезает в окно — сначала освобождаем контекст, потом спрашиваем.
    await ensureContextFits(session);

    input.value = '';
    session.draft = '';
    menu.hide();
    // Контекст приложен к конкретному вопросу: дальше он только мешает.
    const sent = [...session.attachments];
    session.attachments = [];
    renderAttachments();

    session.history.push({ role: 'user', content: text });
    if (session.history.length === 1) {
      // Первый вопрос убирает приветствие: беседа началась, подсказка больше не нужна.
      clear(session.thread);
      syncTabTitle(session, text);
    }
    const index = session.history.length - 1;
    appendMessage(session, 'user', text, () => editUserMessage(session, index, text));

    // Новый вопрос — снова следим за низом ленты.
    autoScroll = true;
    jumpButton.hidden = true;

    await streamReply(session, provider.id, model, sent);
  }

  /**
   * Стриминг ответа в ленту беседы. Отделено от `send`, потому что «Повторить»
   * и «Продолжить» переиспользуют тот же путь, не добавляя новый вопрос.
   */
  async function streamReply(
    session: ChatSession,
    providerId: string,
    model: string,
    attachments: ChatAttachment[],
  ): Promise<void> {
    // Ответ ассистента — это последовательность «текст → карточка инструмента →
    // текст», поэтому внутри одного сообщения живёт несколько текстовых сегментов.
    const messageEl = h('div', { class: 'msg msg-assistant' });
    currentTurn(session).appendChild(messageEl);
    let segment = h('div', { class: 'msg-body' });
    messageEl.appendChild(segment);
    // Индикатор работы держим внизу сообщения: новые сегменты вставляем перед ним.
    const activity = createActivity();
    messageEl.appendChild(activity.element);
    activity.state('думает…');
    // Подряд идущие вызовы инструментов живут одной группой — см. createToolFeed.
    const tools = createToolFeed(messageEl, activity.element, () => scrollToEnd(session));
    /** Размышления текущего шага: строка живёт в той же ленте, что и вызовы. */
    let reasoningView: ReasoningRowView | null = null;
    const toolCards = new Map<string, ToolCardView>();
    /** Размышления: строка живёт в ленте действий — заводим её лениво. */
    const pushReasoning = (text: string): void => {
      (reasoningView ??= tools.reasoning()).push(text);
    };
    /** Ответ начался или закончился — сворачиваем строку размышлений. */
    const collapseReasoning = (): void => {
      reasoningView?.collapse();
      reasoningView = null;
    };
    /** Замер скорости ответа: от первого текстового фрагмента до конца потока. */
    let firstDeltaAt = 0;
    let lastDeltaAt = 0;

    streamBuffer = '';
    planPanel.hide();
    scrollToEnd(session);
    streamingSession = session;

    const flushSegment = (): void => {
      cancelFrame();
      markdown.renderInto(segment, streamBuffer);
    };

    setBusy(true, session);

    let continues = 0;
    let done: ChatStreamDone;

    try {
      for (;;) {
        done = await deps.rpc.stream(
          'ai.chat',
          {
            providerId,
            model,
            messages: session.history.map((message) => ({ ...message })),
            useTools,
            autoApprove,
            planMode,
            attachments,
          },
          (event, payload) => {
            if (event === ChatStreamEvent.Reasoning) {
              pushReasoning((payload as ChatReasoningPayload).text);
              activity.state('размышляет…');
              return;
            }
            if (event === ChatStreamEvent.Plan) {
              planPanel.render((payload as ChatPlanPayload).steps);
              activity.state('строит план…');
              return;
            }
            if (event === ChatStreamEvent.Delta) {
              cancelFrame();
              collapseReasoning();
              activity.hide();
              // Пошёл текст ответа — цепочка вызовов закончилась.
              tools.seal();
              const now = performance.now();
              if (firstDeltaAt === 0) firstDeltaAt = now;
              lastDeltaAt = now;
              streamBuffer += (payload as ChatDeltaPayload).text;
              scheduleRender(segment, session);
              return;
            }
            if (event === ChatStreamEvent.ToolStart) {
              const call = payload as ChatToolStartPayload;
              flushSegment();
              // Текст, после которого пошёл вызов инструмента, — промежуточный:
              // показываем пузырём, чтобы он не сливался со строками действий.
              segment.classList.add('msg-note');
              // Новый вызов — новый текстовый сегмент. Буфер держит текст ТОЛЬКО
              // текущего шага: иначе в следующий сегмент выльется весь предыдущий
              // текст и ответ будет повторяться в каждом пузыре.
              streamBuffer = '';
              // Размышления пошаговые: закрываем текущую часть, следующая врезка
              // ляжет отдельным абзацем в ту же строку ленты.
              reasoningView?.part();
              toolCards.set(call.id, tools.add(call));
              activity.state(`выполняю: ${toolLabel(call.name)}`);
              segment = h('div', { class: 'msg-body' });
              messageEl.insertBefore(segment, activity.element);
              scrollToEnd(session);
              return;
            }
            if (event === ChatStreamEvent.ToolResult) {
              const result = payload as ChatToolResultPayload;
              toolCards.get(result.id)?.finish(result);
              activity.state('думает…');
              // Создание, удаление и перенос не идут через документы: панель
              // изменений узнаёт о них из результата инструмента.
              if (result.ok && result.changes?.length) {
                for (const change of result.changes) {
                  const at = session.files.findIndex((item) => item.path === change.path);
                  if (at >= 0) session.files[at] = change;
                  else session.files.push(change);
                }
                renderChanges();
              }
            }
          },
        );

        flushSegment();
        collapseReasoning();
        tools.seal();
        session.history.push(...(done.agentMessages ?? [{ role: 'assistant', content: done.text }]));
        session.usage = done.usage;

        // Скорость ответа: токены / время потока. Без обоих чисел не показываем.
        const completion = done.usage?.completionTokens;
        session.speed =
          completion !== undefined && firstDeltaAt > 0 && lastDeltaAt > firstDeltaAt
            ? completion / ((lastDeltaAt - firstDeltaAt) / 1000)
            : undefined;

        // Обрезано по лимиту — достраиваем сами, пока есть бюджет продолжений.
        if (done.finishReason !== 'length' || continues >= MAX_AUTO_CONTINUE) break;

        continues += 1;
        messageEl.insertBefore(
          h(
            'div',
            { class: 'finish-note is-continue' },
            svgIcon('refresh', 12),
            h('span', {}, `Продолжаю ответ · ${continues}/${MAX_AUTO_CONTINUE}`),
          ),
          activity.element,
        );
        session.history.push({ role: 'user', content: CONTINUE_PROMPT });
        // Продолжение — часть ТОГО ЖЕ ответа: новый сегмент в том же пузыре.
        segment = h('div', { class: 'msg-body' });
        messageEl.insertBefore(segment, activity.element);
        streamBuffer = '';
        scrollToEnd(session);
      }

      // Дошли до предела продолжений, а ответ всё обрезан — оставляем ручную кнопку.
      if (done.finishReason === 'length') {
        messageEl.insertBefore(
          h(
            'div',
            { class: 'finish-note' },
            svgIcon('warning', 12),
            h('span', {}, 'Ответ обрезан по лимиту токенов'),
            h(
              'button',
              {
                class: 'link-btn',
                type: 'button',
                onClick: () => void send('Продолжи ответ с того места, где остановился.'),
              },
              'Продолжить',
            ),
          ),
          activity.element,
        );
      }

      attachAssistantActions(messageEl, () => assistantText(messageEl), () => void regenerate(session), feedbackFor(session, session.history.length - 1));
      scrollToEnd(session);
    } catch (error) {
      flushSegment();
      tools.seal();
      closeApprovals();
      if (error instanceof RpcError && error.cancelled) {
        segment.appendChild(h('div', { class: 'field-hint' }, 'генерация остановлена'));
        session.history.push({ role: 'assistant', content: streamBuffer });
      } else {
        clear(segment);
        segment.appendChild(h('p', { class: 'msg-error' }, error instanceof Error ? error.message : String(error)));
        showToast('Не удалось получить ответ модели', 'error');
      }
    } finally {
      planPanel.hide();
      activity.dispose();
      streamingSession = null;
      setBusy(false, session);
      // Правки уже на диске: их записал applyAgentEdits сразу после применения.
      // Здесь остаётся только подстраховка — добить то, что не записалось.
      if (session.touched.size > 0) await persistPaths(session.touched.keys());
      renderTabs();
      syncSessionInfo();
      scheduleSave();
      void deps.rpc
        .request('settings.update', { ai: { activeProviderId: providerId, activeModel: model } })
        .catch(() => undefined);
    }
  }

  function setBusy(value: boolean, session: ChatSession = active()): void {
    busy = value;
    if (session.id === activeId) input.disabled = value;
    syncActionButton();
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
    renderAttachments();
    renderChanges();
    renderTabs();
    sessionInfo.hide();
    scheduleSave();
    requestAnimationFrame(() => {
      body.scrollTop = 0;
      input.focus();
    });
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


  deps.host.handle('ai.confirmCommand', async (params) => ({
    allowed: await commandApproval.confirm(params.command),
  }));

  deps.host.handle('ai.applyEdits', async (params) => applyAgentEdits(params));

  // Пометки языка живут в Monaco, поэтому их отдаёт renderer.
  deps.host.handle('ai.getDiagnostics', async (params) => ({ items: deps.editors.markers(params.path) }));

  // Показать файл в редакторе: открытие вкладки и позиция курсора — дело renderer.
  deps.host.handle('ai.openFile', async (params) => {
    deps.editors.reveal(params.path, params.line ?? 1, params.column ?? 1);
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
    // Сразу на диск, в любом режиме: правки должны быть видны дереву файлов, git
    // и внешним инструментам, а не ждать ручного «Сохранить».
    await persistPaths(result.reports.map((report) => report.path));

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

    return { rejected: false, result };
  }

  /** Разбор ответа в узлы: движок markdown живёт в отдельном модуле. */
  const markdown = createMarkdownRenderer({ insertCode: (code) => deps.editors.insertAtCursor(code) });

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
  initPersistence();
  syncProviderFields();
  syncMode();
  syncEffort();
  syncActionButton();
  renderAttachments();
  renderChanges();

  /**
   * Мастер-выключатель из настроек: AI выключен — панель не работает. Гасим и
   * заодно останавливаем текущую генерацию, чтобы запрос не продолжал жечь токены
   * после того, как пользователь снял галочку.
   */
  function syncAiAvailability(): void {
    const enabled = settings.ai.enabled;
    element.classList.toggle('is-ai-disabled', !enabled);
    // Останавливаем только идущую генерацию: иначе stop() сообщит «ничего не генерируется».
    if (!enabled && busy) stop();
  }

  syncAiAvailability();

  return {
    element,
    newChat,
    stop,
    askAboutSelection,
    applySettings(next: Settings) {
      settings = next;
      syncProviderFields();
      syncEffort();
      // Размер контекстного окна тоже в настройках: кольцо должно пересчитаться
      // сразу, а не после следующего ответа модели.
      syncSessionInfo();
      syncAiAvailability();
    },
  };
}

/* Карточки вызовов инструментов и лента действий живут в `chat-tools.ts`. */
