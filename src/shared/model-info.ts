import type { ReasoningEffort } from './api';

/**
 * Паспорт модели из `GET /models`.
 *
 * Сервер сам рассказывает, сколько токенов вмещает окно, сколько может быть в
 * ответе, что модель принимает на вход и какие уровни усилия понимает. Держать
 * эти числа таблицей в коде — значит отставать от провайдера на каждое его
 * обновление: у DeepSeek окно выросло с 64K до 1M, а у нас оставалось 64K.
 *
 * Все поля необязательны: строгий OpenAI-совместимый сервер отдаёт только `id`,
 * и тогда в дело вступают догадки по имени модели (см. `shared/providers.ts`).
 */
export interface ModelInfo {
  id: string;
  /** Человеческое имя для списков: `DeepSeek-V4.1-Flash`. */
  name?: string;
  /** Полная ёмкость окна — вход и выход вместе. */
  contextWindow?: number;
  /** Предел одного ответа: максимально допустимое `max_tokens`. */
  maxOutputTokens?: number;
  /** Что модель принимает на вход: `text`, `image`. */
  inputModalities?: readonly string[];
  /** Уровни усилия размышления, которые сервер принимает. */
  effortLevels?: readonly string[];
  /** Усилие по умолчанию, когда параметр не передан. */
  defaultEffort?: string;
}

function positive(value: unknown): number | undefined {
  const num = Math.round(Number(value));
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function texts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return list.length > 0 ? list : undefined;
}

/** Один элемент ответа: полный паспорт или просто строка с именем модели. */
export function parseModelInfo(raw: unknown): ModelInfo | null {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as Record<string, unknown>;
  // `id` — OpenAI и DeepSeek, `name` — Ollama, `model` — часть шлюзов.
  let id = '';
  for (const key of ['id', 'model']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      id = value.trim();
      break;
    }
  }
  if (!id && typeof record.name === 'string') id = record.name.trim();
  if (!id) return null;

  const info: ModelInfo = { id };
  // `name` у DeepSeek — подпись, у Ollama — сам id: второе уже есть в `id`.
  if (typeof record.name === 'string' && record.name.trim() && record.name.trim() !== id) {
    info.name = record.name.trim();
  }
  const window = positive(record.context_window);
  if (window) info.contextWindow = window;
  const output = positive(record.max_output_tokens);
  if (output) info.maxOutputTokens = output;
  const inputs = texts(record.input_modalities);
  if (inputs) info.inputModalities = inputs;
  const effort = (record.effort ?? null) as Record<string, unknown> | null;
  if (effort && typeof effort === 'object') {
    const levels = texts(effort.supported_levels);
    if (levels) info.effortLevels = levels;
    if (typeof effort.default_level === 'string' && effort.default_level.trim()) {
      info.defaultEffort = effort.default_level.trim();
    }
  }
  return info;
}

/** Ответ `/models` целиком. Формы разные: массив, `data`, `models`. */
export function parseModelInfos(payload: unknown): ModelInfo[] {
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

  const infos: ModelInfo[] = [];
  for (const item of list) {
    const info = parseModelInfo(item);
    if (info) infos.push(info);
  }
  return infos;
}

/** Паспорт по имени модели; `undefined`, если сервер о ней ничего не сказал. */
export function findModelInfo(
  models: readonly ModelInfo[] | undefined,
  model: string,
): ModelInfo | undefined {
  const name = model.trim().toLowerCase();
  if (!name) return undefined;
  return models?.find((item) => item.id.toLowerCase() === name);
}

/** Принимает ли модель картинки. Неизвестно — считаем, что да: запрет врёт хуже. */
export function acceptsImages(info: ModelInfo | undefined): boolean {
  if (!info?.inputModalities) return true;
  return info.inputModalities.includes('image');
}

/**
 * Уровни усилия, которые сервер действительно принимает.
 *
 * Наш общий набор шире (`off`, `low`, `medium`, `high`): сервер может знать
 * только `low/high/max`. Возвращаем пересечение — отправлять уровень, которого
 * нет в паспорте, значит получить 400 вместо ответа.
 */
export function supportedEfforts(info: ModelInfo | undefined): ReasoningEffort[] | undefined {
  if (!info?.effortLevels) return undefined;
  const known: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];
  const allowed = known.filter((level) => info.effortLevels?.includes(level));
  return allowed.length > 0 ? allowed : undefined;
}
