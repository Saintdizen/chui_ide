import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  RpcErrorCode,
  type AiSettingsPatch,
  type AppearanceSettings,
  type EditorSettings,
  type ExplorerSettings,
  type LspSettings,
  type ReasoningEffort,
  type RunSettings,
  type Settings,
  type SettingsPatch,
  type WorkspaceSettings,
} from '../shared/api';
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
    providers: StoredProvider[];
    activeProviderId?: string;
    activeModel?: string;
    temperature: number;
    maxTokens: number;
    /** Не задано — окно определяется по имени модели. */
    contextWindow?: number;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    /** Страховка от зацикливания: шагов «модель → инструмент → модель» без автопилота. */
    maxSteps: number;
    /** То же в автопилоте. */
    maxAutopilotSteps: number;
  };
  editor: EditorSettings;
  explorer: ExplorerSettings;
  run: RunSettings;
  appearance: AppearanceSettings;
  workspace: WorkspaceSettings;
  lsp: LspSettings;
}

const DEFAULT_SYSTEM_PROMPT = [
  'Ты — встроенный ассистент IDE Chui.',
  'Отвечай кратко и по делу. Когда предлагаешь правку — давай минимальный диф, а не файл целиком.',
  'Не выдумывай API: если не уверен в сигнатуре, попроси показать нужный файл.',
].join('\n');

const DEFAULT_SETTINGS: StoredSettings = {
  ai: {
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
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // По умолчанию параметр не отправляем: не всякая модель его знает.
    reasoningEffort: 'off',
    // Страховка от бесконечного цикла «модель → инструмент → модель».
    maxSteps: 8,
    // В автопилоте задача длиннее: шагов нужно больше.
    maxAutopilotSteps: 24,
  },
  editor: {
    tabSize: 4,
    fontSize: 14,
    wordWrap: false,
    // В PyCharm миникарты нет — по умолчанию она выключена.
    minimap: false,
    fontLigatures: true,
    insertSpaces: true,
    // Python и Makefile требуют разного отступа: пусть язык решает сам.
    languageIndent: true,
    renderWhitespace: 'selection',
    cursorBlinking: 'smooth',
    smoothScrolling: true,
    // Как в PyCharm: ниже последней строки остаётся место для чтения.
    scrollBeyondLastLine: true,
    lineNumbers: 'on',
    renderLineHighlight: 'all',
    bracketPairColorization: true,
    stickyScroll: false,
    quickSuggestions: true,
    showUnused: true,
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
  },
  appearance: {
    // «Системная» — разумная точка входа: IDE подстраивается под схему рабочего стола.
    theme: 'system',
  },
  workspace: {
    // История открытых папок живёт в настройках, а не в renderer: её показывает
    // стартовое окно, а оно — отдельный процесс со своим хранилищем.
    recent: [],
  },
  lsp: {
    // По умолчанию выключено: языковой сервер — внешний процесс, который нужно
    // установить и указать вручную. Никаких догадок про пути к бинарникам.
    enabled: false,
    servers: [],
  },
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
        systemPrompt: ai.systemPrompt,
        reasoningEffort: ai.reasoningEffort ?? 'off',
        maxSteps: ai.maxSteps,
        maxAutopilotSteps: ai.maxAutopilotSteps,
      },
      editor: { ...editor },
      explorer: { ...explorer, exclude: [...explorer.exclude] },
      run: { ...run },
      appearance: { ...this.data.appearance },
      workspace: { recent: [...this.data.workspace.recent] },
      lsp: {
        enabled: this.data.lsp.enabled,
        servers: this.data.lsp.servers.map((server) => ({ ...server, args: [...server.args] })),
      },
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
      this.data.editor = { ...this.data.editor, ...patch.editor };
    }
    if (patch.explorer) {
      this.data.explorer = { ...this.data.explorer, ...patch.explorer };
    }
    if (patch.run) {
      this.data.run = { ...this.data.run, ...patch.run };
    }
    if (patch.appearance) {
      this.data.appearance = { ...this.data.appearance, ...patch.appearance };
    }
    if (patch.lsp) {
      this.data.lsp = sanitizeLsp({ ...this.data.lsp, ...patch.lsp });
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
  if (patch.systemPrompt !== undefined) target.systemPrompt = patch.systemPrompt;
  if (patch.reasoningEffort !== undefined) target.reasoningEffort = patch.reasoningEffort;
  if (patch.maxSteps !== undefined) target.maxSteps = clampSteps(patch.maxSteps, target.maxSteps);
  if (patch.maxAutopilotSteps !== undefined) {
    target.maxAutopilotSteps = clampSteps(patch.maxAutopilotSteps, target.maxAutopilotSteps);
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

  // Лимиты шагов могли прийти из старого файла или быть правлены руками.
  ai.maxSteps = clampSteps(storedAi.maxSteps, DEFAULT_SETTINGS.ai.maxSteps);
  ai.maxAutopilotSteps = clampSteps(storedAi.maxAutopilotSteps, DEFAULT_SETTINGS.ai.maxAutopilotSteps);

  return {
    ai,
    editor: { ...DEFAULT_SETTINGS.editor, ...(parsed.editor ?? {}) },
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
    run: { ...DEFAULT_SETTINGS.run, ...(parsed.run ?? {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(parsed.appearance ?? {}) },
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      ...(parsed.workspace ?? {}),
      // Список мог быть записан старым форматом — держим только строки.
      recent: Array.isArray(parsed.workspace?.recent)
        ? parsed.workspace!.recent.filter((item): item is string => typeof item === 'string')
        : [],
    },
    lsp: sanitizeLsp({ ...DEFAULT_SETTINGS.lsp, ...(parsed.lsp ?? {}) }),
  };
}

/** Лимиты шагов агента: целое в разумном диапазоне, иначе — значение по умолчанию. */
function clampSteps(value: unknown, fallback: number): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > 500) return fallback;
  return rounded;
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
        }))
    : [];
  return { enabled: value.enabled === true, servers };
}
