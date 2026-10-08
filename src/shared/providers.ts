import type { ReasoningEffort } from './api';

/**
 * Известные OpenAI-совместимые провайдеры.
 *
 * Смысл списка — избавить пользователя от знания адресов эндпоинтов: он выбирает
 * провайдера по имени, а `baseUrl` и стартовый набор моделей подставляются сами.
 * Всё, что перечислено здесь, говорит на одном протоколе, поэтому одного
 * `OpenAiCompatibleProvider` хватает на всех.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Локальным серверам ключ не нужен — это видно в интерфейсе. */
  needsKey: boolean;
  /** Стартовый список моделей: до первого «Проверить подключение». */
  models: string[];
  defaultModel: string;
  /** Короткая подсказка, где взять ключ или как поднять сервер. */
  hint: string;
  /** Протокол: по умолчанию OpenAI-совместимый, у Anthropic — нативный. */
  protocol?: 'openai' | 'anthropic';
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    models: ['gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
    hint: 'Ключ — на platform.openai.com/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    hint: 'Ключ — на platform.deepseek.com',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    hint: 'Ключ — на console.anthropic.com. Работает нативный протокол Messages API',
    protocol: 'anthropic',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    models: ['llama-3.3-70b-versatile', 'qwen-2.5-coder-32b'],
    defaultModel: 'llama-3.3-70b-versatile',
    hint: 'Ключ — на console.groq.com/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5'],
    defaultModel: 'openai/gpt-4o-mini',
    hint: 'Ключ — на openrouter.ai/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (локально)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    models: ['qwen2.5-coder:7b', 'llama3.1:8b'],
    defaultModel: 'qwen2.5-coder:7b',
    hint: 'Запустите `ollama serve` — ключ не нужен',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (локально)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    models: [],
    defaultModel: '',
    hint: 'Включите Local Server в LM Studio — ключ не нужен',
  },
  {
    id: 'custom',
    label: 'Другое (OpenAI-совместимое)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    needsKey: false,
    models: [],
    defaultModel: '',
    hint: 'llama.cpp, vLLM, свой шлюз — адрес и модель задайте вручную',
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/* ── возможности модели ─────────────────────────────────────────────────── */

/**
 * Что модель умеет сверх обычного чата.
 *
 * Это знание о моделях, а не о провайдерах: один и тот же шлюз отдаёт и
 * `gpt-4o`, и `o3`. Поэтому решаем по имени модели — единственному, что есть
 * на руках до запроса, — и не отправляем провайдеру параметры, которых он
 * не ждёт: лишнее поле в теле запроса либо игнорируется молча, либо ломает
 * запрос целиком (o-серия от OpenAI отвечает 400 на `temperature`).
 */
export interface ModelCapabilities {
  /** Принимает ли модель `reasoning_effort`. */
  reasoningEffort: boolean;
  /** Принимает ли модель `temperature`. */
  temperature: boolean;
  /** Почему недоступно — для подсказки в интерфейсе. Пусто, когда всё доступно. */
  note?: string;
}

const FULL: ModelCapabilities = { reasoningEffort: false, temperature: true };

export function modelCapabilities(model: string): ModelCapabilities {
  const name = model.trim().toLowerCase();

  // OpenAI o-серия и gpt-5: думают сами, усилие задаётся reasoning_effort,
  // а temperature отвергается.
  if (/^(o1|o3|o4|gpt-5)/.test(name)) {
    return {
      reasoningEffort: true,
      temperature: false,
      note: 'модель сама решает, сколько думать; temperature не поддерживается',
    };
  }

  // DeepSeek Reasoner тоже думает всегда, но параметра усилия у него нет.
  if (name.startsWith('deepseek-reasoner')) {
    return {
      reasoningEffort: false,
      temperature: false,
      note: 'reasoner размышляет всегда, параметра усилия у модели нет',
    };
  }

  // Открытые reasoning-модели: усилие принимают, температуру тоже.
  if (/thinking|qwq|qwen3|deepseek-r1|-r1-|distill|grok-3-mini|grok-4/.test(name)) {
    return { reasoningEffort: true, temperature: true };
  }

  return FULL;
}

/** Усилие доехало до провайдера только когда модель его понимает и оно не `off`. */
export function reasoningEffortFor(
  model: string,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!effort || effort === 'off') return undefined;
  return modelCapabilities(model).reasoningEffort ? effort : undefined;
}

/**
 * Размер контекстного окна модели в токенах.
 *
 * Провайдер его не сообщает, а без знаменателя заполнение контекста не показать.
 * Значения — из документации вендоров; для незнакомых моделей берём 128K:
 * это частое значение, и лучше показать приблизительное число, чем никакого.
 */
export function contextWindow(model: string, override?: number): number {
  // Явное значение из настроек важнее эвристики: шлюзы отдают модели со своими
  // именами, и угадать окно по имени не всегда можно.
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.round(override);

  const name = model.trim().toLowerCase();
  if (name.includes('gemini')) return 1_000_000;
  if (/^(o1|o3|o4|gpt-5)/.test(name)) return 200_000;
  if (name.startsWith('claude')) return 200_000;
  if (name.startsWith('deepseek')) return 64_000;
  if (name.includes('grok')) return 131_072;
  return 128_000;
}

/**
 * Цена модели за 1 млн токенов (USD): `input` — запрос, `output` — ответ.
 *
 * Значения приблизительные (прайс провайдеров меняется), но для оценки
 * стоимости обмена этого достаточно: точную цену знает только выставленный
 * счёт. Незнакомая модель → `null`, стоимость просто не показываем.
 */
export interface ModelPricing {
  input: number;
  output: number;
}

export function modelPricing(model: string): ModelPricing | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;

  // OpenAI
  if (name.startsWith('gpt-4o-mini')) return { input: 0.15, output: 0.6 };
  if (name.startsWith('gpt-4o')) return { input: 2.5, output: 10 };
  if (name.startsWith('gpt-4.1-mini')) return { input: 0.4, output: 1.6 };
  if (name.startsWith('gpt-4.1')) return { input: 2, output: 8 };
  if (name.startsWith('o4-mini')) return { input: 1.1, output: 4.4 };
  if (name.startsWith('o3')) return { input: 10, output: 40 };
  if (name.startsWith('o1-mini')) return { input: 1.1, output: 4.4 };
  if (name.startsWith('o1')) return { input: 15, output: 60 };
  if (name.startsWith('gpt-5')) return { input: 1.25, output: 10 };

  // DeepSeek
  if (name.startsWith('deepseek-reasoner')) return { input: 0.55, output: 2.19 };
  if (name.startsWith('deepseek')) return { input: 0.27, output: 1.1 };

  // Anthropic (через шлюз)
  if (name.includes('claude-opus')) return { input: 15, output: 75 };
  if (name.includes('claude-haiku')) return { input: 1, output: 5 };
  if (name.includes('claude')) return { input: 3, output: 15 };

  // Прочее из пресетов
  if (name.startsWith('llama-3.3-70b')) return { input: 0.59, output: 0.79 };
  if (name.includes('qwen') && name.includes('coder')) return null; // локальные/дешёвые — цену не гадаем

  return null;
}
