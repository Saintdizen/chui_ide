import type { ReasoningEffort } from './api';

/**
 * Что провайдер спрашивает при подключении. Набор у каждого свой: локальному серверу
 * ключ не нужен, «Другому» важен протокол, облачному — ключ и модель. Порядок набора —
 * порядок полей в окне.
 */
export type ProviderConfigField = 'label' | 'baseUrl' | 'apiKey' | 'model' | 'protocol';

/** Значения, которые человек ввёл в окне подключения. */
export interface ProviderConfigValues {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  /** Метка пользователя для провайдера; пусто — не отправлять. */
  userId?: string;
  /** Строгая схема аргументов инструментов (`strict: true`). */
  strictTools?: boolean;
}

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
  /**
   * Поля окна подключения. Не задано — выводится из `needsKey`: название, адрес,
   * ключ (только если он нужен) и модель.
   */
  fields?: readonly ProviderConfigField[];
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
    // Старые имена deepseek-chat и deepseek-reasoner отключены 24.07.2026: те же
    // модели называются по-новому, а режим размышления теперь параметр, а не имя.
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
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
    // Свой шлюз — единственный, где протокол и ключ решает человек.
    fields: ['label', 'baseUrl', 'apiKey', 'model', 'protocol'],
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/**
 * Кого сейчас предлагаем добавить в настройках. Остальные записи `PROVIDER_PRESETS`
 * остаются нарочно: по ним узнаются адрес, модели и переменная окружения у уже
 * сохранённых конфигов, а `findProviderPreset` по ним не возвращает пустоту.
 * Новый провайдер — одна строка здесь (плюс `createProvider`, если протокол не
 * OpenAI-совместимый).
 */
export const OFFERED_PROVIDER_IDS: readonly string[] = ['deepseek'];

/** Пресеты, которые можно добавить, — в порядке `OFFERED_PROVIDER_IDS`. */
export function offeredProviderPresets(): ProviderPreset[] {
  return OFFERED_PROVIDER_IDS.map((id) => findProviderPreset(id)).filter(
    (preset): preset is ProviderPreset => preset !== undefined,
  );
}

/**
 * Что спрашивать в окне подключения. Ключ есть не у всех (локальный сервер его не знает),
 * поэтому «спросить ключ» — не универсальное поле, а следствие `needsKey`.
 */
export function providerConfigFields(preset: ProviderPreset): ProviderConfigField[] {
  if (preset.fields) return [...preset.fields];
  const fields: ProviderConfigField[] = ['label', 'baseUrl'];
  if (preset.needsKey) fields.push('apiKey');
  fields.push('model');
  return fields;
}

/**
 * Что мешает сохранить подключение; `null` — всё на месте. Ключ не проверяем: он может
 * быть уже сохранён в main, и окно тогда просит оставить поле пустым.
 */
export function providerConfigError(preset: ProviderPreset, values: ProviderConfigValues): string | null {
  const fields = providerConfigFields(preset);
  if (fields.includes('label') && values.label.trim() === '') return 'Название не задано';
  if (!/^https?:\/\/\S+$/i.test(values.baseUrl.trim())) {
    return 'Адрес должен начинаться с http:// или https://';
  }
  if (fields.includes('model') && values.model.trim() === '') return 'Модель не выбрана';
  return null;
}

/* ── список моделей у провайдера ─────────────────────────────────────────── */

/**
 * Разобрать ответ эндпоинта моделей. Форматов в жизни больше одного:
 *
 *   OpenAI-совместимый:    { data: [{ id: "gpt-4o" }, …] }
 *   Anthropic:             { data: [{ id: "claude-…", display_name: … }] }
 *   Ollama и часть шлюзов: { models: [{ name: "llama3" }, …] } или просто ["a", "b"]
 *
 * Раньше разбор был зашит в провайдерах и понимал только первый вид: сервер вроде
 * Ollama отвечал нормально, а в настройках было «список пуст» — и человек решал,
 * что дело в ключе или адресе. Непонятное — пустой список, а не выдуманная модель.
 */
