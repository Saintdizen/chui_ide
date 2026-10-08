import {
  ChatStreamEvent,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BYTES,
  type ApplyEditsHostParams,
  type ApplyEditsHostResult,
  type ChatAttachment,
  type ChatDeltaPayload,
  type ChatMessage,
  type ChatReasoningPayload,
  type ChatToolResultPayload,
  type ChatToolStartPayload,
  type ChatUsage,
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
import { RpcError, type RpcClient } from '../core/rpc';
import { highlightInto } from '../core/highlight';
import { type Child, type IconName, basename, clear, h, svgIcon } from './dom';
import { createSelect } from './select';
import { createSessionInfo, createUsageRing, contextUsage, type SessionInfoData } from './session-info';
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

/** Режим работы панели: спросить, поработать с подтверждениями или на автопилоте. */
type ChatMode = 'ask' | 'agent' | 'autopilot';

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
 * Панель ассистента — правый «остров» в стиле tool window.
 *
 * Агентного цикла здесь пока нет: канал для него готов (`rpc.stream` +
 * `RpcClient.cancelActive`), а описания инструментов лежат в shared/tools.ts.
 */
export function createChatPanel(deps: ChatDeps): ChatView {
  let settings = deps.settings;
  let busy = false;
  /** Режим панели: ответ на вопрос, агент с подтверждениями или автопилот. */
  let mode: ChatMode = 'ask';
  let useTools = false;
  let autoApprove = false;
  let streamBuffer = '';
  let frame = 0;
  /** Ожидания решений пользователя (ревью правок, подтверждение команды). */
  const pendingApprovals = new Set<() => void>();

  /**
   * Беседа. Вкладок может быть много, поэтому всё, что относится к диалогу —
   * история, ленты сообщений, правки и приложенный контекст, — живёт здесь,
   * а не в переменных панели: иначе вторая вкладка затирала бы первую.
   */
  interface ChatSession {
    id: number;
    title: string;
    /** Лента сообщений: своя у каждой беседы, при переключении не перерисовывается. */
    thread: HTMLElement;
    history: ChatMessage[];
    /** Файлы, которые агент изменил именно в этой беседе. */
    touched: Map<string, { original: string; added: number; removed: number }>;
    attachments: ChatAttachment[];
    /** Недописанный вопрос: вернулся на вкладку — текст на месте. */
    draft: string;
    /** Последний ответ: реальный размер контекста, каким его увидел провайдер. */
    usage?: ChatUsage;
  }

  const sessions: ChatSession[] = [];
  let activeId = 0;
  let nextId = 1;
  /** Беседа, которая сейчас генерирует: хостовые вызовы приходят именно от неё. */
  let streamingSession: ChatSession | null = null;

  const active = (): ChatSession => sessions.find((session) => session.id === activeId) ?? sessions[0]!;

  const body = h('div', { class: 'chat-body' });
  const input = h('textarea', {
    class: 'chat-input',
    rows: 3,
    placeholder: 'Спросите о коде. «/» — команды, «#» — приложить контекст (Enter — отправить)',
    spellcheck: false,
  });

  /* ── композер: панель изменений, чипы, тулбар, статус ──────────────────── */

  const changesSummary = h('span', { class: 'changes-summary' });
  const changesStat = h('span', { class: 'changes-stat' });
  const changesFiles = h('div', { class: 'changes-files', hidden: true });
  /** Список файлов раскрыт по умолчанию: он и есть содержимое панели. */
  let changesExpanded = true;

  const changesToggle = h(
    'button',
    { class: 'changes-toggle', type: 'button', 'aria-expanded': 'true' },
    svgIcon('chevronDown', 12),
    changesSummary,
    changesStat,
  );

  /** Панель изменений целиком: шапка-переключатель, действия и список файлов. */
  const changesBar = h(
    'div',
    { class: 'composer-changes is-open', hidden: true },
    changesToggle,
    h(
      'div',
      { class: 'changes-actions' },
      h('button', { class: 'btn btn-small btn-primary', type: 'button', onClick: () => void saveTouched() }, 'Сохранить'),
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => void revertTouched() }, 'Отменить'),
    ),
    changesFiles,
  );

  function syncChangesPanel(): void {
    changesFiles.hidden = !changesExpanded;
    changesBar.classList.toggle('is-open', changesExpanded);
    changesToggle.setAttribute('aria-expanded', String(changesExpanded));
    changesToggle.title = changesExpanded ? 'Скрыть список файлов' : 'Показать список файлов';
  }

  changesToggle.addEventListener('click', () => {
    changesExpanded = !changesExpanded;
    syncChangesPanel();
  });

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

  /** Размер по-человечески: «2.4 МБ» вместо «2516582». */
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  }

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

  /* ── меню композера: слэш-команды и контекст ───────────────────────────── */

  interface ComposerItem {
    title: string;
    hint: string;
    run(): void;
  }

  /** Слэш-команды: подставляют готовый запрос и сами прикладывают контекст. */
  const SLASH_COMMANDS: ReadonlyArray<{ id: string; title: string; hint: string; prompt: string }> = [
    {
      id: '/explain',
      title: 'Объяснить код',
      hint: 'Разобрать выделение или текущий файл',
      prompt: 'Объясни этот код: что он делает, как устроен и на что обратить внимание.',
    },
    {
      id: '/fix',
      title: 'Исправить ошибку',
      hint: 'Найти причину и предложить правку',
      prompt: 'Найди причину ошибок в этом коде и предложи минимальную правку.',
    },
    {
      id: '/tests',
      title: 'Написать тесты',
      hint: 'Покрыть выделение или файл тестами',
      prompt: 'Напиши тесты для этого кода. Покрой граничные случаи и объясни, что проверяешь.',
    },
    {
      id: '/doc',
      title: 'Добавить документацию',
      hint: 'Комментарии и docstring',
      prompt: 'Добавь документацию к этому коду: назначение, параметры, возвращаемое значение.',
    },
  ];

  const CONTEXT_COMMANDS: ReadonlyArray<{ id: string; title: string; hint: string; kind: 'selection' | 'file' | 'problems' }> = [
    { id: '#selection', title: 'Выделение', hint: 'Фрагмент из редактора', kind: 'selection' },
    { id: '#file', title: 'Открытый файл', hint: 'Содержимое целиком', kind: 'file' },
    { id: '#problems', title: 'Ошибки и предупреждения', hint: 'То, что подчёркивает редактор', kind: 'problems' },
  ];

  const menu = h('div', { class: 'composer-menu', hidden: true });
  let menuItems: ComposerItem[] = [];
  let menuIndex = 0;

  /** Кнопка «+» открывает тот же список контекста: так его видно и без `#`. */
  const contextButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Приложить контекст', onClick: () => toggleContextMenu() },
    svgIcon('plus', 14),
  );

  function toggleContextMenu(): void {
    if (!menu.hidden) {
      hideMenu();
      return;
    }
    showMenu([
      ...CONTEXT_COMMANDS.map((item) => ({
        title: item.title,
        hint: item.hint,
        run: () => {
          addAttachment(attachmentFrom(item.kind));
          input.focus();
        },
      })),
      {
        title: 'Изображение из файла…',
        hint: 'PNG, JPEG, WebP, GIF — или Ctrl+V из буфера',
        run: () => void attachImagesFromDialog(),
      },
    ]);
  }

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
    if (menu.hidden) return;
    const node = event.target as Node;
    if (menu.contains(node) || input.contains(node) || contextButton.contains(node)) return;
    hideMenu();
  });

  function renderMenu(): void {
    clear(menu);
    menuItems.forEach((item, index) => {
      menu.appendChild(
        h(
          'button',
          {
            class: `composer-menu-item${index === menuIndex ? ' is-cursor' : ''}`,
            type: 'button',
            onClick: () => pickMenuItem(index),
          },
          h('span', { class: 'composer-menu-title' }, item.title),
          h('span', { class: 'composer-menu-hint' }, item.hint),
        ),
      );
    });
  }

  function showMenu(items: ComposerItem[]): void {
    menuItems = items;
    menuIndex = 0;
    if (items.length === 0) {
      hideMenu();
      return;
    }
    renderMenu();
    menu.hidden = false;
  }

  function hideMenu(): void {
    menu.hidden = true;
    menuItems = [];
    menuIndex = 0;
  }

  function pickMenuItem(index: number): void {
    const item = menuItems[index];
    hideMenu();
    item?.run();
  }

  /** `#` в конце слова открывает список контекста, `/` в начале — список команд. */
  function syncMenu(): void {
    const value = input.value;

    if (value.startsWith('/')) {
      const query = value.slice(1).toLowerCase();
      showMenu(
        SLASH_COMMANDS.filter((item) => item.id.slice(1).startsWith(query)).map((item) => ({
          title: `${item.id} — ${item.title}`,
          hint: item.hint,
          run: () => {
            input.value = item.prompt;
            attachBest();
            syncMenu();
            input.focus();
          },
        })),
      );
      return;
    }

    const hash = value.lastIndexOf('#');
    if (hash >= 0 && /(^|\s)#[\w-]*$/.test(value)) {
      const query = value.slice(hash + 1).toLowerCase();
      showMenu(
        CONTEXT_COMMANDS.filter((item) => item.id.slice(1).startsWith(query)).map((item) => ({
          title: `${item.id} — ${item.title}`,
          hint: item.hint,
          run: () => {
            // Убираем набранный `#…`, он был только способом открыть список.
            input.value = `${value.slice(0, hash).trimEnd()} `.trimStart();
            addAttachment(attachmentFrom(item.kind));
            input.focus();
          },
        })),
      );
      return;
    }

    hideMenu();
  }

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
      'Вопрос — просто ответ. Агент — сам читает проект, правит файлы и запускает команды, но каждое действие подтверждаете вы. ' +
      'Автопилот — делает то же без вопросов (необратимые команды всё равно спросит).',
  });
  modeSelect.setOptions([
    { value: 'ask', label: 'Вопрос' },
    { value: 'agent', label: 'Агент' },
    { value: 'autopilot', label: 'Автопилот' },
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

  const modeName = h('span', {}, '');
  const modeBadge = h('span', { class: 'composer-status-item' }, svgIcon('warning', 12), modeName);

  /* ── беседы: вкладки в стиле вкладок редактора ───────────────────── */

  const tabList = h('div', { class: 'tabs chat-tab-list' });
  const newChatButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Новая беседа', onClick: () => newChat() },
    svgIcon('plus', 15),
  );

  /** Заголовок вкладки — по первому вопросу: в списке видно, о чём беседа. */
  function titleFrom(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return 'Новая беседа';
    return flat.length > 24 ? `${flat.slice(0, 23)}…` : flat;
  }

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

  function createSession(): ChatSession {
    const session: ChatSession = {
      id: nextId,
      title: `Беседа ${nextId}`,
      thread: h('div', { class: 'chat-thread' }),
      history: [],
      touched: new Map(),
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
    hideMenu();
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
  }

  function syncTabTitle(session: ChatSession, text: string): void {
    session.title = titleFrom(text);
    renderTabs();
  }

  /* ── информация о сессии ───────────────────────────────────────────────── */

  const sessionInfo = createSessionInfo({ onCompact: () => void compactActive() });
  /** Кольцо в углу композера показывает то же число, что и окно информации. */
  const contextRing = createUsageRing(() => toggleSessionInfo());

  function sessionInfoData(): SessionInfoData {
    const session = active();
    return {
      provider: currentProvider()?.label ?? 'провайдер не задан',
      model: currentModel(),
      history: session.history,
      attachments: session.attachments,
      systemPrompt: settings.ai.systemPrompt,
      tools: useTools,
      reservedTokens: settings.ai.maxTokens,
      usage: session.usage,
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

  /** Резюме заменяет историю: беседа продолжается с освобождённым контекстом. */
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

    const provider = currentProvider();
    const model = currentModel();
    if (!provider || !model) {
      showToast('Провайдер не настроен', 'error');
      return;
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
        return;
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
    } catch (error) {
      if (error instanceof RpcError && error.cancelled) showToast('Сжатие отменено');
      else showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false, session);
      renderTabs();
      syncSessionInfo();
    }
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

  /** Режим — это и есть тумблер инструментов и подтверждений. */
  function syncMode(): void {
    useTools = mode !== 'ask';
    autoApprove = mode === 'autopilot';
    modeSelect.setValue(mode);
    modeSelect.element.classList.toggle('composer-select-active', mode !== 'ask');
    modeSelect.element.classList.toggle('composer-select-auto', mode === 'autopilot');
    modeBadge.classList.toggle('composer-status-warn', mode !== 'ask');
    modeBadge.classList.toggle('composer-status-auto', mode === 'autopilot');
    modeName.textContent =
      mode === 'autopilot'
        ? 'Автопилот: правки без подтверждения'
        : mode === 'agent'
          ? 'Инструменты разрешены'
          : 'Инструменты выключены';
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

  function renderChanges(): void {
    const touched = active().touched;
    if (touched.size === 0) {
      changesBar.hidden = true;
      changesFiles.hidden = true;
      clear(changesFiles);
      return;
    }

    let added = 0;
    let removed = 0;
    for (const entry of touched.values()) {
      added += entry.added;
      removed += entry.removed;
    }

    changesBar.hidden = false;
    changesSummary.textContent = `Изменён ${touched.size} ${fileWord(touched.size)}`;
    // Знак и число красятся по смыслу: плюсы — зелёные, минусы — красные.
    changesStat.replaceChildren(
      h('span', { class: 'stat-add' }, `+${added}`),
      h('span', { class: 'stat-del' }, `−${removed}`),
    );

    clear(changesFiles);
    for (const [target, entry] of touched) {
      changesFiles.appendChild(
        h(
          'button',
          { class: 'chip', type: 'button', title: target, onClick: () => deps.editors.reveal(target, 1, 1) },
          svgIcon('file', 12),
          h('span', { class: 'chip-name' }, basename(target)),
          h(
            'span',
            { class: 'chip-stat' },
            h('span', { class: 'stat-add' }, `+${entry.added}`),
            h('span', { class: 'stat-del' }, `−${entry.removed}`),
          ),
        ),
      );
    }

    syncChangesPanel();
  }

  /** «Сохранить» завершает сессию правок: файлы уходят на диск. */
  async function saveTouched(): Promise<void> {
    const touched = active().touched;
    let saved = 0;
    for (const target of touched.keys()) {
      const document = deps.documents.get(target);
      if (!document?.dirty) continue;
      try {
        await deps.rpc.request('workspace.writeFile', { path: target, text: document.value });
        document.markSaved();
        saved += 1;
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    touched.clear();
    renderChanges();
    showToast(saved > 0 ? `Сохранено файлов: ${saved}` : 'Нечего сохранять');
  }

  /** «Отменить» возвращает документы к тому, какими они были до правок агента. */
  async function revertTouched(): Promise<void> {
    const touched = active().touched;
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
    renderChanges();

    if (fileEdits.length === 0) {
      showToast('Нечего отменять');
      return;
    }

    const result = await deps.edits.applyFileEdits(fileEdits, 'programmatic');
    showToast(
      result.failed.length > 0 ? `Не удалось отменить файлов: ${result.failed.length}` : 'Правки агента отменены',
      result.failed.length > 0 ? 'error' : 'info',
    );
  }

  const element = h(
    'div',
    { class: 'chat' },
    h(
      'div',
      { class: 'panel-header chat-tabs' },
      tabList,
      h('div', { class: 'panel-actions' }, newChatButton),
    ),
    body,
    h(
      'div',
      { class: 'chat-footer' },
      changesBar,
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
            modelButton,
            effortField,
          ),
          h('div', { class: 'composer-group' }, actionButton),
        ),
        // Информация о сессии — индикатор заполнения контекста в правом нижнем углу:
        // он всегда перед глазами и не занимает места в шапке.
        h('div', { class: 'composer-status' }, modeBadge, contextRing.element),
      ),
      sessionInfo.element,
      menu,
    ),
  );

  // Перетаскивание изображения на панель чата — тот же путь, что вставка из буфера.
  // Слушатели на корне: файл можно бросить в любое место панели, не только в поле.
  element.addEventListener('dragover', (event) => {
    const items = [...(event.dataTransfer?.items ?? [])];
    if (!items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return;
    event.preventDefault();
    element.classList.add('is-dropping');
  });
  element.addEventListener('dragleave', (event) => {
    // Событие приходит и при переходе между детьми — снимаем подсветку только
    // когда курсор ушёл с самой панели.
    if (event.target === element) element.classList.remove('is-dropping');
  });
  element.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.some((file) => file.type.startsWith('image/'))) return;
    event.preventDefault();
    element.classList.remove('is-dropping');
    void attachFiles(files);
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

  function scrollToEnd(session: ChatSession = active()): void {
    // Фоновая беседа может генерировать, но прокручивать чужую ленту нельзя:
    // полоса прокрутки у панели одна, и она принадлежит активной вкладке.
    if (session.id !== activeId) return;
    body.scrollTop = body.scrollHeight;
  }

  function appendMessage(session: ChatSession, role: 'user' | 'assistant', text: string): HTMLElement {
    const content = h('div', { class: 'msg-body' });
    if (text) renderInto(content, text);
    session.thread.appendChild(h('div', { class: `msg msg-${role}` }, content));
    scrollToEnd(session);
    return content;
  }

  function scheduleRender(target: HTMLElement, session: ChatSession): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderInto(target, streamBuffer);
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

    input.value = '';
    session.draft = '';
    hideMenu();
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
    appendMessage(session, 'user', text);

    // Ответ ассистента — это последовательность «текст → карточка инструмента →
    // текст», поэтому внутри одного сообщения живёт несколько текстовых сегментов.
    const messageEl = h('div', { class: 'msg msg-assistant' });
    session.thread.appendChild(messageEl);
    let segment = h('div', { class: 'msg-body' }, h('span', { class: 'typing' }, 'думает…'));
    messageEl.appendChild(segment);
    // Подряд идущие вызовы инструментов живут одной группой — см. createToolFeed.
    const tools = createToolFeed(messageEl);
    const toolCards = new Map<string, ToolCardView>();
    let reasoningBuffer = '';
    let reasoningBox: HTMLElement | null = null;
    let reasoningFrame = 0;

    streamBuffer = '';
    scrollToEnd(session);
    streamingSession = session;

    const flushSegment = (): void => {
      cancelFrame();
      renderInto(segment, streamBuffer);
    };

    /** Размышления — сворачиваемый блок перед ответом, как у reasoning-моделей. */
    const pushReasoning = (chunk: string): void => {
      reasoningBuffer += chunk;

      if (!reasoningBox) {
        reasoningBox = h(
          'details',
          { class: 'reasoning', open: true },
          h('summary', { class: 'reasoning-summary' }, 'Размышления'),
          h('div', { class: 'reasoning-text' }),
        );
        messageEl.insertBefore(reasoningBox, segment);
      }

      if (reasoningFrame) return;
      reasoningFrame = requestAnimationFrame(() => {
        reasoningFrame = 0;
        const target = reasoningBox?.querySelector('.reasoning-text');
        if (target) target.textContent = reasoningBuffer;
        scrollToEnd(session);
      });
    };

    /** Ответ начался или закончился — размышления убираем под спойлер. */
    const collapseReasoning = (): void => {
      if (reasoningFrame) cancelAnimationFrame(reasoningFrame);
      reasoningFrame = 0;
      if (!reasoningBox) return;
      const target = reasoningBox.querySelector('.reasoning-text');
      if (target) target.textContent = reasoningBuffer;
      reasoningBox.removeAttribute('open');
    };

    setBusy(true, session);

    try {
      const done = await deps.rpc.stream(
        'ai.chat',
        {
          providerId: provider.id,
          model,
          messages: session.history.map((message) => ({ ...message })),
          useTools,
          autoApprove,
          attachments: sent,
        },
        (event, payload) => {
          if (event === ChatStreamEvent.Reasoning) {
            pushReasoning((payload as ChatReasoningPayload).text);
            return;
          }
          if (event === ChatStreamEvent.Delta) {
            cancelFrame();
            collapseReasoning();
            // Пошёл текст ответа — цепочка вызовов закончилась.
            tools.seal();
            streamBuffer += (payload as ChatDeltaPayload).text;
            scheduleRender(segment, session);
            return;
          }
          if (event === ChatStreamEvent.ToolStart) {
            const call = payload as ChatToolStartPayload;
            flushSegment();
            toolCards.set(call.id, tools.add(call));
            segment = h('div', { class: 'msg-body' });
            messageEl.appendChild(segment);
            scrollToEnd(session);
            return;
          }
          if (event === ChatStreamEvent.ToolResult) {
            const result = payload as ChatToolResultPayload;
            toolCards.get(result.id)?.finish(result);
          }
        },
      );

      flushSegment();
      collapseReasoning();
      tools.seal();
      session.history.push(...(done.agentMessages ?? [{ role: 'assistant', content: done.text }]));
      session.usage = done.usage;
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
      streamingSession = null;
      setBusy(false, session);
      renderTabs();
      syncSessionInfo();
      void deps.rpc
        .request('settings.update', { ai: { activeProviderId: provider.id, activeModel: model } })
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

  function previewFile(file: FileEdit, text: string | null): EditPreviewFile {
    if (text === null) return { path: file.path, error: 'не удалось прочитать файл', hunks: [] };

    const lines = text.split('\n');
    const hunks = file.edits.slice(0, MAX_REVIEW_HUNKS).map((edit) => ({
      label:
        edit.startLine === edit.endLine
          ? `строка ${edit.startLine}`
          : `строки ${edit.startLine}–${edit.endLine}`,
      removed: lines.slice(edit.startLine - 1, edit.endLine).slice(0, MAX_REVIEW_LINES),
      added:
        edit.newText.length === 0
          ? []
          : edit.newText.replace(/\n$/, '').split('\n').slice(0, MAX_REVIEW_LINES),
    }));

    return { path: file.path, hunks, extra: file.edits.length - hunks.length };
  }

  /**
   * Показывает предложенные правки и ждёт решения пользователя.
   * Ничего не применяет — это делает вызывающий уже после согласия.
   */
  async function reviewEdits(fileEdits: readonly FileEdit[]): Promise<boolean> {
    const files = await Promise.all(
      fileEdits.map(async (file) => previewFile(file, await currentText(file.path))),
    );

    const block = h('div', { class: 'review' });
    block.appendChild(
      h(
        'div',
        { class: 'review-head' },
        svgIcon('wrench', 13),
        h('span', { class: 'review-title' }, `Ассистент предлагает правки · ${files.length} ${fileWord(files.length)}`),
      ),
    );

    for (const file of files) {
      const section = h('div', { class: 'review-file' }, h('div', { class: 'review-path' }, file.path));
      if (file.error) section.appendChild(h('div', { class: 'review-error' }, file.error));
      for (const hunk of file.hunks) {
        const group = h('div', { class: 'review-hunk' }, h('div', { class: 'review-range' }, hunk.label));
        for (const line of hunk.removed) group.appendChild(h('div', { class: 'review-del' }, `- ${line}`));
        for (const line of hunk.added) group.appendChild(h('div', { class: 'review-add' }, `+ ${line}`));
        section.appendChild(group);
      }
      if (file.extra) section.appendChild(h('div', { class: 'review-error' }, `… и ещё правок: ${file.extra}`));
      block.appendChild(section);
    }

    const status = h('span', { class: 'review-status' });
    let settle: (approved: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    /** Решение принято — разбор правок больше не нужен: остаётся строка итога. */
    function finish(approved: boolean, note: string): void {
      pendingApprovals.delete(abort);
      block.classList.toggle('review-rejected', !approved);
      block.classList.add('decision-done');
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('wrench', 12),
          h(
            'span',
            {},
            approved ? `Правки применены · ${files.length} ${fileWord(files.length)}` : 'Правки отклонены',
          ),
          note ? h('span', { class: 'decision-status' }, note) : null,
        ),
      );
      settle(approved);
    }

    const applyButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true, '') },
      'Применить',
    );
    const rejectButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false, '') },
      'Отклонить',
    );
    // Вызов агента прервали — ревью больше некому ответить, закрываем его.
    const abort = (): void => finish(false, 'отменено');

    block.appendChild(h('div', { class: 'review-actions' }, applyButton, rejectButton, status));
    (streamingSession ?? active()).thread.appendChild(block);
    scrollToEnd();

    pendingApprovals.add(abort);
    return decision;
  }

  /**
   * Подтверждение запуска команды. Опасное действие показываем в самой ленте:
   * пользователь видит команду ровно там, где о ней попросил агент.
   */
  async function confirmCommand(command: string): Promise<boolean> {
    const block = h('div', { class: 'approval' });
    block.appendChild(
      h(
        'div',
        { class: 'approval-head' },
        svgIcon('warning', 13),
        h('span', {}, 'Ассистент просит выполнить команду'),
      ),
    );
    block.appendChild(h('pre', { class: 'approval-command' }, command));
    block.appendChild(h('div', { class: 'field-hint' }, 'Команда выполнится в папке проекта от вашего имени.'));

    const status = h('span', { class: 'approval-status' });
    let settle: (allowed: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    /** Решение принято — команда и подсказка больше не нужны: остаётся строка статуса. */
    function finish(allowed: boolean, note: string): void {
      pendingApprovals.delete(abort);
      block.classList.add('decision-done');
      block.replaceChildren(
        h(
          'div',
          { class: 'decision-line' },
          svgIcon('terminal', 12),
          h('span', {}, 'Выполняется скрипт'),
          h('span', { class: 'decision-status' }, note),
        ),
      );
      block.scrollIntoView({ block: 'nearest' });
      settle(allowed);
    }

    const runButton = h(
      'button',
      { class: 'btn btn-small btn-primary', type: 'button', onClick: () => finish(true, 'разрешено') },
      'Выполнить',
    );
    const skipButton = h(
      'button',
      { class: 'btn btn-small', type: 'button', onClick: () => finish(false, 'отменено') },
      'Отменить',
    );
    const abort = (): void => finish(false, 'отменено');

    block.appendChild(h('div', { class: 'approval-actions' }, runButton, skipButton, status));
    (streamingSession ?? active()).thread.appendChild(block);
    scrollToEnd();

    pendingApprovals.add(abort);
    return decision;
  }

  deps.host.handle('ai.confirmCommand', async (params) => ({
    allowed: await confirmCommand(params.command),
  }));

  deps.host.handle('ai.applyEdits', async (params) => applyAgentEdits(params));

  // Пометки языка живут в Monaco, поэтому их отдаёт renderer.
  deps.host.handle('ai.getDiagnostics', async (params) => ({ items: deps.editors.markers(params.path) }));

  /**
   * Правки агента: в автопилоте применяем сразу, иначе сперва показываем ревью.
   * Запись в историю и панель изменений — в обоих случаях: пользователь должен
   * видеть, что агент сделал, даже когда не спрашивал.
   */
  async function applyAgentEdits(params: ApplyEditsHostParams): Promise<ApplyEditsHostResult> {
    const approved = params.autoApprove === true || (await reviewEdits(params.edits));
    if (!approved) return { rejected: true };

    // Вызов пришёл из конкретной беседы: правки принадлежат ей, даже если
    // пользователь успел переключить вкладку.
    const session = streamingSession ?? active();

    // Текст до правок нужен панели «Изменён N файл»: по нему работает «Отменить».
    const before = new Map<string, string>();
    for (const file of params.edits) {
      const text = await currentText(file.path);
      if (text !== null) before.set(file.path, text);
    }

    const result = await deps.edits.applyFileEdits(params.edits, 'programmatic');

    for (const report of result.reports) {
      const { added, removed } = countLines(params.edits, report.path);
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

  /**
   * Компактный markdown: заголовки, списки, цитаты, блоки кода и инлайн-разметка.
   * Никакого innerHTML — узлы создаются напрямую, поэтому ответ модели
   * не может вставить разметку в интерфейс.
   */
  function renderInto(container: HTMLElement, text: string): void {
    clear(container);
    if (!text) return;
    for (const node of markdownBlocks(text)) container.appendChild(node);
  }

  function markdownBlocks(text: string): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const lines = text.split('\n');
    let index = 0;

    while (index < lines.length) {
      const line = lines[index] ?? '';

      // Блок кода: ``` с необязательным языком.
      if (line.trimStart().startsWith('```')) {
        const language = line.trim().slice(3).trim();
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
          body.push(lines[index] ?? '');
          index += 1;
        }
        index += 1;
        nodes.push(codeBlock(body.join('\n'), language));
        continue;
      }

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        nodes.push(h('div', { class: `md-heading md-h${heading[1]!.length}` }, ...inlineMarkdown(heading[2] ?? '')));
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const body: string[] = [];
        while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
          body.push((lines[index] ?? '').replace(/^>\s?/, ''));
          index += 1;
        }
        nodes.push(h('blockquote', { class: 'md-quote' }, ...inlineMarkdown(body.join(' '))));
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        const list = h(bullet ? 'ul' : 'ol', { class: 'md-list' });
        while (index < lines.length) {
          const match = (bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/).exec(lines[index] ?? '');
          if (!match) break;
          list.appendChild(h('li', {}, ...inlineMarkdown(match[1] ?? '')));
          index += 1;
        }
        nodes.push(list);
        continue;
      }

      // Абзац: строки до пустой. Перенос внутри абзаца — мягкий, как в markdown.
      const paragraph: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (!next.trim() || /^(#{1,4}\s|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(next) || next.trimStart().startsWith('```')) break;
        paragraph.push(next.trim());
        index += 1;
      }
      if (paragraph.length > 0) nodes.push(h('p', { class: 'md-p' }, ...inlineMarkdown(paragraph.join(' '))));
      else index += 1;
    }

    return nodes;
  }

  /** Инлайн-разметка: `код`, **жирный** и ссылки в виде текста с подсказкой. */
  function inlineMarkdown(text: string): Child[] {
    const nodes: Child[] = [];
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;

    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (start > last) nodes.push(text.slice(last, start));

      const token = match[0];
      if (token.startsWith('`')) {
        nodes.push(h('code', { class: 'md-code' }, token.slice(1, -1)));
      } else if (token.startsWith('**')) {
        nodes.push(h('strong', {}, token.slice(2, -2)));
      } else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        if (link) nodes.push(h('span', { class: 'md-link', title: link[2] ?? '' }, link[1] ?? ''));
      }

      last = start + token.length;
    }

    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  /** Блок кода с действиями: без них ответ переносят руками. */
  function codeBlock(code: string, language: string): HTMLElement {
    const bar = h(
      'div',
      { class: 'code-bar' },
      h('span', { class: 'code-lang' }, language || 'text'),
      h(
        'button',
        {
          class: 'link-btn code-action',
          type: 'button',
          onClick: () => {
            void navigator.clipboard.writeText(code).then(
              () => showToast('Скопировано'),
              () => showToast('Не удалось скопировать', 'error'),
            );
          },
        },
        'Копировать',
      ),
      h(
        'button',
        {
          class: 'link-btn code-action',
          type: 'button',
          onClick: () => {
            if (deps.editors.insertAtCursor(code)) showToast('Вставлено в позицию курсора');
            else showToast('Нет открытого редактора', 'error');
          },
        },
        'Вставить',
      ),
    );

    return h('div', { class: 'code-block' }, bar, h('pre', {}, codeNode(code, language)));
  }

  /** Блок кода: текст сразу, цвета — как отдаст Monaco. */
  function codeNode(code: string, language: string): HTMLElement {
    const node = h('code', {});
    highlightInto(node, code, language);
    return node;
  }

  input.addEventListener('input', syncMenu);

  input.addEventListener('keydown', (event) => {
    // Пока открыт список — стрелки, Enter и Esc принадлежат ему, а не отправке.
    if (!menu.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        menuIndex = (menuIndex + step + menuItems.length) % menuItems.length;
        renderMenu();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideMenu();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        pickMenuItem(menuIndex);
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void send(input.value);
  });

  // Первая беседа создаётся до отрисовки композера: чипы и панель изменений
  // читают состояние активной беседы, и без неё им нечего показывать.
  createSession();
  renderTabs();
  syncProviderFields();
  syncMode();
  syncEffort();
  syncActionButton();
  renderAttachments();
  renderChanges();

  return {
    element,
    newChat,
    stop,
    askAboutSelection,
    applySettings(next: Settings) {
      settings = next;
      syncProviderFields();
      syncEffort();
    },
  };
}

