import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  RpcErrorCode,
  type AiInlineCompletionSettings,
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
import { COMPACT_AT_TOKENS } from '../shared/context-fit';
import { normalizeMcpServers, type McpServerConfig } from '../shared/mcp';
import { DEFAULT_SANDBOX, sanitizeSandbox, type AiSandboxSettings } from '../shared/sandbox';
import { normalizeSnippets } from '../shared/snippets';
import { normalizeRulers } from '../shared/rulers';
import { normalizeWhitespaceMode } from '../shared/whitespace';
import { normalizePullMode } from '../shared/git-pull';
import { normalizeKeybindingOverrides, type KeybindingSettings } from '../shared/keybindings';
import { sanitizeThemeFile, type ThemeFile } from '../shared/theme-file';
import { sanitizeUiScale } from '../shared/ui-scale';
import { isWebSearchProvider, type WebSearchProvider } from '../shared/web-search';
import { RpcFailure } from './ipc/router';

interface StoredProvider {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  /** Как говорить с провайдером: OpenAI-совместимо или нативно (Anthropic). */
  protocol?: 'openai' | 'anthropic';
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
    /** Абсолютный предел истории для автосжатия; 0 — по окну модели. */
    compactAtTokens: number;
    /** Модель для сжатия беседы; не задана — активная. */
    compactModel?: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    /** Страховка от зацикливания: шагов «модель → инструмент → модель» в обычном режиме. */
    maxSteps: number;
    /** То же при полном доступе. */
    maxAutopilotSteps: number;
    /** Страховка полного доступа: спрашивать перед необратимыми командами. */
    confirmDangerous: boolean;
    /** Убирать шум из вывода инструментов перед отправкой модели. */
    compressOutput: boolean;
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
    };
    /** Песочница: команды агента выполняются в контейнере. */
    sandbox: AiSandboxSettings;
    /** Серверы внешних инструментов (MCP): их процессы запускает IDE. */
    mcpServers: McpServerConfig[];
    /** Inline-автодополнение: выключено, пока человек не включит его сам. */
    inlineCompletion: AiInlineCompletionSettings;
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

const DEFAULT_SYSTEM_PROMPT = [
  'Ты — встроенный ассистент chui_iDE.',
  'Отвечай кратко и по делу. Когда предлагаешь правку — давай минимальный диф, а не файл целиком.',
  'Не выдумывай API: если не уверен в сигнатуре, попроси показать нужный файл.',
].join('\n');

