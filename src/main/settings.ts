import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  RpcErrorCode,
  type AiInlineCompletionSettings,
  type AiTelemetrySettings,
  type AiSettingsPatch,
  type AppearanceSettings,
  type EditorSettings,
  type ExplorerSettings,
  type GitSettings,
  type LayoutSettings,
  type LspSettings,
  type ReasoningEffort,
  type RunSettings,
  type Settings,
  type SettingsPatch,
  type WorkspaceSettings,
} from '../shared/api';
import { AUTO_SAVE_DELAY_MS, normalizeAutoSaveDelay, normalizeAutoSaveMode } from '../shared/auto-save';
import { COMPACT_AT_TOKENS, COMPACT_EVERY_TURNS } from '../shared/context-fit';
import { normalizeFavorites } from '../shared/favorites';
import { parseFsAddress, formatFsAddress } from '../shared/fs-address';
import { normalizeMcpServers, type McpServerConfig } from '../shared/mcp';
import { DEFAULT_SANDBOX, sanitizeSandbox, type AiSandboxSettings } from '../shared/sandbox';
import { normalizeSnippets } from '../shared/snippets';
import { normalizeRulers } from '../shared/rulers';
import { normalizeCursorStyle, normalizeLineHeight } from '../shared/cursor-style';
import { normalizeWhitespaceMode } from '../shared/whitespace';
import { normalizeSpellWords } from '../shared/spellcheck';
import { DEFAULT_TOOL_PRESET, sanitizeToolPreset, type ToolPresetId } from '../shared/tool-presets';
import { normalizePullMode } from '../shared/git-pull';
import { normalizeRootOverrides } from '../shared/explorer-settings';
import { sanitizeBadgeRules } from '../shared/icon-badges';
import { DEFAULT_GIT_SETTINGS, sanitizeGitSettings } from '../shared/git-settings';
import { normalizeKeybindingOverrides, type KeybindingSettings } from '../shared/keybindings';
import { sanitizeThemeFile, type ThemeFile } from '../shared/theme-file';
import { sanitizeUiScale } from '../shared/ui-scale';
import { isWebSearchProvider, type WebSearchProvider } from '../shared/web-search';
import { CredentialsStore, credentialsPathFor, takeKeys } from './credentials';
import { RpcFailure } from './ipc/router';

interface StoredProvider {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  /** Как говорить с провайдером: OpenAI-совместимо или нативно (Anthropic). */
  protocol?: 'openai' | 'anthropic';
  /**
   * Параметры запроса — свои у каждого подключения: лимит ответа, температура и
   * усилие размышления зависят от модели, а не от ассистента целиком. Не заданы —
   * берётся общее значение из настроек, поэтому старый конфиг работает как раньше.
   */
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /**
   * Метка конечного пользователя для провайдера (`user_id` у DeepSeek).
   *
   * Нужна для изоляции: кеш контекста и лимиты считаются отдельно по каждому
   * `user_id`, и двое за одной машиной иначе делят их между собой.
   */
  userId?: string;
  /**
   * Строгая схема инструментов (`strict: true`): провайдер обязан вернуть
   * аргументы по JSON-схеме. У DeepSeek это beta-функция, требующая `/beta`.
   */
  strictTools?: boolean;
  /** Ключ лежит только в main-процессе и никогда не уходит в renderer. */
  apiKey?: string;
}