/* ── карточки вызовов инструментов ──────────────────────────────────────── */

const TOOL_LABELS: Record<string, string> = {
  list_dir: 'Просмотр папки',
  read_file: 'Чтение файла',
  search: 'Поиск по проекту',
  get_diagnostics: 'Диагностика',
  apply_edit: 'Правка файлов',
  run_terminal: 'Команда в терминале',
};

/** У инструмента свой значок: строка читается без чтения подписи. */
const TOOL_ICONS: Record<string, IconName> = {
  list_dir: 'folder',
  read_file: 'file',
  search: 'search',
  get_diagnostics: 'warning',
  apply_edit: 'wrench',
  run_terminal: 'terminal',
};

/** Ограничения показа: ревью — не редактор, длинные пачки правок ему не нужны. */
const MAX_REVIEW_HUNKS = 20;
const MAX_REVIEW_LINES = 20;

interface EditPreviewFile {
  path: string;
  error?: string;
  hunks: Array<{ label: string; removed: string[]; added: string[] }>;
  /** Сколько правок не поместилось в предпросмотр. */
  extra?: number;
}

/** Русская форма слова для числа: `plural(2, 'файл', 'файла', 'файлов')`. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Русская форма слова «файл» для числа. */
function fileWord(count: number): string {
  return plural(count, 'файл', 'файла', 'файлов');
}

