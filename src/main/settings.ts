import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  RpcErrorCode,
  type AiSettingsPatch,
  type AppearanceSettings,
  type EditorSettings,
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
    systemPrompt: string;
  };
  editor: EditorSettings;
  appearance: AppearanceSettings;
  workspace: WorkspaceSettings;
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
  },
  editor: {
    tabSize: 4,
    fontSize: 14,
    wordWrap: false,
    // В PyCharm миникарты нет — по умолчанию она выключена.
    minimap: false,
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
};

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
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
    const { ai, editor } = this.data;
    return {
      ai: {
        providers: ai.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          baseUrl: provider.baseUrl,
          models: [...provider.models],
          defaultModel: provider.defaultModel,
          hasApiKey: Boolean(this.resolveApiKey(provider.id)),
        })),
        activeProviderId: ai.activeProviderId ?? ai.providers[0]?.id,
        activeModel: ai.activeModel,
        temperature: ai.temperature,
        maxTokens: ai.maxTokens,
        systemPrompt: ai.systemPrompt,
      },
      editor: { ...editor },
      appearance: { ...this.data.appearance },
      workspace: { recent: [...this.data.workspace.recent] },
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
    if (patch.appearance) {
      this.data.appearance = { ...this.data.appearance, ...patch.appearance };
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
  if (patch.systemPrompt !== undefined) target.systemPrompt = patch.systemPrompt;
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

  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...storedAi, providers },
    editor: { ...DEFAULT_SETTINGS.editor, ...(parsed.editor ?? {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(parsed.appearance ?? {}) },
    workspace: {
      ...DEFAULT_SETTINGS.workspace,
      ...(parsed.workspace ?? {}),
      // Список мог быть записан старым форматом — держим только строки.
      recent: Array.isArray(parsed.workspace?.recent)
        ? parsed.workspace!.recent.filter((item): item is string => typeof item === 'string')
        : [],
    },
  };
}