interface StoredSettings {
  ai: {
    /** Общий выключатель ассистента: `false` — AI выключен целиком. */
    enabled: boolean;
    providers: StoredProvider[];
    activeProviderId?: string;
    activeModel?: string;
    temperature: number;
    maxTokens: number;
    /** Не задано — окно определяется по имени модели. */
    contextWindow?: number;
    /** Абсолютный предел истории для автосжатия; 0 — не сжимать по объёму. */
    compactAtTokens: number;
    /** «Сжимать чаще»: каждые N ходов; 0 — по промаху кеша и по окну. */
    compactEveryTurns: number;
    /** Модель для сжатия беседы; не задана — активная. */
    compactModel?: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    /** Страховка от зацикливания: шагов «модель → инструмент → модель» в обычном режиме. */
    maxSteps: number;
    /** То же при полном доступе. */
    maxAutopilotSteps: number;
    /** Набор инструментов агента: что предлагать модели в каждом запросе. */
    toolPreset: ToolPresetId;
    /** Страховка полного доступа: спрашивать перед необратимыми командами. */
    confirmDangerous: boolean;
    /** Проверять безобидные команды моделью, не спрашивая человека. */
    approvalReview: boolean;
    /** Модель для проверки; не задана — активная. */
    reviewModel?: string;
    /** Убирать шум из вывода инструментов перед отправкой модели. */
    compressOutput: boolean;
    /**
     * Чтение страниц по ссылке (`web`, действие fetch): тоже ход наружу, поэтому тоже
     * выключено, пока человек не включит его сам.
     */
    webFetch: { enabled: boolean };
    /** Веб-поиск ассистента: выключен, пока человек не включит его сам. */
    webSearch: {
      enabled: boolean;
      provider: WebSearchProvider;
      /** Пусто — адрес по умолчанию для выбранного вида поиска. */
      endpoint: string;
      apiKey?: string;
    };
    /** Браузерная автоматизация: свой Chromium под управлением агента. */
    browser: {
      enabled: boolean;
      /** Путь к браузеру; пусто — ищем известные имена в PATH. */
      executable: string;
      headless: boolean;
      /** Работать во встроенном браузере (вкладка в IDE), а не отдельным Chromium. */
      integrated: boolean;
    };
    /** Песочница: команды агента выполняются в контейнере. */
    sandbox: AiSandboxSettings;
    /** Серверы внешних инструментов (MCP): их процессы запускает IDE. */
    mcpServers: McpServerConfig[];
    /** Inline-автодополнение: выключено, пока человек не включит его сам. */
    inlineCompletion: AiInlineCompletionSettings;
    /** Журнал прогонов в файл: выключен, пока человек не включит его сам. */
    telemetry: AiTelemetrySettings;
  };
  editor: EditorSettings;
  explorer: ExplorerSettings;
  run: RunSettings;
  appearance: AppearanceSettings;
  workspace: WorkspaceSettings;
  layout: LayoutSettings;
  lsp: LspSettings;
  git: GitSettings;
  keybindings: KeybindingSettings;
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты — ассистент chui_iDE: кратко, правка — минимальный диф, API не выдумывай.';

// Прежние встроенные тексты: их надо переписать на актуальный.
const LEGACY_SYSTEM_PROMPTS: readonly string[] = [
  'Ты — встроенный ассистент chui_iDE.\nОтвечай кратко и по делу. Когда предлагаешь правку — давай минимальный диф, а не файл целиком.\nНе выдумывай API: если не уверен в сигнатуре, попроси показать нужный файл.',
];

const DEFAULT_SETTINGS: StoredSettings = {
  ai: {
    // Ассистент включён по умолчанию: это часть IDE, выключается осознанно.
    enabled: true,
    providers: [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        models: ['deepseek-flash', 'deepseek-v4-pro'],
        defaultModel: 'deepseek-flash',
      },
    ],
    temperature: 0.2,
    // 0 — предел модели (см. `maxOutputTokens`). Общие 4096 токенов обрывали ответ
    // там, где модель готова писать в сотню раз больше: предел ответа — свойство
    // модели, а не ассистента.
    maxTokens: 0,
    // Предел автосжатия выключен: пороги — промах кеша и подход к окну.
    compactAtTokens: COMPACT_AT_TOKENS,
    compactEveryTurns: COMPACT_EVERY_TURNS,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // По умолчанию параметр не отправляем: не всякая модель его знает.
    reasoningEffort: 'off',
    // Страховка от бесконечного цикла «модель → инструмент → модель».
    maxSteps: 8,
    // При полном доступе задача длиннее: шагов нужно больше.
    maxAutopilotSteps: 24,
    // Набор инструментов — «Авто»: правки, чтение и проверки сразу, остальное
    // подключается вызовом по имени. Полный набор — одной строкой в композере.
    toolPreset: DEFAULT_TOOL_PRESET,
    // Полный доступ по умолчанию не напролом: перед необратимыми командами
    // (sudo, rm, git push --force) спрашиваем, пока человек сам не отключит
    // страховку. Лишний вопрос дешевле одного пропущенного `rm -rf`.
    confirmDangerous: true,
    // Проверка команд моделью выключена: она тратит токены и решает за человека.
    // Включается осознанно — тем, кто устал подтверждать `ls` и `git status`.
    approvalReview: false,
    // Сжатие включено: оно снимает оформление, а не содержание.
    compressOutput: true,
    // Веб-поиск выключен: агент не должен ходить в интернет без явного согласия.
    webSearch: { enabled: false, provider: 'searxng', endpoint: '' },
    // Чтение страниц по ссылке — тот же ход наружу, значит тоже только осознанно.
    webFetch: { enabled: false },
    // Браузер выключен: агент ходил бы по чужим страницам и нажимал там кнопки.
    // Включается осознанно — вместе с ним включаются и подтверждения действий.
    browser: { enabled: false, executable: '', headless: true, integrated: true },
    // Песочница выключена: команды агента идут на хосте, как раньше. Включив её,
    // человек сам выбирает образ — в нём должны быть инструменты проекта.
    sandbox: { ...DEFAULT_SANDBOX },
    // Серверов MCP по умолчанию нет: их команды задаёт человек.
    mcpServers: [],
    // Автодополнение выключено: каждый запрос — это обращение к модели (время и
    // деньги) на каждую паузу в наборе. Включается осознанно.
    inlineCompletion: { enabled: false, debounceMs: 350 },
    // Журнал прогонов выключен: в записи лежат инструкции и ответы модели.
    telemetry: { enabled: false },
  },
  editor: {
    tabSize: 4,
    fontSize: 14,
    // Высота строки по шрифту: редактор считает её от кегля (1.4). Число здесь —
    // для тех, кому нужнее плотный или просторный текст.
    lineHeight: 0,
    // Каретка — привычная тонкая полоска, и она мигает: так видно, что фокус в редакторе.
    cursorStyle: 'line',
    cursorBlink: true,
    insertSpaces: true,
    // Python и Makefile требуют разного отступа: пусть язык решает сам.
    languageIndent: true,
    // Форматирование при сохранении по умолчанию выключено: правка пробелов
    // на каждое сохранение — заметное вмешательство, включается осознанно.
    formatOnSave: false,
    // Подрезка хвостов и завершающий перевод тоже выключены: это правка файла,
    // которую человек не просил, — включается осознанно, как и форматирование.
    trimTrailingWhitespace: false,
    insertFinalNewline: false,
    // Направляющие по умолчанию — привычные 80 и 120 столбцов: это ориентир длины
    // строки, а не украшение; список пуст — черт нет.
    rulers: [80, 120],
    // Невидимые знаки по умолчанию скрыты: точки и стрелки в коде мешают читать.
    renderWhitespace: 'none',
    // Миникарта по умолчанию выключена: узкий файл она только заслоняет.
    minimap: false,
    // Перенос длинных строк выключен: по умолчанию строку не ломают, её тянут вбок.
    wordWrap: false,
    // Плавная прокрутка включена: дальний прыжок так читается, а быстрый набор она не
    // задевает (плавными едут только прыжки, а не каждое движение курсора).
    smoothScroll: true,
    // Vim-режим выключен: это выбор человека, а не поведение по умолчанию.
    vimMode: false,
    // Emacs-режим тоже выключен: это выбор человека, а не поведение по умолчанию.
    emacsMode: false,
    // Лигатуры выключены: не всякий шрифт их умеет, и не всем они нравятся.
    fontLigatures: false,
    // Своих сниппетов по умолчанию нет: набор, что знает редактор, живёт в коде
    // (`shared/snippets.ts`), а здесь — только добавленное человеком.
    snippets: [],
    // Emmet включён: это привычное поведение для правки разметки и стилей (так и в
    // других редакторах), а выключить его можно всегда.
    emmet: true,
    // Форматирование при вставке выключено: это правка вставленного текста, и включать
    // её стоит осознанно — не всякий сервер умеет, а вид кода меняется заметно.
    formatOnPaste: false,
    // Проверка орфографии выключена: она пачкает текст волнистыми подчёркиваниями,
    // а словарь нужен из системы — включается осознанно.
    spellcheck: false,
    // Своих слов у человека нет: словарь берётся из системы (см. `spell.dictionary`).
    spellWords: [],
    // Автосохранение выключено: файл пишет человек, а не таймер, пока он не попросит.
    autoSave: 'off',
    autoSaveDelayMs: AUTO_SAVE_DELAY_MS,
  },
  explorer: {
    icons: true,
    // Скрытые файлы видны: в Node-проектах половина настроек — точечные файлы.
    showHidden: true,
    foldersFirst: true,
    sort: 'name',
    indent: 12,
    rowDensity: 'normal',
    gitDecorations: true,
    folderChangeDot: true,
    // Свежесть правки показываем: это подсказка, куда вернуться, и она тихая.
    recentChanges: true,
    // Окно — сутки: за это время успеваешь и отвлечься, и вернуться.
    recentWindowHours: 24,
    // Игнорируемое приглушаем: это подсказка, а не запрет — файл остаётся виден.
    dimIgnored: true,
    // Привычное поведение: двойной клик открывает, одинарный — выделяет.
    openOnSingleClick: false,
    confirmDelete: true,
    exclude: [],
    // Вложение выключено по умолчанию: это заметно меняет вид дерева, и включать
    // его стоит осознанно. Своих правил нет — возьмутся из `core/file-nesting.ts`.
    fileNesting: false,
    nestingRules: [],
    // Импорты правим при переименовании по умолчанию: без этого код перестаёт
    // собираться, а правку видно и её можно отменить.
    updateImportsOnRename: true,
    // Группировка по назначению выключена: она сильно меняет вид дерева,
    // и включать её стоит осознанно (как и вложение).
    groupByType: false,
    // Пакеты монорепо выключены: в обычном проекте группировать нечего, а в монорепо
    // это осознанный выбор (как и прочие режимы вида дерева).
    groupByPackage: false,
    // Своих настроек у папок нет: пока человек не откроет «Настройки папки», все
    // корни области живут по общим значениям.
    byRoot: {},
    // Сторонних значков нет: набор приносит человек (файлом или правкой настроек).
    badges: [],
  },
  run: {
    // Пусто: сначала ищем окружение проекта, потом `python3` из PATH.
    pythonPath: '',
    packageManager: 'auto',
    saveBeforeRun: true,
    pythonByRoot: {},
  },
  appearance: {
    // Масштаб 1 — оболочка как задумана; крупнее/плотнее человек выбирает сам.
    uiScale: 1,
    // Встроенная палитра: тему из файла человек приносит сам.
    customTheme: null,
  },
  workspace: {
    // История открытых папок живёт в настройках, а не в renderer: её показывает
    // стартовое окно, а оно — отдельный процесс со своим хранилищем.
    recent: [],
    // «Избранное» по умолчанию пусто: список наполняет человек.
    favorites: [],
    // Удалённых папок нет: схему подключает человек, зная, что ssh/wsl стоит.
    remoteRoots: [],
  },
  // Размеры и видимость панелей — рабочее место человека, общее для всех проектов.
  // Значения совпадают с CSS-переменными по умолчанию и сбросом сплиттеров.
  layout: {
    sidebarSize: 260,
    rightSize: 500,
    dockSize: 260,
    sidebarVisible: true,
    rightVisible: true,
    dockVisible: false,
  },
  lsp: {
    // По умолчанию ВКЛЮЧЕНО: часть серверов едет вместе с IDE (см.
    // `shared/lsp-bundled.ts`) и подставляется сама, поэтому подсказки и переходы
    // работают сразу после установки. Ничего в обход настройки не запускается:
    // выключение явным `false` уважаем, а PATH-серверы по-прежнему только
    // подставляются, но не ставятся.
    enabled: true,
    // Журнал обмена — по умолчанию выключен: он писал бы файл на каждый запрос.
    trace: false,
    servers: [],
  },
  // Git: значения по умолчанию и разбор — в `shared/git-settings.ts` (под тестами).
  git: { ...DEFAULT_GIT_SETTINGS },
  // Сочетаний по умолчанию тут нет: они живут в коде (`renderer/core/default-keybindings.ts`).
  // Здесь — только то, что человек поменял сам.
  keybindings: { overrides: [] },
};

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

