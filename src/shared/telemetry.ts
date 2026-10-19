/**
 * Телеметрия прогонов: запись трассы в файл, чтобы разбирать «почему ушло не туда».
 *
 * Трасса живёт в памяти беседы (`shared/run-log.ts`) и пропадает при перезапуске,
 * а вопрос «что стояло в системных инструкциях, когда модель начала звать не тот
 * инструмент» задают обычно на следующий день. Поэтому прогон можно записать в
 * файл — журнал в пользовательских данных, по строке на прогон (JSON Lines: файл
 * растёт добавлением, а не переписыванием, и переживает падение посреди записи).
 *
 * Главное здесь — не форма записи, а то, чего в ней быть не должно: ключи и
 * пароли. В запрос к модели попадает всё, что человек приложил, а модель любит
 * повторить в ответе кусок конфига или команду с ключом — и это уехало бы в файл
 * как есть. Поэтому каждая строка проходит через вычистку, и живёт вычистка ЗДЕСЬ,
 * в чистом модуле: её надо проверять тестами, а не глазами.
 *
 * Файл лежит только на машине человека и пишется лишь тогда, когда он сам включил
 * настройку: по умолчанию телеметрии нет.
 */

import type { ChatRunTrace } from './api';
import type { ChatRunLog, RunCallLog, RunStepLog, RunSubagentLog, RunSystemLog } from './run-log';
import type { PermissionPreset } from './permissions';

/** Потолок одного текстового поля в записи: подробности нужны, мегабайты — нет. */
export const MAX_TELEMETRY_FIELD = 2000;
/** Потолок всей записи: одна строка журнала не должна весить больше этого. */
export const MAX_TELEMETRY_RECORD = 200_000;
/** Версия формата: по ней видно, что старые строки журнала читаются по-старому. */
export const TELEMETRY_VERSION = 1;
/** Чем заменяем найденный секрет. Коротко и однозначно: это метка, а не текст. */
const HIDDEN = '[скрыто]';

/** Одна пара «что искать» → «на что заменить». */
interface SecretRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * Правила вычистки. Порядок важен: сначала то, что узнаётся по форме (блок ключа
 * целиком, знакомый префикс), потом общее правило «имя = значение».
 *
 * Список намеренно склонён скрыть лишнее: спрятать безобидную строку дешевле, чем
 * оставить в журнале чужой ключ. Обычный текст при этом не страдает — правила
 * цепляются за формы, которых в прозе не бывает.
 */