/** Сколько строк добавила и убрала пачка правок — для сводки «+53 −4». */
function countLines(edits: readonly FileEdit[], target: string): { added: number; removed: number } {
  const file = edits.find((item) => item.path === target);
  if (!file) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  for (const edit of file.edits) {
    removed += Math.max(edit.endLine - edit.startLine + 1, 0);
    added += edit.newText.length === 0 ? 0 : edit.newText.replace(/\n$/, '').split('\n').length;
  }
  return { added, removed };
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function toolIcon(name: string): IconName {
  return TOOL_ICONS[name] ?? 'wrench';
}

/** Аргументы вызова в одну строку: путь, запрос, маска. */
function summarizeArgs(raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof value.path === 'string') parts.push(value.path);
    if (typeof value.query === 'string') parts.push(`«${value.query}»`);
    if (typeof value.glob === 'string') parts.push(value.glob);
    if (typeof value.command === 'string') parts.push(value.command);
    // apply_edit: в карточке нужны имена файлов, а не сырой JSON на 80 символов.
    if (Array.isArray(value.edits)) {
      for (const file of value.edits) {
        if (file && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') {
          parts.push(basename((file as { path: string }).path));
        }
      }
    }
    if (parts.length === 0) parts.push(raw.trim().slice(0, 80));
    return parts.join(' · ');
  } catch {
    return raw.trim().slice(0, 80);
  }
}