/**
 * Настройки приложения: JSON рядом с пользовательскими данными Electron.
 * Renderer получает только представление без секретов (`hasApiKey`), а сам ключ
 * подставляется в заголовок запроса здесь, в main-процессе.
 */
export class SettingsStore {
  private readonly filePath: string;
  /**
   * Секреты (ключи провайдеров и поиска) лежат отдельно от настроек:
   * `credentials.json` рядом, права 0600. В `settings.json` их больше нет.
   */
  private readonly credentials: CredentialsStore;
  private data: StoredSettings;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath('userData'), 'settings.json');
    this.credentials = new CredentialsStore(credentialsPathFor(this.filePath));
    this.data = loadSettings(this.filePath);
    // Перенос из прежней версии: ключи лежали в `ai.providers[].apiKey` и в
    // `ai.webSearch.apiKey`. Забираем их в отдельный файл и убираем из настроек —
    // иначе бэкап настроек продолжит возить пароли.
    this.migrateSecrets();
  }

  file(): string {
    return this.filePath;
  }

  onDidChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(): Settings {
    const { ai, editor, explorer, run } = this.data;
    return {
      ai: {
        enabled: ai.enabled !== false,
        providers: ai.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          baseUrl: provider.baseUrl,
          models: [...provider.models],
          defaultModel: provider.defaultModel,
          protocol: provider.protocol,
          temperature: provider.temperature,
          maxTokens: provider.maxTokens,
          reasoningEffort: provider.reasoningEffort,
          userId: provider.userId,
          strictTools: provider.strictTools === true,
          hasApiKey: Boolean(this.resolveApiKey(provider.id)),
        })),
        activeProviderId: ai.activeProviderId ?? ai.providers[0]?.id,
        activeModel: ai.activeModel,
        temperature: ai.temperature,
        maxTokens: ai.maxTokens,
        contextWindow: ai.contextWindow,
        compactAtTokens: ai.compactAtTokens,
        compactEveryTurns: ai.compactEveryTurns,
        compactModel: ai.compactModel,
        systemPrompt: ai.systemPrompt,
        reasoningEffort: ai.reasoningEffort ?? 'off',
        maxSteps: ai.maxSteps,
        maxAutopilotSteps: ai.maxAutopilotSteps,
        toolPreset: sanitizeToolPreset(ai.toolPreset),
        confirmDangerous: ai.confirmDangerous,
        approvalReview: ai.approvalReview === true,
        reviewModel: ai.reviewModel,
        compressOutput: ai.compressOutput !== false,
        telemetry: { enabled: ai.telemetry?.enabled === true },
        webFetch: { enabled: ai.webFetch?.enabled === true },
        webSearch: {
          enabled: ai.webSearch?.enabled === true,
          provider: ai.webSearch?.provider ?? 'searxng',
          endpoint: ai.webSearch?.endpoint ?? '',
          // Поиск DeepSeek обходится ключом подключения: показывать «ключа нет»,
          // когда поиск при этом работает, — врать в настройках.
          hasApiKey:
            Boolean(this.resolveWebSearchKey()) ||
            (ai.webSearch?.provider === 'deepseek' && Boolean(this.resolveApiKey('deepseek'))),
        },
        browser: {
          enabled: ai.browser?.enabled === true,
          executable: ai.browser?.executable ?? '',
          // Без окна по умолчанию: браузер заводят ради автоматизации, а не ради
          // того, чтобы он всплывал поверх редактора.
          headless: ai.browser?.headless !== false,
          // Встроенный — по умолчанию: человек видит, что делает агент.
          integrated: ai.browser?.integrated !== false,
        },
        // Копия: правка настроек не должна менять уже отданный снимок.
        sandbox: { ...sanitizeSandbox(ai.sandbox) },
        // Копия, а не ссылка: правка настроек не должна менять уже отданный снимок.
        mcpServers: ai.mcpServers.map((server) => ({
          ...server,
          args: [...server.args],
          ...(server.env ? { env: { ...server.env } } : {}),
        })),
        // Копия: снимок настроек не должен меняться вслед за правкой.
        inlineCompletion: { ...ai.inlineCompletion },
      },
      // Копии вложенных списков: снимок настроек не должен меняться вслед за правкой.
      editor: {
        ...editor,
        snippets: editor.snippets.map((snippet) => ({ ...snippet })),
        spellWords: [...editor.spellWords],
      },
      explorer: { ...explorer, exclude: [...explorer.exclude] },
      run: { ...run },
      // Тема из файла — вложенный объект: отдаём копию, чтобы правка снимка не
      // меняла уже сохранённые настройки.
      appearance: {
        ...this.data.appearance,
        customTheme: cloneThemeFile(this.data.appearance.customTheme),
      },
      workspace: {
        recent: [...this.data.workspace.recent],
        favorites: [...this.data.workspace.favorites],
        remoteRoots: [...this.data.workspace.remoteRoots],
      },
      layout: { ...this.data.layout },
      lsp: {
        enabled: this.data.lsp.enabled,
        trace: this.data.lsp.trace,
        servers: this.data.lsp.servers.map((server) => ({ ...server, args: [...server.args] })),
      },
      // Копия: снимок настроек не должен меняться вслед за правкой списка.
      keybindings: { overrides: this.data.keybindings.overrides.map((item) => ({ ...item })) },
      git: { ...this.data.git },
    };
  }

  /** Запомнить проект: он попадает в начало списка и не дублируется. */
  rememberProject(root: string): void {
    const recent = [root, ...this.data.workspace.recent.filter((item) => item !== root)].slice(0, 12);
    this.data.workspace.recent = recent;
    this.persist();
  }

  forgetProject(root: string): void {
    this.data.workspace.recent = this.data.workspace.recent.filter((item) => item !== root);
    this.persist();
  }

  update(patch: SettingsPatch): Settings {
    if (patch.ai) {
      const target = this.data.ai;
      applyPatch(target, patch.ai);
    }
    if (patch.editor) {
      const next = { ...this.data.editor, ...patch.editor };
      // Сниппеты — данные из файла: прогоняем их через ту же проверку, что при чтении.
      if (patch.editor.snippets !== undefined) next.snippets = normalizeSnippets(patch.editor.snippets);
      // Направляющие из формы приходят строкой — приводим тем же разбором, что при чтении.
      if (patch.editor.rulers !== undefined) next.rulers = normalizeRulers(patch.editor.rulers);
      if (patch.editor.renderWhitespace !== undefined)
        next.renderWhitespace = normalizeWhitespaceMode(patch.editor.renderWhitespace);
      if (patch.editor.minimap !== undefined) next.minimap = patch.editor.minimap === true;
      if (patch.editor.wordWrap !== undefined) next.wordWrap = patch.editor.wordWrap === true;
      if (patch.editor.smoothScroll !== undefined) next.smoothScroll = patch.editor.smoothScroll === true;
      if (patch.editor.vimMode !== undefined) next.vimMode = patch.editor.vimMode === true;
      if (patch.editor.emacsMode !== undefined) next.emacsMode = patch.editor.emacsMode === true;
      if (patch.editor.fontLigatures !== undefined) next.fontLigatures = patch.editor.fontLigatures === true;
      if (patch.editor.emmet !== undefined) next.emmet = patch.editor.emmet === true;
      if (patch.editor.formatOnPaste !== undefined) next.formatOnPaste = patch.editor.formatOnPaste === true;
      if (patch.editor.spellcheck !== undefined) next.spellcheck = patch.editor.spellcheck === true;
      if (patch.editor.spellWords !== undefined) next.spellWords = normalizeSpellWords(patch.editor.spellWords);
      // Автосохранение: режим — из известного списка, задержка — в разумных рамках.
      if (patch.editor.autoSave !== undefined) next.autoSave = normalizeAutoSaveMode(patch.editor.autoSave);
      if (patch.editor.autoSaveDelayMs !== undefined) {
        next.autoSaveDelayMs = normalizeAutoSaveDelay(patch.editor.autoSaveDelayMs);
      }
      // Высота строки и каретка приходят из формы: приводим тем же разбором, что при чтении.
      if (patch.editor.lineHeight !== undefined) next.lineHeight = normalizeLineHeight(patch.editor.lineHeight);
      if (patch.editor.cursorStyle !== undefined) next.cursorStyle = normalizeCursorStyle(patch.editor.cursorStyle);
      if (patch.editor.cursorBlink !== undefined) next.cursorBlink = patch.editor.cursorBlink === true;
      this.data.editor = next;
    }
    if (patch.explorer) {
      const next = { ...this.data.explorer, ...patch.explorer };
      // Окно свежести — число из формы: поджимаем, как при чтении файла.
      if (patch.explorer.recentWindowHours !== undefined) {
        next.recentWindowHours = clampRecentHours(patch.explorer.recentWindowHours);
      }
      // Карта настроек по корням приходит целиком: она короткая, и её правит форма.
      if (patch.explorer.byRoot !== undefined) next.byRoot = normalizeRootOverrides(patch.explorer.byRoot);
      // Значки дерева: набор правил из формы или из файла — проверяем тем же разбором.
      if (patch.explorer.badges !== undefined) next.badges = sanitizeBadgeRules(patch.explorer.badges);
      this.data.explorer = next;
    }
    if (patch.run) {
      this.data.run = { ...this.data.run, ...patch.run };
    }
    if (patch.appearance) {
      const next = { ...this.data.appearance, ...patch.appearance };
      next.uiScale = sanitizeUiScale(next.uiScale);
      // Тему из файла перепроверяем тем же разбором, что при чтении: она приходит
      // из интерфейса, а туда — из файла, который человек мог править руками.
      if ('customTheme' in patch.appearance) {
        const theme = sanitizeThemeFile(patch.appearance.customTheme);
        if (theme) next.customTheme = theme;
        else delete next.customTheme;
      }
      this.data.appearance = next;
    }
    if (patch.layout) {
      this.data.layout = sanitizeLayout({ ...this.data.layout, ...patch.layout });
    }
    if (patch.lsp) {
      this.data.lsp = sanitizeLsp({ ...this.data.lsp, ...patch.lsp });
    }
    if (patch.workspace?.favorites !== undefined) {
      // Список приходит целиком: он короткий, и «заменить» понятнее, чем «добавить».
      this.data.workspace.favorites = normalizeFavorites(patch.workspace.favorites);
    }
    if (patch.workspace?.remoteRoots !== undefined) {
      this.data.workspace.remoteRoots = normalizeRemoteRoots(patch.workspace.remoteRoots);
    }
    if (patch.keybindings) {
      this.data.keybindings = { overrides: normalizeKeybindingOverrides(patch.keybindings.overrides) };
    }
    if (patch.git) {
      const next = { ...this.data.git, ...patch.git };
      next.pullMode = normalizePullMode(next.pullMode);
      this.data.git = next;
    }
    this.persist();
    return this.get();
  }

  setApiKey(providerId: string, apiKey: string): Settings {
    this.requireProvider(providerId);
    // В настройки ключ не пишется вовсе: только в отдельный файл секретов.
    this.credentials.set(providerId, apiKey);
    this.persist();
    return this.get();
  }

  clearApiKey(providerId: string): Settings {
    this.requireProvider(providerId);
    this.credentials.remove(providerId);
    this.persist();
    return this.get();
  }

  /** Ключ сервиса веб-поиска: не провайдер модели, поэтому хранится отдельно. */
  setWebSearchKey(apiKey: string): Settings {
    this.credentials.setWebSearch(apiKey);
    this.persist();
    return this.get();
  }

  clearWebSearchKey(): Settings {
    this.credentials.setWebSearch('');
    this.persist();
    return this.get();
  }

  /** Ключ веб-поиска: credentials.json → CHUI_WEB_SEARCH_KEY → BRAVE_API_KEY. */
  resolveWebSearchKey(): string | undefined {
    const stored = this.credentials.getWebSearch();
    if (stored) return stored;
    return process.env.CHUI_WEB_SEARCH_KEY ?? process.env.BRAVE_API_KEY;
  }

  /** Порядок поиска: credentials.json → специфичная переменная окружения → CHUI_API_KEY. */
  resolveApiKey(providerId: string): string | undefined {
    const stored = this.credentials.get(providerId);
    if (stored) return stored;
    const specific = ENV_KEYS[providerId];
    if (specific && process.env[specific]) return process.env[specific];
    return process.env.CHUI_API_KEY;
  }

  /**
   * Перенести ключи из старого `settings.json` в отдельный файл секретов.
   *
   * Зовётся один раз в конструкторе. Если переносить было нечего, файл настроек
   * не перезаписывается: лишняя запись на старте — лишний шанс потерять правку,
   * сделанную руками, пока IDE была закрыта.
   */
  private migrateSecrets(): void {
    const { secrets, found } = takeKeys({
      providers: this.data.ai.providers,
      webSearch: this.data.ai.webSearch?.apiKey,
    });
    if (!found) return;

    for (const provider of this.data.ai.providers) delete provider.apiKey;
    delete this.data.ai.webSearch.apiKey;
    // Сначала кладём ключи в отдельный файл, потом убираем из настроек: если
    // между этими шагами что-то случится, ключ потеряется в одном месте, а не в
    // обоих сразу (и его можно будет найти в старом файле).
    this.credentials.adopt(secrets);
    this.persist();
  }

  private requireProvider(providerId: string): StoredProvider {
    const provider = this.data.ai.providers.find((item) => item.id === providerId);
    if (!provider) throw new RpcFailure(RpcErrorCode.NotFound, `Провайдер не найден: ${providerId}`);
    return provider;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.filePath);
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function applyPatch(target: StoredSettings['ai'], patch: AiSettingsPatch): void {
  // Мастер-тумблер: выключает ассистент целиком, поэтому идёт первым.
  if (patch.enabled !== undefined) target.enabled = patch.enabled === true;
  if (patch.activeProviderId !== undefined) target.activeProviderId = patch.activeProviderId;
  if (patch.activeModel !== undefined) target.activeModel = patch.activeModel;
  if (patch.temperature !== undefined) target.temperature = patch.temperature;
  if (patch.maxTokens !== undefined) target.maxTokens = patch.maxTokens;
  // Окно контекста: 0 или отрицательное — снова доверяем имени модели.
  if (patch.contextWindow !== undefined) {
    const value = Math.round(patch.contextWindow);
    if (Number.isFinite(value) && value > 0) target.contextWindow = value;
    else delete target.contextWindow;
  }
  // Предел автосжатия: 0 — не сжимать по объёму (по умолчанию так).
  if (patch.compactAtTokens !== undefined) {
    const value = Math.round(patch.compactAtTokens);
    if (Number.isFinite(value) && value >= 0) target.compactAtTokens = value;
  }
  // «Сжимать чаще»: 0 — не сжимать по расписанию.
  if (patch.compactEveryTurns !== undefined) {
    const value = Math.round(patch.compactEveryTurns);
    if (Number.isFinite(value) && value >= 0) target.compactEveryTurns = value;
  }
  // Модель сжатия: пусто — снова сжимаем активной моделью.
  if (patch.compactModel !== undefined) {
    const value = patch.compactModel.trim();
    if (value) target.compactModel = value;
    else delete target.compactModel;
  }
  if (patch.systemPrompt !== undefined) target.systemPrompt = patch.systemPrompt;
  if (patch.reasoningEffort !== undefined) target.reasoningEffort = patch.reasoningEffort;
  if (patch.toolPreset !== undefined) target.toolPreset = sanitizeToolPreset(patch.toolPreset);
  if (patch.maxSteps !== undefined) target.maxSteps = clampSteps(patch.maxSteps, target.maxSteps);
  if (patch.maxAutopilotSteps !== undefined) {
    target.maxAutopilotSteps = clampSteps(patch.maxAutopilotSteps, target.maxAutopilotSteps);
  }
  if (patch.confirmDangerous !== undefined) target.confirmDangerous = patch.confirmDangerous === true;
  if (patch.approvalReview !== undefined) target.approvalReview = patch.approvalReview === true;
  // Модель проверки: пусто — проверяет активная модель беседы.
  if (patch.reviewModel !== undefined) {
    const value = patch.reviewModel.trim();
    if (value) target.reviewModel = value;
    else delete target.reviewModel;
  }
  if (patch.compressOutput !== undefined) target.compressOutput = patch.compressOutput === true;
  // Журнал прогонов: включение только явным `true` — как у остальных ходов наружу.
  if (patch.telemetry) target.telemetry.enabled = patch.telemetry.enabled === true;

  // Веб-поиск: включение, вид сервиса и адрес. Ключ сюда не входит — он приходит
  // отдельным вызовом `ai.setWebSearchKey`, как ключи провайдеров.
  if (patch.webFetch) {
    target.webFetch.enabled = patch.webFetch.enabled === true;
  }

  if (patch.webSearch) {
    const incoming = patch.webSearch;
    if (incoming.enabled !== undefined) target.webSearch.enabled = incoming.enabled === true;
    if (isWebSearchProvider(incoming.provider)) target.webSearch.provider = incoming.provider;
    if (incoming.endpoint !== undefined) target.webSearch.endpoint = incoming.endpoint.trim();
  }

  // Браузер: включение, путь к исполняемому файлу и режим без окна. Путь задаёт
  // человек — запускаем ровно то, что он назвал.
  if (patch.browser) {
    const incoming = patch.browser;
    if (incoming.enabled !== undefined) target.browser.enabled = incoming.enabled === true;
    if (incoming.executable !== undefined) target.browser.executable = incoming.executable.trim();
    if (incoming.headless !== undefined) target.browser.headless = incoming.headless === true;
    if (incoming.integrated !== undefined) target.browser.integrated = incoming.integrated === true;
  }

  // Песочница: проверяем образ и рабочий каталог теми же функциями, что и при
  // чтении файла, — значение из интерфейса ничем не надёжнее файла.
  if (patch.sandbox) {
    const incoming = patch.sandbox;
    target.sandbox = sanitizeSandbox({ ...target.sandbox, ...incoming });
  }

  // Серверы MCP заменяются целиком и проверяются той же функцией, что и при
  // чтении файла: команду запуска берём только у человека, а не у модели.
  if (patch.mcpServers !== undefined) {
    target.mcpServers = normalizeMcpServers(patch.mcpServers) as McpServerConfig[];
  }

  // Автодополнение: включатель и задержка. Задержку держим в разумных рамках —
  // ноль означал бы запрос на каждую нажатую клавишу.
  if (patch.inlineCompletion !== undefined) {
    const { enabled, debounceMs } = patch.inlineCompletion;
    if (enabled !== undefined) target.inlineCompletion.enabled = enabled;
    if (debounceMs !== undefined) {
      const value = Math.round(debounceMs);
      if (Number.isFinite(value)) target.inlineCompletion.debounceMs = Math.min(Math.max(value, 100), 5000);
    }
  }

  // Провайдеров можно добавлять и править из интерфейса: ключ к ним приходит
  // отдельным вызовом ai.setApiKey, здесь только адрес и список моделей.
  if (patch.provider) {
    const incoming = patch.provider;
    const existing = target.providers.find((item) => item.id === incoming.id);
    if (existing) {
      if (incoming.label !== undefined) existing.label = incoming.label;
      if (incoming.baseUrl !== undefined) existing.baseUrl = incoming.baseUrl;
      if (incoming.models !== undefined) existing.models = [...incoming.models];
      if (incoming.defaultModel !== undefined) existing.defaultModel = incoming.defaultModel;
      if (incoming.protocol !== undefined) existing.protocol = incoming.protocol;
      if (incoming.temperature !== undefined) existing.temperature = incoming.temperature;
      if (incoming.maxTokens !== undefined) existing.maxTokens = incoming.maxTokens;
      if (incoming.reasoningEffort !== undefined) existing.reasoningEffort = incoming.reasoningEffort;
      // Пустая строка — «стереть метку», а не «оставить как было».
      if (incoming.userId !== undefined) {
        const userId = incoming.userId.trim().slice(0, 128);
        if (userId) existing.userId = userId;
        else delete existing.userId;
      }
      if (incoming.strictTools !== undefined) existing.strictTools = incoming.strictTools;
    } else {
      const created: StoredProvider = {
        id: incoming.id,
        label: incoming.label ?? incoming.id,
        baseUrl: incoming.baseUrl ?? '',
        models: [...(incoming.models ?? [])],
      };
      if (incoming.protocol) created.protocol = incoming.protocol;
      if (incoming.temperature !== undefined) created.temperature = incoming.temperature;
      if (incoming.maxTokens !== undefined) created.maxTokens = incoming.maxTokens;
      if (incoming.reasoningEffort !== undefined) created.reasoningEffort = incoming.reasoningEffort;
      const userId = incoming.userId?.trim().slice(0, 128);
      if (userId) created.userId = userId;
      if (incoming.strictTools !== undefined) created.strictTools = incoming.strictTools;
      const fallback = incoming.defaultModel ?? incoming.models?.[0];
      if (fallback) created.defaultModel = fallback;
      target.providers.push(created);
    }
    if (!target.activeProviderId) target.activeProviderId = incoming.id;
  }

  if (patch.removeProviderId) {
    target.providers = target.providers.filter((item) => item.id !== patch.removeProviderId);
    if (target.activeProviderId === patch.removeProviderId) {
      target.activeProviderId = target.providers[0]?.id;
      delete target.activeModel;
    }
  }
}