const SECRET_RULES: readonly SecretRule[] = [
  // Приватный ключ целиком: от `BEGIN` до `END`, вместе с телом.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[приватный ключ скрыт]',
  },
  // Ключи с узнаваемым префиксом: OpenAI, GitHub, Slack, Google, AWS, Stripe.
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: `sk-${HIDDEN}` },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: `ghp_${HIDDEN}` },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: `github_pat_${HIDDEN}` },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: `xox-${HIDDEN}` },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: `AIza${HIDDEN}` },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: `AKIA${HIDDEN}` },
  { pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, replacement: `sk_live_${HIDDEN}` },
  // `Authorization: Bearer <хвост>` — в заголовках и в curl-командах.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${HIDDEN}` },
  // Пароль в адресе: `https://user:пароль@host`.
  { pattern: /(:\/\/[^\s/:@]+:)[^\s/@]+(@)/g, replacement: `$1${HIDDEN}$2` },
  // Общее правило: имя похоже на ключ, дальше разделитель и значение.
  {
    pattern:
      /\b((?:[A-Za-z0-9]+[_.-])*(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|credential|authorization)[A-Za-z0-9_.-]*\b["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{4,})/gi,
    replacement: `$1${HIDDEN}`,
  },
  // Те же имена в JSON: `"token": "значение"`.
  {
    pattern:
      /(["'](?:[A-Za-z0-9]+[_.-])*(?:api[_-]?key|secret|token|password|credential)[A-Za-z0-9_.-]*["']\s*:\s*")([^"]{4,})(")/gi,
    replacement: `$1${HIDDEN}$3`,
  },
];

/** Вычистить секреты из текста. Пустая строка остаётся пустой. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const rule of SECRET_RULES) result = result.replace(rule.pattern, rule.replacement);
  return result;
}

/** Обрезка без разрезания символа: половина эмодзи в журнале — битый текст. */
function clip(text: string, limit = MAX_TELEMETRY_FIELD): string {
  if (text.length <= limit) return text;
  return `${Array.from(text).slice(0, limit).join('')}…`;
}

/** Текст поля: вычистить и обрезать. Одна операция, чтобы не забыть половину. */
function clean(text: string | undefined, limit = MAX_TELEMETRY_FIELD): string | undefined {
  if (text === undefined) return undefined;
  return clip(redactSecrets(text), limit);
}

/** Один прогон в журнале. Форма близка к трассе, но подробности урезаны. */
export interface RunTelemetryRecord {
  version: number;
  /** Когда прогон кончился (epoch мс). Начало — в `startedAt`. */
  at: number;
  startedAt: number;
  /** Беседа, в которой шёл прогон: по ней строки журнала собираются вместе. */
  conversation?: string;
  /** Корень проекта. */
  project?: string;
  provider: string;
  model: string;
  mode: RunSystemLog['mode'];
  permission: PermissionPreset;
  finished: ChatRunLog['finished'];
  /** Сколько длился прогон целиком, мс. */
  ms: number;
  /** Итоговые числа того же вида, что в следе беседы. */
  trace: ChatRunTrace;
  /** Что ушло модели: инструкции, контекст, вложения, состав инструментов. */
  system: RunSystemLog;
  /** Шаги с вызовами — вычищенные и урезанные. */
  steps: RunStepLog[];
  subagents?: RunSubagentLog[];
  /** Схемы аргументов инструментов, которыми пользовался прогон. */
  schemas?: Record<string, string>;
  /** Запись пришлось укоротить, чтобы влезть в потолок. */
  clipped?: boolean;
}

export interface RunTelemetryInput {
  /** Беседа: подряд может идти несколько прогонов одной беседы. */
  conversation?: string;
  /** Корень проекта на момент прогона. */
  project?: string;
  /** Момент окончания; по умолчанию — «сейчас». */
  at?: number;
}

/** Один вызов: аргументы и результат вычищены и обрезаны. */
function cleanCall(call: RunCallLog, limit: number): RunCallLog {
  const args = clean(call.args, limit);
  const detail = clean(call.detail, limit);
  return {
    ...call,
    ...(args !== undefined ? { args } : {}),
    summary: clean(call.summary, limit) ?? '',
    ...(detail !== undefined ? { detail } : {}),
  };
}

function cleanStep(step: RunStepLog, limit: number): RunStepLog {
  const text = clean(step.text, limit);
  const reasoning = clean(step.reasoning, limit);
  return {
    ...step,
    ...(text !== undefined ? { text } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    calls: step.calls.map((call) => cleanCall(call, limit)),
  };
}

function cleanSystem(system: RunSystemLog): RunSystemLog {
  const instructions = clean(system.instructions);
  const context = clean(system.context);
  const goal = clean(system.goal);
  return {
    ...system,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(system.attachments ? { attachments: system.attachments.map((item) => redactSecrets(item)) } : {}),
  };
}

/** Вес записи в символах сериализации: та же мера, что уходит в файл. */
function sizeOf(record: RunTelemetryRecord): number {
  return JSON.stringify(record).length;
}

/**
 * Собрать запись журнала из трассы прогона.
 *
 * Три прохода по размеру: сначала подробности инструментов (самое тяжёлое и самое
 * ненужное), потом тексты шагов, потом схемы. Содержание, ради которого журнал и
 * заводят — системные инструкции и контекст проекта — остаётся до последнего:
 * без них разбирать прогон бессмысленно.
 */
export function buildRunRecord(run: ChatRunLog, input: RunTelemetryInput = {}): RunTelemetryRecord {
  const record: RunTelemetryRecord = {
    version: TELEMETRY_VERSION,
    at: input.at ?? Date.now(),
    startedAt: run.startedAt,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.project ? { project: input.project } : {}),
    provider: run.system.provider,
    model: run.system.model,
    mode: run.system.mode,
    permission: run.system.permission,
    finished: run.finished,
    ms: run.ms,
    trace: run.trace,
    system: cleanSystem(run.system),
    steps: run.steps.map((step) => cleanStep(step, MAX_TELEMETRY_FIELD)),
    ...(run.subagents
      ? { subagents: run.subagents.map((item) => ({ ...item, description: redactSecrets(item.description) })) }
      : {}),
    ...(run.schemas
      ? {
          schemas: Object.fromEntries(
            Object.entries(run.schemas).map(([name, schema]) => [name, clip(redactSecrets(schema))]),
          ),
        }
      : {}),
  };

  // Первый замер: обычно всё влезает, и дальше ничего не делаем.
  if (sizeOf(record) <= MAX_TELEMETRY_RECORD) return record;

  // Подробности вызовов — первое, что уходит: аргументы и сводка остаются.
  record.steps = record.steps.map((step) => ({
    ...step,
    calls: step.calls.map(({ detail: _dropped, ...rest }) => rest),
  }));
  record.clipped = true;
  if (sizeOf(record) <= MAX_TELEMETRY_RECORD) return record;

  // Второй проход: тексты шагов и вызовов — до короткой цитаты.
  record.steps = record.steps.map((step) => cleanStep(step, 400));
  if (sizeOf(record) <= MAX_TELEMETRY_RECORD) return record;

  // Последнее, что можно отдать: схемы. Инструкции и контекст не трогаем.
  delete record.schemas;
  return record;
}

/** Строка журнала: одна запись, без переводов строк внутри (JSON их экранирует). */
export function formatTelemetryLine(record: RunTelemetryRecord): string {
  return JSON.stringify(record);
}

/**
 * Разобрать журнал. Битая строка пропускается, а не роняет чтение: файл могли
 * дописывать в момент падения, и одна порченая строка не повод потерять остальные.
 */
export function parseTelemetry(text: string): RunTelemetryRecord[] {
  const records: RunTelemetryRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed) as RunTelemetryRecord;
      if (typeof value?.at !== 'number') continue;
      records.push(value);
    } catch {
      // Строка порвана (падение посреди записи) — пропускаем её и читаем дальше.
    }
  }
  return records;
}

/** Время строки журнала: дата и время местные — по ним строку ищут глазами. */
function clockOf(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Итог прогона словом: чем кончился — ответом, лимитом шагов или обрывом. */
export function finishedLabel(finished: ChatRunLog['finished']): string {
  switch (finished) {
    case 'answer':
      return 'ответ';
    case 'limit':
      return 'лимит шагов';
    case 'aborted':
      return 'прерван';
  }
}

/** «820 мс», «12 с», «5 м 24 с» — без десятых: важен порядок, а не точность. */
function formatTaken(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} м ${rest} с` : `${minutes} м`;
}

/** Подпись строки журнала: время, режим, модель, длительность, шаги и итог. */
export function describeRecord(record: RunTelemetryRecord): string {
  const steps = record.trace.steps || record.steps.length;
  const parts = [
    clockOf(record.at),
    record.mode,
    `${record.provider}/${record.model}`,
    formatTaken(record.ms),
    `${steps} ш.`,
    `${record.trace.toolCalls} в.`,
    finishedLabel(record.finished),
  ];
  if (record.clipped) parts.push('укорочено');
  return parts.join(' · ');
}