export function parseModelIds(payload: unknown): string[] {
  const pick = (item: unknown): string => {
    if (typeof item === 'string') return item.trim();
    if (typeof item !== 'object' || item === null) return '';
    const record = item as Record<string, unknown>;
    // `id` — OpenAI и Anthropic, `name` — Ollama, `model` — часть шлюзов.
    for (const key of ['id', 'name', 'model']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  let list: unknown[] = [];
  if (Array.isArray(payload)) list = payload;
  else if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ['data', 'models']) {
      if (Array.isArray(record[key])) {
        list = record[key] as unknown[];
        break;
      }
    }
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of list) {
    const id = pick(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  // По алфавиту: список в настройках не должен прыгать между проверками.
  return ids.sort((a, b) => a.localeCompare(b));
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
  /**
   * Можно ли выключить размышление явно (`thinking: {type: 'disabled'}`).
   *
   * У моделей с размышлением по умолчанию `off` в настройках означает не «без
   * размышлений», а «ничего не сказали» — и модель думает. Если сервер умеет
   * выключать его параметром, интерфейс должен говорить правду.
   */
  thinkingToggle?: boolean;
  /**
   * Умеет ли провайдер компактное сжатие — короткое резюме вместо полного
   * пересказа. От этого зависит, есть ли смысл сжимать ради кеша: без
   * небольшого резюме префикс так и останется дорогим.
   */
  compactCapable?: boolean;
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

  // DeepSeek: размышление включено по умолчанию и усилие модель принимает, но
  // temperature в этом режиме не действует — документация говорит прямо, что
  // параметр не вызовет ошибки и не окажет эффекта. Показывать его живым было бы
  // обманом, поэтому не отправляем и объясняем почему.
  // Открытые дистилляты (`deepseek-r1`, `-distill-`) живут на других серверах и
  // температуру принимают — их пропускаем ниже, к общему правилу.
  if (name.startsWith('deepseek') && !/r1|distill/.test(name)) {
    return {
      reasoningEffort: true,
      temperature: false,
      // Размышление включено по умолчанию, но выключается явно — иначе «Без
      // размышлений» в настройках было бы надписью, за которой ничего нет.
      thinkingToggle: true,
      // Компактное сжатие — тоже свойство платформы DeepSeek, а не модели:
      // короткое резюме вместо длинного пересказа.
      compactCapable: true,
      note: 'размышление включено по умолчанию; temperature в нём не действует',
    };
  }

  // Открытые reasoning-модели: усилие принимают, температуру тоже.
  if (/thinking|qwq|qwen3|deepseek-r1|-r1-|distill|grok-3-mini|grok-4/.test(name)) {
    return { reasoningEffort: true, temperature: true };
  }

  return FULL;
}

/** Усилие доехало до провайдера только когда модель его понимает и оно не `off`. */
export function reasoningEffortFor(model: string, effort: ReasoningEffort | undefined): ReasoningEffort | undefined {
  if (!effort || effort === 'off') return undefined;
  return modelCapabilities(model).reasoningEffort ? effort : undefined;
}

/**
 * Усилие в той шкале, которую принимает провайдер.
 *
 * Наша шкала (`off|low|medium|high|max`) шире, чем у моделей. DeepSeek знает
 * только `low`, `high` и `max` и советует отображать промежуточные значения на
 * ближайшее: `medium` у него означает `high`. Отправить `medium` как есть —
 * значит получить отказ или молча потерять настройку.
 */
export function wireEffort(model: string, effort: ReasoningEffort | undefined): string | undefined {
  if (!effort || effort === 'off') return undefined;
  if (model.trim().toLowerCase().startsWith('deepseek')) {
    if (effort === 'medium') return 'high';
    if (effort === 'max') return 'max';
    return effort === 'low' ? 'low' : 'high';
  }
  return effort;
}

/**
 * Первое осмысленное число из списка: ноль и мусор пропускаем.
 *
 * Ноль — не «мало», а «не задано» (см. `maxTokens: 0` и `contextWindow`), поэтому
 * обычный `??` тут не годится: он остановился бы на нуле и спрятал следующее,
 * более точное значение — например паспорт модели от сервера.
 */
export function firstPositive(...values: ReadonlyArray<number | undefined>): number | undefined {
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return undefined;
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
  if (name.startsWith('deepseek')) return 1_000_000;
  if (name.includes('grok')) return 131_072;
  return 128_000;
}

/**
 * Сколько токенов модель может написать в одном ответе.
 *
 * Не путать с окном: вход и выход у современных моделей разной длины, и общий
 * предел в 4096 токенов обрывал ответ там, где модель готова была писать в сорок
 * раз больше. Числа — из документации вендоров; для незнакомых моделей честнее
 * вернуть скромное значение, чем обещать несуществующее.
 */
export function maxOutputTokens(model: string, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.round(override);

  const name = model.trim().toLowerCase();
  if (name.startsWith('deepseek')) return 384_000;
  if (name.includes('gemini')) return 65_536;
  if (/^(o1|o3|o4|gpt-5)/.test(name)) return 100_000;
  if (name.startsWith('claude')) return 64_000;
  return 8_192;
}

/**
 * Адрес для beta-функций провайдера.
 *
 * Строгая схема инструментов у DeepSeek работает только на `/beta`, а обычные
 * запросы — на `/v1` или на корне. Держать в настройках два адреса и объяснять
 * человеку, какой включать под какую галочку, — хуже, чем переписать адрес
 * здесь: остальные хосты не трогаем, они про `/beta` ничего не знают.
 */
export function betaBaseUrl(baseUrl: string, strict: boolean): string {
  if (!strict) return baseUrl;
  // Обычный адрес приходит с `/v1` или без пути вовсе; `/beta` уже включён.
  if (!/^https?:\/\/api\.deepseek\.com(\/(v1|beta))?\/?$/i.test(baseUrl.trim())) return baseUrl;
  return 'https://api.deepseek.com/beta';
}

/**
 * Часы пик DeepSeek в UTC: понедельник–пятница, 01:00–04:00 и 06:00–10:00.
 * Вне их провайдер берёт вдвое меньше — это не скидка по акции, а постоянный
 * тариф, и считать по пиковому всегда значит завышать счёт втрое-вчетверо.
 */
const DEEPSEEK_PEAK_HOURS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** Сейчас у DeepSeek пиковый тариф? Для прочих провайдеров — всегда «пик». */
export function isPeakTariff(model: string, at: Date = new Date()): boolean {
  if (!model.trim().toLowerCase().startsWith('deepseek')) return true;
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return DEEPSEEK_PEAK_HOURS_UTC.some(([from, to]) => hour >= from && hour < to);
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
  /** Чтение из кеша промпта: у всех, кто кеширует, дешевле обычного ввода. */
  cachedInput: number;
  /** Запись в кеш: некоторые берут за неё надбавку. */
  cacheWrite: number;
}

function price(input: number, output: number, cachedInput = input, cacheWrite = input): ModelPricing {
  return { input, output, cachedInput, cacheWrite };
}

const openAi = (input: number, output: number): ModelPricing => price(input, output, input * 0.5);

const claude = (input: number, output: number): ModelPricing => price(input, output, input * 0.1, input * 1.25);

// DeepSeek: кеш включён всегда, попадание дешевле промаха на два порядка ($0.003
// против $0.15 за 1M в непик). 0.02 — чуть осторожнее реального отношения: если
// кеш подорожает, оценка останется не в свою пользу.
const deepSeek = (input: number, output: number): ModelPricing => price(input, output, input * 0.02);

/**
 * Цена модели на конкретный момент: у DeepSeek в непиковые часы она вдвое ниже.
 *
 * Считаем по времени прогона, а не по времени отрисовки: иначе стоимость уже
 * прошедшего запроса «менялась» бы при каждом перерисовывании панели.
 */
export function pricingAt(model: string, at: Date = new Date()): ModelPricing | null {
  const base = modelPricing(model);
  if (!base || isPeakTariff(model, at)) return base;
  const half = (value: number) => value / 2;
  return {
    input: half(base.input),
    output: half(base.output),
    cachedInput: half(base.cachedInput),
    cacheWrite: half(base.cacheWrite),
  };
}

export function modelPricing(model: string): ModelPricing | null {
  const name = model.trim().toLowerCase();
  if (!name) return null;

  // OpenAI
  if (name.startsWith('gpt-4o-mini')) return openAi(0.15, 0.6);
  if (name.startsWith('gpt-4o')) return openAi(2.5, 10);
  if (name.startsWith('gpt-4.1-mini')) return openAi(0.4, 1.6);
  if (name.startsWith('gpt-4.1')) return openAi(2, 8);
  if (name.startsWith('o4-mini')) return openAi(1.1, 4.4);
  if (name.startsWith('o3')) return openAi(10, 40);
  if (name.startsWith('o1-mini')) return openAi(1.1, 4.4);
  if (name.startsWith('o1')) return openAi(15, 60);
  if (name.startsWith('gpt-5')) return openAi(1.25, 10);

  // DeepSeek: peak-тарифы; off-peak вдвое дешевле, но об этом знает только счёт.
  if (name.startsWith('deepseek-v4-pro')) return deepSeek(1.32, 3.96);
  if (name.startsWith('deepseek')) return deepSeek(0.3, 1.2);

  // Anthropic (через шлюз)
  if (name.includes('claude-opus')) return claude(15, 75);
  if (name.includes('claude-haiku')) return claude(1, 5);
  if (name.includes('claude')) return claude(3, 15);

  // Прочее из пресетов
  if (name.startsWith('llama-3.3-70b')) return price(0.59, 0.79);
  if (name.includes('qwen') && name.includes('coder')) return null; // локальные/дешёвые — цену не гадаем

  return null;
}