/**
 * Старые имена моделей DeepSeek: провайдер отказался от них 24.07.2026, но в
 * settings.json они остались у всех, кто настроил подключение раньше — без
 * переименования первый же запрос получил бы отказ. `reasoner` теперь не имя
 * модели, а включённый режим размышления, поэтому он тоже становится flash:
 * размышление у неё включено по умолчанию.
 */
const LEGACY_MODEL_NAMES: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
};

function migrateLegacyModelNames(providers: StoredProvider[]): void {
  for (const provider of providers) {
    if (provider.id !== 'deepseek') continue;
    // Set сохраняет порядок вставки, поэтому список остаётся прежним по смыслу.
    provider.models = [...new Set(provider.models.map((model) => LEGACY_MODEL_NAMES[model] ?? model))];
    const current = provider.defaultModel;
    if (current) provider.defaultModel = LEGACY_MODEL_NAMES[current] ?? current;
    // Старое имя, ставшее новым, съест весь список: добавляем актуальные модели
    // пресета, иначе выбрать v4-pro из селекта будет нельзя без ручного ввода.
    const preset = DEFAULT_SETTINGS.ai.providers.find((item) => item.id === provider.id);
    if (preset) provider.models = [...new Set([...provider.models, ...preset.models])];
  }
}

function loadSettings(filePath: string): StoredSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    raw = null; // файла ещё нет или он побит — берём значения по умолчанию
  }

  const parsed = (raw ?? {}) as Partial<StoredSettings>;
  const storedAi = (parsed.ai ?? {}) as Partial<StoredSettings['ai']>;
  const providers =
    Array.isArray(storedAi.providers) && storedAi.providers.length > 0
      ? storedAi.providers.map((provider) => ({ ...provider }))
      : DEFAULT_SETTINGS.ai.providers.map((provider) => ({ ...provider }));
  migrateLegacyModelNames(providers);

  // Окно контекста мог задать человек в settings.json: держим только разумное число.
  const ai: StoredSettings['ai'] = { ...DEFAULT_SETTINGS.ai, ...storedAi, providers };
  // Активная модель тоже могла остаться старой: без переименования запрос ушёл бы в никуда.
  const activeAfterRename = ai.activeModel ? LEGACY_MODEL_NAMES[ai.activeModel] : undefined;
  if (activeAfterRename) ai.activeModel = activeAfterRename;
  const storedWindow = Math.round(Number(storedAi.contextWindow));
  if (Number.isFinite(storedWindow) && storedWindow > 0) ai.contextWindow = storedWindow;
  else delete ai.contextWindow;
  // Промт мог остаться прежним встроенным текстом — его не выбирали, а получили
  // в наследство от прошлой версии. Свой текст человека не трогаем.
  if (typeof ai.systemPrompt === 'string' && LEGACY_SYSTEM_PROMPTS.includes(ai.systemPrompt.trim())) {
    ai.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  // Старый общий предел 4096 был значением по умолчанию, а не выбором: в settings.json
  // он остался у всех.
  if (ai.maxTokens === 4096) ai.maxTokens = 0;

  // Предел автосжатия: 0 — не сжимать по объёму (теперь так по умолчанию). Побитое
  // или нулевое значение — как если бы его не было.
  const storedCompact = Math.round(Number(storedAi.compactAtTokens));
  ai.compactAtTokens =
    Number.isFinite(storedCompact) && storedCompact > 0 ? storedCompact : DEFAULT_SETTINGS.ai.compactAtTokens;

  // «Сжимать чаще»: побитое или отсутствующее — по умолчанию; 0 — расписание выключено.
  const storedEvery = Math.round(Number(storedAi.compactEveryTurns));
  ai.compactEveryTurns =
    Number.isFinite(storedEvery) && storedEvery >= 0 ? storedEvery : DEFAULT_SETTINGS.ai.compactEveryTurns;

  // Модель сжатия: строка без пробелов или ничего (тогда сжимаем активной моделью).
  ai.compactModel =
    typeof storedAi.compactModel === 'string' && storedAi.compactModel.trim()
      ? storedAi.compactModel.trim()
      : undefined;

  // Лимиты шагов могли прийти из старого файла или быть правлены руками.
  ai.maxSteps = clampSteps(storedAi.maxSteps, DEFAULT_SETTINGS.ai.maxSteps);
  ai.maxAutopilotSteps = clampSteps(storedAi.maxAutopilotSteps, DEFAULT_SETTINGS.ai.maxAutopilotSteps);
  // Флаг могли записать чем угодно: оставляем строго булево значение.
  ai.confirmDangerous = ai.confirmDangerous === true;
  ai.approvalReview = ai.approvalReview === true;
  // Модель проверки: строка без пробелов или ничего (тогда проверяет активная).
  ai.reviewModel =
    typeof storedAi.reviewModel === 'string' && storedAi.reviewModel.trim() ? storedAi.reviewModel.trim() : undefined;
  // Чтение страниц по ссылке: единственное поле — включение.
  ai.webFetch = { enabled: (storedAi.webFetch as { enabled?: unknown } | undefined)?.enabled === true };

  // Веб-поиск: файл правят и руками, поэтому берём только известные значения.
  const storedSearch = (storedAi.webSearch ?? {}) as Partial<StoredSettings['ai']['webSearch']>;
  ai.webSearch = {
    enabled: storedSearch.enabled === true,
    provider: isWebSearchProvider(storedSearch.provider) ? storedSearch.provider : 'searxng',
    endpoint: typeof storedSearch.endpoint === 'string' ? storedSearch.endpoint : '',
  };
  if (typeof storedSearch.apiKey === 'string' && storedSearch.apiKey) ai.webSearch.apiKey = storedSearch.apiKey;

  // Браузер: путь запуска задаёт человек, поэтому берём строку как есть, а
  // отсутствие поля читаем как «без окна» — так автоматизацию не видно поверх IDE.
  const storedBrowser = (storedAi.browser ?? {}) as Partial<StoredSettings['ai']['browser']>;
  ai.browser = {
    enabled: storedBrowser.enabled === true,
    executable: typeof storedBrowser.executable === 'string' ? storedBrowser.executable : '',
    headless: storedBrowser.headless !== false,
    integrated: storedBrowser.integrated !== false,
  };

  // Песочница: образ и рабочий каталог задаёт человек, файл правят и руками.
  // Побитое имя образа заменяется образцом, а не запускается как есть: имя уходит
  // в позицию флагов docker, и `--privileged` там был бы не образом.
  ai.sandbox = sanitizeSandbox(storedAi.sandbox);

  // Серверы MCP: файл правят руками, поэтому и команда, и аргументы проверяются.
  ai.mcpServers = normalizeMcpServers(storedAi.mcpServers) as McpServerConfig[];

  // Автодополнение: включено только явным `true` — каждый запрос стоит денег,
  // поэтому у тех, кто обновляется со старой версии, оно останется выключенным.
  const storedInline = (storedAi.inlineCompletion ?? {}) as Partial<AiInlineCompletionSettings>;
  const debounce = Math.round(Number(storedInline.debounceMs));
  ai.inlineCompletion = {
    enabled: storedInline.enabled === true,
    debounceMs: Number.isFinite(debounce) && debounce > 0 ? Math.min(Math.max(debounce, 100), 5000) : 350,
  };

  // Журнал прогонов включён только явным `true`: у тех, кто обновляется со старой
  // версии, поля нет — и писать чужую переписку без спроса мы не начинаем.
  ai.telemetry = { enabled: (storedAi.telemetry as { enabled?: unknown } | undefined)?.enabled === true };

  // Сжатие выключено только явным `false`: отсутствие поля читаем как «включено» —
  // иначе настройка молча отключилась бы у всех, кто обновляется со старой версии.
  ai.compressOutput = ai.compressOutput !== false;
  // Ассистент выключен только явным `false`: отсутствие поля читаем как «включён».
  ai.enabled = ai.enabled !== false;

  return {
    ai,
    editor: {
      ...DEFAULT_SETTINGS.editor,
      ...(parsed.editor ?? {}),
      // Сниппеты правит человек в файле, поэтому и триггер, и тело проверяются:
      // тело уходит в подсказку редактора привычной разметкой сниппетов.
      snippets: normalizeSnippets(parsed.editor?.snippets),
      // Направляющие могли править руками — приводим к списку столбцов тем же разбором.
      rulers: normalizeRulers(parsed.editor?.rulers),
      renderWhitespace: normalizeWhitespaceMode(parsed.editor?.renderWhitespace),
      minimap: parsed.editor?.minimap === true,
      wordWrap: parsed.editor?.wordWrap === true,
      // Плавная прокрутка выключена только явным `false`: старый settings.json её не знает.
      smoothScroll: parsed.editor?.smoothScroll !== false,
      // Vim-режим включён только явным `true`: старый settings.json его не знает.
      vimMode: parsed.editor?.vimMode === true,
      // Emacs-режим включён только явным `true`: старый settings.json его не знает.
      emacsMode: parsed.editor?.emacsMode === true,
      fontLigatures: parsed.editor?.fontLigatures === true,
      emmet: parsed.editor?.emmet !== false,
      // Форматирование при вставке включено только явным `true`: старый файл его не знает.
      formatOnPaste: parsed.editor?.formatOnPaste === true,
      // Орфография включена только явным `true`: старый settings.json её не знает.
      spellcheck: parsed.editor?.spellcheck === true,
      spellWords: normalizeSpellWords(parsed.editor?.spellWords),
      // Высоту строки и вид каретки правили в файле руками — проверяем и их.
      lineHeight: normalizeLineHeight(parsed.editor?.lineHeight),
      cursorStyle: normalizeCursorStyle(parsed.editor?.cursorStyle),
      // Мигание включено только явным `true`: старый settings.json его не знает.
      cursorBlink: parsed.editor?.cursorBlink !== false,
      // Автосохранение: файл могли править руками — берём только известный режим.
      autoSave: normalizeAutoSaveMode(parsed.editor?.autoSave),
      autoSaveDelayMs: normalizeAutoSaveDelay(parsed.editor?.autoSaveDelayMs),
    },
    // Секции появились позже первых версий: старый settings.json их не знает,
    // поэтому неполный файл догружается значениями по умолчанию, а список
    // исключений приводим к строкам — его могли править руками.
    explorer: {
      ...DEFAULT_SETTINGS.explorer,
      ...(parsed.explorer ?? {}),
      exclude: Array.isArray(parsed.explorer?.exclude)
        ? parsed.explorer.exclude.filter((item): item is string => typeof item === 'string')
        : [],
      nestingRules: Array.isArray(parsed.explorer?.nestingRules)
        ? parsed.explorer.nestingRules.filter((item): item is string => typeof item === 'string')
        : [],
      // Выключить можно явным `false`; любое другое значение — включено.
      updateImportsOnRename: parsed.explorer?.updateImportsOnRename !== false,
      // Группировка по назначению: включаем, только если попросили явно.
      groupByType: parsed.explorer?.groupByType === true,
      // Пакеты монорепо: тоже только по явной просьбе.
      groupByPackage: parsed.explorer?.groupByPackage === true,
      // Свежесть: включаем, если не выключили явно; окно — разумное число часов.
      recentChanges: parsed.explorer?.recentChanges !== false,
      recentWindowHours: clampRecentHours(parsed.explorer?.recentWindowHours),
      // Настройки отдельных папок: файл правят руками — берём только известные ключи.
      byRoot: normalizeRootOverrides(parsed.explorer?.byRoot),
      // Наборы значков из файла тоже могли править руками: маски и цвета проверяем.
      badges: sanitizeBadgeRules(parsed.explorer?.badges),
    },
    run: sanitizeRun({ ...DEFAULT_SETTINGS.run, ...(parsed.run ?? {}) }),
    appearance: {
      // Ключи перечислены поимённо, а не размазаны из файла: старый `theme`
      // (выбор схемы, которой больше нет) так отсеивается при чтении и не
      // возвращается в файл при следующем сохранении.
      uiScale: sanitizeUiScale(parsed.appearance?.uiScale),
      customTheme: sanitizeThemeFile(parsed.appearance?.customTheme),
    },
    layout: sanitizeLayout({ ...DEFAULT_SETTINGS.layout, ...(parsed.layout ?? {}) }),
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      ...(parsed.workspace ?? {}),
      // Список мог быть записан старым форматом — держим только строки.
      recent: Array.isArray(parsed.workspace?.recent)
        ? parsed.workspace!.recent.filter((item): item is string => typeof item === 'string')
        : [],
      // Избранное правили в интерфейсе или руками — тот же разбор, что у модели.
      favorites: normalizeFavorites(parsed.workspace?.favorites),
      // Удалённые папки: берём только адреса, которые сами же и разбираем.
      remoteRoots: normalizeRemoteRoots(parsed.workspace?.remoteRoots),
    },
    lsp: sanitizeLsp({ ...DEFAULT_SETTINGS.lsp, ...(parsed.lsp ?? {}) }),
    // Файл могут править руками: сочетания приводим к известному виду.
    keybindings: { overrides: normalizeKeybindingOverrides(parsed.keybindings?.overrides) },
    git: sanitizeGitSettings(parsed.git),
  };
}