/** Строка вызова инструмента и её обновление — в одном месте. */
interface ToolCardView {
  card: HTMLElement;
  finish(result: ChatToolResultPayload): void;
}

/**
 * Язык для подсветки вывода инструмента. Вывод — это код: содержимое файла
 * или команда, и он заслуживает той же подсветки, что блоки в ответе.
 */
function toolDetailLanguage(call: ChatToolStartPayload): string {
  if (call.name === 'run_terminal') return 'shell';
  if (call.name !== 'read_file' && call.name !== 'list_dir') return '';
  try {
    const args = JSON.parse(call.args) as { path?: unknown };
    return typeof args.path === 'string' ? languageFromPath(args.path) : '';
  } catch {
    return ''; // аргументы не разобрались — покажем текстом, это не ошибка
  }
}

/** Состояние строки вызова: пока идёт — «выполняется…», потом итог. */
function toolStateElement(): HTMLElement {
  return h('span', { class: 'tool-state' }, 'выполняется…');
}

function setToolState(element: HTMLElement, ok: boolean): void {
  element.textContent = ok ? 'готово' : 'ошибка';
  element.classList.toggle('is-fail', !ok);
}

/** Одна группа вызовов: шапка со сводкой и строки под раскрытием. */
interface ToolGroupView {
  add(call: ChatToolStartPayload): ToolCardView;
  seal(): void;
}