const DEFAULT_SETTINGS: StoredSettings = {
  ai: {
    // Ассистент включён по умолчанию: это часть IDE, выключается осознанно.
    enabled: true,
    providers: [
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini'],
        defaultModel: 'gpt-4o-mini',
      },
      {
        id: 'ollama',
        label: 'Ollama (локально)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: ['qwen2.5-coder:7b', 'llama3.1:8b'],
        defaultModel: 'qwen2.5-coder:7b',
      },
    ],
    temperature: 0.2,
    maxTokens: 4096,
    // Предел автосжатия: история сверх этого числа сжимается, даже если окно ещё далеко.
    compactAtTokens: COMPACT_AT_TOKENS,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // По умолчанию параметр не отправляем: не всякая модель его знает.
    reasoningEffort: 'off',
    // Страховка от бесконечного цикла «модель → инструмент → модель».
    maxSteps: 8,
    // При полном доступе задача длиннее: шагов нужно больше.
    maxAutopilotSteps: 24,
    // Полный доступ по умолчанию не напролом: перед необратимыми командами
    // (sudo, rm, git push --force) спрашиваем, пока человек сам не отключит
    // страховку. Лишний вопрос дешевле одного пропущенного `rm -rf`.
    confirmDangerous: true,
    // Сжатие включено: оно снимает оформление, а не содержание.
    compressOutput: true,
    // Веб-поиск выключен: агент не должен ходить в интернет без явного согласия.
    webSearch: { enabled: false, provider: 'searxng', endpoint: '' },
    // Браузер выключен: агент ходил бы по чужим страницам и нажимал там кнопки.
    // Включается осознанно — вместе с ним включаются и подтверждения действий.
    browser: { enabled: false, executable: '', headless: true },
    // Песочница выключена: команды агента идут на хосте, как раньше. Включив её,
    // человек сам выбирает образ — в нём должны быть инструменты проекта.
    sandbox: { ...DEFAULT_SANDBOX },
    // Серверов MCP по умолчанию нет: их команды задаёт человек.
    mcpServers: [],
    // Автодополнение выключено: каждый запрос — это обращение к модели (время и
    // деньги) на каждую паузу в наборе. Включается осознанно.
    inlineCompletion: { enabled: false, debounceMs: 350 },
  },
  editor: {
    tabSize: 4,
    fontSize: 14,
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
    // Лигатуры выключены: не всякий шрифт их умеет, и не всем они нравятся.
    fontLigatures: false,
    // Своих сниппетов по умолчанию нет: набор, что знает редактор, живёт в коде
    // (`shared/snippets.ts`), а здесь — только добавленное человеком.
    snippets: [],
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
    // Игнорируемое приглушаем: это подсказка, а не запрет — файл остаётся виден.
    dimIgnored: true,
    // Привычка из PyCharm: двойной клик открывает, одинарный — выделяет.
    openOnSingleClick: false,
    confirmDelete: true,
    exclude: [],
  },
  run: {
    // Пусто: сначала ищем окружение проекта, потом `python3` из PATH.
    pythonPath: '',
    packageManager: 'auto',
    saveBeforeRun: true,
    pythonByRoot: {},
  },
  appearance: {
    // «Системная» — разумная точка входа: IDE подстраивается под схему рабочего стола.
    theme: 'system',
    // Масштаб 1 — оболочка как задумана; крупнее/плотнее человек выбирает сам.
    uiScale: 1,
    // Встроенная палитра: тему из файла человек приносит сам.
    customTheme: null,
  },
  workspace: {
    // История открытых папок живёт в настройках, а не в renderer: её показывает
    // стартовое окно, а оно — отдельный процесс со своим хранилищем.
    recent: [],
  },
  // Размеры и видимость панелей — рабочее место человека, общее для всех проектов.
  // Значения совпадают с CSS-переменными по умолчанию и сбросом сплиттеров.
  layout: {
    sidebarSize: 260,
    rightSize: 400,
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
    servers: [],
  },
  // Git: по умолчанию не подсказываем режим pull — git ведёт себя как настроен.
  // Навязывать слияние или перебазирование без спроса было бы навязчиво.
  git: { pullMode: 'default' },
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
  private data: StoredSettings;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(app.getPath('userData'), 'settings.json');
    this.data = loadSettings(this.filePath);
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
          hasApiKey: Boolean(this.resolveApiKey(provider.id)),
        })),
        activeProviderId: ai.activeProviderId ?? ai.providers[0]?.id,
        activeModel: ai.activeModel,
        temperature: ai.temperature,
        maxTokens: ai.maxTokens,
        contextWindow: ai.contextWindow,
        compactAtTokens: ai.compactAtTokens,
        compactModel: ai.compactModel,
        systemPrompt: ai.systemPrompt,
        reasoningEffort: ai.reasoningEffort ?? 'off',
        maxSteps: ai.maxSteps,
        maxAutopilotSteps: ai.maxAutopilotSteps,
        confirmDangerous: ai.confirmDangerous,
        compressOutput: ai.compressOutput !== false,
        webSearch: {
          enabled: ai.webSearch?.enabled === true,
          provider: ai.webSearch?.provider ?? 'searxng',
          endpoint: ai.webSearch?.endpoint ?? '',
          hasApiKey: Boolean(this.resolveWebSearchKey()),
        },
        browser: {
          enabled: ai.browser?.enabled === true,
          executable: ai.browser?.executable ?? '',
          // Без окна по умолчанию: браузер заводят ради автоматизации, а не ради
          // того, чтобы он всплывал поверх редактора.
          headless: ai.browser?.headless !== false,
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
      editor: { ...editor, snippets: editor.snippets.map((snippet) => ({ ...snippet })) },
      explorer: { ...explorer, exclude: [...explorer.exclude] },
      run: { ...run },
      // Тема из файла — вложенный объект: отдаём копию, чтобы правка снимка не
      // меняла уже сохранённые настройки.
      appearance: {
        ...this.data.appearance,
        customTheme: cloneThemeFile(this.data.appearance.customTheme),
      },
      workspace: { recent: [...this.data.workspace.recent] },
      layout: { ...this.data.layout },
      lsp: {
        enabled: this.data.lsp.enabled,
        servers: this.data.lsp.servers.map((server) => ({ ...server, args: [...server.args] })),
      },
      // Копия: снимок настроек не должен меняться вслед за правкой списка.
      keybindings: { overrides: this.data.keybindings.overrides.map((item) => ({ ...item })) },
      git: { pullMode: this.data.git.pullMode },
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
      if (patch.editor.fontLigatures !== undefined) next.fontLigatures = patch.editor.fontLigatures === true;
      this.data.editor = next;
    }
    if (patch.explorer) {
      this.data.explorer = { ...this.data.explorer, ...patch.explorer };
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
    const provider = this.requireProvider(providerId);
    const trimmed = apiKey.trim();
    if (trimmed) provider.apiKey = trimmed;
    else delete provider.apiKey;
    this.persist();
    return this.get();
  }

  clearApiKey(providerId: string): Settings {
    const provider = this.requireProvider(providerId);
    delete provider.apiKey;
    this.persist();
    return this.get();
  }

  /** Ключ сервиса веб-поиска: не провайдер модели, поэтому хранится отдельно. */
  setWebSearchKey(apiKey: string): Settings {
    const trimmed = apiKey.trim();
    if (trimmed) this.data.ai.webSearch.apiKey = trimmed;
    else delete this.data.ai.webSearch.apiKey;
    this.persist();
    return this.get();
  }

  clearWebSearchKey(): Settings {
    delete this.data.ai.webSearch.apiKey;
    this.persist();
    return this.get();
  }

  /** Ключ веб-поиска: settings.json → CHUI_WEB_SEARCH_KEY → BRAVE_API_KEY. */
  resolveWebSearchKey(): string | undefined {
    const stored = this.data.ai.webSearch?.apiKey;
    if (stored) return stored;
    return process.env.CHUI_WEB_SEARCH_KEY ?? process.env.BRAVE_API_KEY;
  }

  /** Порядок поиска: settings.json → специфичная переменная окружения → CHUI_API_KEY. */
  resolveApiKey(providerId: string): string | undefined {
    const provider = this.data.ai.providers.find((item) => item.id === providerId);
    if (provider?.apiKey) return provider.apiKey;
    const specific = ENV_KEYS[providerId];
    if (specific && process.env[specific]) return process.env[specific];
    return process.env.CHUI_API_KEY;
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
  // Предел автосжатия: 0 — сжимать только по заполнению окна.
  if (patch.compactAtTokens !== undefined) {
    const value = Math.round(patch.compactAtTokens);
    if (Number.isFinite(value) && value >= 0) target.compactAtTokens = value;
  }
  // Модель сжатия: пусто — снова сжимаем активной моделью.
  if (patch.compactModel !== undefined) {
    const value = patch.compactModel.trim();
    if (value) target.compactModel = value;
    else delete target.compactModel;
  }
  if (patch.systemPrompt !== undefined) target.systemPrompt = patch.systemPrompt;
  if (patch.reasoningEffort !== undefined) target.reasoningEffort = patch.reasoningEffort;
  if (patch.maxSteps !== undefined) target.maxSteps = clampSteps(patch.maxSteps, target.maxSteps);
  if (patch.maxAutopilotSteps !== undefined) {
    target.maxAutopilotSteps = clampSteps(patch.maxAutopilotSteps, target.maxAutopilotSteps);
  }
  if (patch.confirmDangerous !== undefined) target.confirmDangerous = patch.confirmDangerous === true;
  if (patch.compressOutput !== undefined) target.compressOutput = patch.compressOutput === true;

  // Веб-поиск: включение, вид сервиса и адрес. Ключ сюда не входит — он приходит
  // отдельным вызовом `ai.setWebSearchKey`, как ключи провайдеров.
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
    } else {
      const created: StoredProvider = {
        id: incoming.id,
        label: incoming.label ?? incoming.id,
        baseUrl: incoming.baseUrl ?? '',
        models: [...(incoming.models ?? [])],
      };
      if (incoming.protocol) created.protocol = incoming.protocol;
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

  // Окно контекста мог задать человек в settings.json: держим только разумное число.
  const ai: StoredSettings['ai'] = { ...DEFAULT_SETTINGS.ai, ...storedAi, providers };
  const storedWindow = Math.round(Number(storedAi.contextWindow));
  if (Number.isFinite(storedWindow) && storedWindow > 0) ai.contextWindow = storedWindow;
  else delete ai.contextWindow;

  // Предел автосжатия: 0 — по окну модели; побитое или отсутствующее — по умолчанию.
  const storedCompact = Math.round(Number(storedAi.compactAtTokens));
  ai.compactAtTokens =
    Number.isFinite(storedCompact) && storedCompact >= 0 ? storedCompact : DEFAULT_SETTINGS.ai.compactAtTokens;

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
      // тело уходит в подсказку редактора разметкой Monaco.
      snippets: normalizeSnippets(parsed.editor?.snippets),
      // Направляющие могли править руками — приводим к списку столбцов тем же разбором.
      rulers: normalizeRulers(parsed.editor?.rulers),
      renderWhitespace: normalizeWhitespaceMode(parsed.editor?.renderWhitespace),
      minimap: parsed.editor?.minimap === true,
      wordWrap: parsed.editor?.wordWrap === true,
      fontLigatures: parsed.editor?.fontLigatures === true,
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
    },
    run: sanitizeRun({ ...DEFAULT_SETTINGS.run, ...(parsed.run ?? {}) }),
    appearance: {
      ...DEFAULT_SETTINGS.appearance,
      ...(parsed.appearance ?? {}),
      // Масштаб — число из файла: поджимаем к допустимым ступеням.
      uiScale: sanitizeUiScale(parsed.appearance?.uiScale),
      // Тему из файла могли править руками: принимаем только корректную.
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
    },
    lsp: sanitizeLsp({ ...DEFAULT_SETTINGS.lsp, ...(parsed.lsp ?? {}) }),
    // Файл могут править руками: сочетания приводим к известному виду.
    keybindings: { overrides: normalizeKeybindingOverrides(parsed.keybindings?.overrides) },
    // Режим pull могли записать чем угодно — держим только известные значения.
    git: { pullMode: normalizePullMode(parsed.git?.pullMode) },
  };
}

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
  return { enabled: value.enabled !== false, servers };
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