/**
 * Удалённые папки: берём только разобранные адреса и приводим их к одному виду.
 * Битая строка (человек правил settings.json руками) отбрасывается — по ней
 * открывать нечего, а «молча ничего не открылось» хуже, чем её отсутствие.
 */
function normalizeRemoteRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const address = parseFsAddress(item);
    if (!address) continue;
    const text = formatFsAddress(address);
    if (result.includes(text)) continue;
    result.push(text);
    if (result.length >= MAX_REMOTE_ROOTS) break;
  }
  return result;
}

/** Потолок удалённых папок: десятка хватает, а список должен остаться читаемым. */
export const MAX_REMOTE_ROOTS = 10;

/** Копия темы из файла: снимок настроек не должен меняться вслед за правкой. */
function cloneThemeFile(theme: ThemeFile | null | undefined): ThemeFile | null {
  if (!theme) return null;
  return { ...theme, chrome: { ...theme.chrome }, tokens: { ...theme.tokens } };
}

/** Лимиты шагов агента: целое в разумном диапазоне, иначе — значение по умолчанию. */
function clampSteps(value: unknown, fallback: number): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > 500) return fallback;
  return rounded;
}

/** Макет рабочей области: размеры — положительные числа, видимость — строгие boolean. */
/** Окно свежести в часах: целое в разумных рамках, иначе — значение по умолчанию. */
function clampRecentHours(value: unknown): number {
  const hours = Math.round(Number(value));
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) return DEFAULT_SETTINGS.explorer.recentWindowHours;
  return hours;
}