function createToolGroup(container: HTMLElement): ToolGroupView {
  let count = 0;
  let pending = 0;
  let failed = 0;
  /** Раскрыта ли группа руками: тогда автоматика её не сворачивает. */
  let pinned = false;
  let expanded = true;
  const names: string[] = [];

  const title = h('span', { class: 'tool-group-title' }, 'Действия');
  const tools = h('span', { class: 'tool-group-tools' });
  const state = h('span', { class: 'tool-group-state' }, 'выполняется…');
  const body = h('div', { class: 'tool-group-body' });
  const chevron = svgIcon('chevronDown', 12);
  chevron.classList.add('tool-chevron');

  const applyExpanded = (): void => {
    body.hidden = !expanded;
    root.classList.toggle('is-open', expanded);
  };

  const head = h(
    'button',
    {
      class: 'tool-group-head',
      type: 'button',
      'aria-expanded': 'true',
      onClick: () => {
        expanded = !expanded;
        pinned = true;
        head.setAttribute('aria-expanded', String(expanded));
        applyExpanded();
      },
    },
    svgIcon('wrench', 13),
    title,
    tools,
    state,
    chevron,
  );

  const root = h('div', { class: 'tool-group is-open' }, head, body);
  container.appendChild(root);

  const sync = (): void => {
    title.textContent = `Действия · ${count}`;
    const brief = names.slice(0, 2).join(', ');
    tools.textContent = names.length > 2 ? `${brief} и ещё ${names.length - 2}` : brief;

    if (pending > 0) {
      state.textContent = 'выполняется…';
      state.className = 'tool-group-state';
      return;
    }

    state.textContent = failed > 0 ? `ошибок: ${failed}` : 'готово';
    state.className = `tool-group-state${failed > 0 ? ' is-fail' : ' is-ok'}`;
    // Работа закончилась — держать список перед глазами больше незачем.
    if (!pinned) {
      expanded = false;
      applyExpanded();
    }
  };

  const add = (call: ChatToolStartPayload): ToolCardView => {
    count += 1;
    pending += 1;
    const label = toolLabel(call.name);
    if (!names.includes(label)) names.push(label);

    const cardState = toolStateElement();
    const panel = h('div', { class: 'tool-panel', hidden: true });
    const card = h('div', { class: 'tool-card' });
    const rowChevron = svgIcon('chevronDown', 12);
    rowChevron.classList.add('tool-chevron');

    let outcome: ChatToolResultPayload | null = null;
    const detailLanguage = toolDetailLanguage(call);

    /** Подробности собираем по первому запросу: до ответа инструмента их нет. */
    const togglePanel = (): void => {
      if (!outcome) return;
      if (panel.childElementCount === 0) {
        panel.appendChild(h('div', { class: 'tool-summary' }, outcome.summary));
        if (outcome.detail) {
          const raw = h('code', {});
          highlightInto(raw, outcome.detail, detailLanguage);
          panel.appendChild(h('pre', { class: 'tool-raw' }, raw));
        }
      }
      panel.hidden = !panel.hidden;
      card.classList.toggle('is-open', !panel.hidden);
    };

    card.append(
      h(
        'button',
        {
          class: 'tool-head',
          type: 'button',
          title: `${label} — показать вывод`,
          onClick: togglePanel,
        },
        svgIcon(toolIcon(call.name), 13),
        h('span', { class: 'tool-name' }, label),
        h('span', { class: 'tool-args' }, summarizeArgs(call.args)),
        cardState,
        rowChevron,
      ),
      panel,
    );
    body.appendChild(card);
    sync();

    return {
      card,
      finish: (result) => {
        outcome = result;
        setToolState(cardState, result.ok);
        card.classList.toggle('tool-failed', !result.ok);
        pending -= 1;
        if (!result.ok) failed += 1;
        sync();
      },
    };
  };

  /**
   * Закрываем группу: дальше идёт текст ответа или новый вопрос.
   * Одиночный вызов группы не требует — он остаётся обычной строкой.
   * Сама группа при этом жива: её шапка по-прежнему раскрывает строки.
   */
  const seal = (): void => {
    if (count === 1) {
      const solo = body.firstElementChild as HTMLElement | null;
      if (solo) root.replaceWith(solo);
      return;
    }
    if (pending === 0 && !pinned) {
      expanded = false;
      applyExpanded();
    }
  };

  return { add, seal };
}

/**
 * Лента вызовов инструментов.
 *
 * Агент за один шаг читает десяток файлов, и строка на каждый вызов
 * превращает чат в свалку. Поэтому подряд идущие вызовы собираются в одну
 * группу: в ленте остаётся её шапка («Действия · 6 · Просмотр папки,
 * Чтение файла · готово»), а сами строки — под раскрытием.
 */
function createToolFeed(container: HTMLElement): {
  add(call: ChatToolStartPayload): ToolCardView;
  seal(): void;
} {
  let current: ToolGroupView | null = null;

  return {
    add: (call) => {
      current ??= createToolGroup(container);
      return current.add(call);
    },
    seal: () => {
      current?.seal();
      current = null;
    },
  };
}
