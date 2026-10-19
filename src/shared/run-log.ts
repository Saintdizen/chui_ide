/**
 * Трасса прогона агента: что ушло модели, что она сделала и сколько это заняло.
 *
 * Карточки в ленте показывают вызовы по одному и только по ходу дела. Вопрос
 * «почему прогон стоил минуту и сорок тысяч токенов» по ним не решается: видно
 * каждый шаг, но не видно целого — сколько было шагов, где время, что именно
 * стояло в системных инструкциях.
 *
 * Здесь структура этой трассы и её подписи. Собирает трассу main (он один знает
 * настоящие системные сообщения, состав инструментов и время шага), показывает
 * renderer. Модуль чистый — поэтому проверяется без модели и без окна.
 *
 * Потолки здесь не украшение: один шаг может нести мегабайт вывода инструмента,
 * а окно всё равно покажет несколько экранов. Обрезаем на записи, в самом
 * прогоне, чтобы трасса не съедала память беседы.
 */

import type { ChatRunTrace, ChatUsage } from './api';
import type { PermissionPreset } from './permissions';

/** Потолок текста в одном поле трассы (аргументы, результат, ответ шага). */
export const MAX_RUN_FIELD = 4000;
/** Больше шагов трасса не держит: это уже не прогон, а цикл без выхода. */
export const MAX_RUN_STEPS = 60;
/** Больше вызовов в одном шаге не запоминаем — остальные считаются числом. */
export const MAX_RUN_CALLS_PER_STEP = 40;

/** Один вызов инструмента. */
export interface RunCallLog {
  id: string;
  name: string;
  /** Сырые аргументы, как их прислала модель (JSON-строка). */
  args: string;
  ok: boolean;
  summary: string;
  detail?: string;
  /** Сколько вызов работал, мс. */
  ms?: number;
  /**
   * Пометка «на самом деле не исполнялся»: повтор, уже прочитанный диапазон,
   * отказ режима плана. В трассе это важно: вызов был, а времени не занял.
   */
  note?: string;
}

/** Один шаг «модель думает → зовёт инструменты». */
export interface RunStepLog {
  /** Номер шага с единицы: так его называют в подписях. */
  index: number;
  /** Сколько длился шаг (ожидание модели плюс исполнение её вызовов). */
  ms: number;
  /** Что модель сказала на этом шаге. Пусто, если она сразу позвала инструменты. */
  text?: string;
  /** Размышления шага, если модель их вернула. */
  reasoning?: string;
  calls: RunCallLog[];
  /** Сколько вызовов шага не поместилось в трассу. */
  hiddenCalls?: number;
  /** Почему шаг необычный: продолжение по цели, остановка на повторах. */
  note?: string;
  /** Расход шага, если провайдер его сообщил. */
  usage?: ChatUsage;
}

/** Что именно ушло модели: инструкции, контекст проекта, рамка запроса. */
export interface RunSystemLog {
  /** Системный промпт из настроек. */
  instructions?: string;
  /** Контекст проекта: карта, правила, каталог навыков. */
  context?: string;
  /** Приложенное человеком: вид и подпись, без самого текста. */
  attachments?: string[];
  provider: string;
  model: string;
  /** Режим, в котором шёл прогон. */
  mode: 'question' | 'agent' | 'plan';
  permission: PermissionPreset;
  /** Сколько инструментов было предложено и сколько заняли их описания. */
  tools: number;
  toolsTokens?: number;
  /** Цель работы, если она была открыта. */
  goal?: string;
}

/** Подзадача (`task`): у неё свой контекст, поэтому в трассу она входит числом. */
export interface RunSubagentLog {
  description: string;
  steps: number;
  toolCalls: number;
}

export interface ChatRunLog {
  startedAt: number;
  /** Сколько длился прогон целиком. */
  ms: number;
  steps: RunStepLog[];
  system: RunSystemLog;
  subagents?: RunSubagentLog[];
  /** Чем кончилось: ответом, лимитом шагов или обрывом. */
  finished: 'answer' | 'limit' | 'aborted';
  trace: ChatRunTrace;
}

/** Обрезка текста по потолку — без разрезания символа (он может быть не ASCII). */
export function clampRunText(text: string, limit = MAX_RUN_FIELD): string {
  if (text.length <= limit) return text;
  // `Array.from` режет по кодовым точкам: половина эмодзи в трассе — битый текст.
  return `${Array.from(text).slice(0, limit).join('')}…`;
}

/**
 * Длительность словами: «820 мс», «12 с», «5 м 24 с», «1 ч 05 м».
 *
 * Часы и минуты без десятых: трасса нужна, чтобы понять порядок («на что ушла
 * минута»), а не измерять с точностью до миллисекунды.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes} м ${rest} с` : `${minutes} м`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} ч ${String(restMinutes).padStart(2, '0')} м` : `${hours} ч`;
}

/** Итог прогона одной строкой: «5 м 24 с · 6 шагов · 14 вызовов · 41 тыс. токенов». */
export function describeRun(log: ChatRunLog): string {
  // Шаги берём из следа, а не из списка трассы: подзадача идёт своим контекстом и
  // в список не попадает, но её шаги прогон всё равно сделал — и они стоили денег.
  const steps = log.trace.steps > 0 ? log.trace.steps : log.steps.length;
  const parts = [formatDuration(log.ms), plural(steps, 'шаг', 'шага', 'шагов')];
  const calls = log.trace.toolCalls;
  if (calls > 0) parts.push(plural(calls, 'вызов', 'вызова', 'вызовов'));
  const tokens = (log.trace.usage.promptTokens ?? 0) + (log.trace.usage.completionTokens ?? 0);
  if (tokens > 0) parts.push(`${formatThousands(tokens)} токенов`);
  return parts.join(' · ');
}

/** Русское склонение: 1 шаг, 2 шага, 5 шагов. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${count} ${word}`;
}

/** Тысячи с неразрывным пробелом: число читается, а не считается по разрядам. */
function formatThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

/**
 * Полное ли поле: нужно ли показывать «показано не всё». Подпись считается по
 * той же трассе, поэтому врать не может.
 */
export function runTruncated(log: ChatRunLog): boolean {
  if (log.steps.some((step) => step.hiddenCalls && step.hiddenCalls > 0)) return true;
  return log.steps.some((step) => (step.text ?? '').endsWith('…') || (step.reasoning ?? '').endsWith('…'));
}