function sanitizeLayout(value: LayoutSettings): LayoutSettings {
  const size = (raw: unknown, fallback: number): number => {
    const rounded = Math.round(Number(raw));
    return Number.isFinite(rounded) && rounded > 0 ? rounded : fallback;
  };
  const flag = (raw: unknown, fallback: boolean): boolean => (typeof raw === 'boolean' ? raw : fallback);
  return {
    sidebarSize: size(value.sidebarSize, DEFAULT_SETTINGS.layout.sidebarSize),
    rightSize: size(value.rightSize, DEFAULT_SETTINGS.layout.rightSize),
    dockSize: size(value.dockSize, DEFAULT_SETTINGS.layout.dockSize),
    sidebarVisible: flag(value.sidebarVisible, DEFAULT_SETTINGS.layout.sidebarVisible),
    rightVisible: flag(value.rightVisible, DEFAULT_SETTINGS.layout.rightVisible),
    dockVisible: flag(value.dockVisible, DEFAULT_SETTINGS.layout.dockVisible),
  };
}

/** Настройки запуска: путь к интерпретатору и карта «проект → интерпретатор». */
function sanitizeRun(value: RunSettings): RunSettings {
  const byRoot: Record<string, string> = {};
  const raw = value.pythonByRoot;
  if (raw && typeof raw === 'object') {
    for (const [root, interpreter] of Object.entries(raw)) {
      if (typeof interpreter === 'string' && interpreter.trim()) byRoot[root] = interpreter;
    }
  }
  return {
    pythonPath: typeof value.pythonPath === 'string' ? value.pythonPath : '',
    packageManager: value.packageManager ?? 'auto',
    saveBeforeRun: value.saveBeforeRun !== false,
    pythonByRoot: byRoot,
  };
}

/** Языковые серверы правит человек в settings.json: приводим к безопасному виду. */
function sanitizeLsp(value: LspSettings): LspSettings {
  const servers = Array.isArray(value.servers)
    ? value.servers
        .filter((server) => server && typeof server.language === 'string' && typeof server.command === 'string')
        .map((server) => ({
          language: server.language,
          command: server.command,
          args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : [],
          enabled: server.enabled !== false,
          // Подпись и окружение необязательны: у серверов из PATH их нет, а у тех,
          // что едут с IDE, они несут путь к Electron и режим Node.
          ...(typeof server.label === 'string' && server.label ? { label: server.label } : {}),
          ...(isStringRecord(server.env) ? { env: server.env } : {}),
          ...(isPlainObject(server.initializationOptions)
            ? { initializationOptions: server.initializationOptions }
            : {}),
        }))
    : [];
  // Выключено только явным `false`: отсутствие поля читаем как «включено» — серверы
  // из поставки должны работать сразу после установки, без похода в настройки.
  return { enabled: value.enabled !== false, trace: value.trace === true, servers };
}

/** Запись «строка → строка»: так приходит окружение сервера из файла настроек. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');
}

/** Простой объект (не массив и не null): довод `initialize` у сервера из поставки. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
