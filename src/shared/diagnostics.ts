/**
 * Формат журнала сбоев и правило «о чём сообщать».
 *
 * Живёт в `shared`, а не в main: журнал читает человек, когда приложение уже
 * не работает, и формат записи стоит закрепить тестом, не поднимая Electron.
 */

export interface DiagnosticEntry {
  /** Кто сообщил: `main/uncaughtException`, `renderer/render-process-gone` и т. п. */
  source: string;
  /** Суть в одну строку: сообщение ошибки или причина падения процесса. */
  message: string;
  /** Подробности — стек, код выхода. Каждый элемент уходит отдельной строкой. */
  details?: readonly string[];
  /** Момент события. Параметр, а не `new Date()` внутри: иначе формат не проверить. */
  at: Date;
}

/** Одна запись журнала: шапка с временем и источником, дальше — подробности с отступом. */
export function formatDiagnostic(entry: DiagnosticEntry): string {
  const head = `[${entry.at.toISOString()}] ${entry.source}: ${entry.message}`;
  const details = (entry.details ?? [])
    // Пустые строки в стеке (между кадрами) только раздувают журнал.
    .filter((line) => line.trim() !== '')
    // Отступ задаём сами, а не наследуем из стека: так подробности выровнены
    // одинаково, независимо от того, кто их принёс.
    .map((line) => `  ${line.trim()}`);
  return [head, ...details].join('\n');
}

/**
 * Бросить можно что угодно: Error, строку, объект, число. И то, и другое должно
 * превратиться в текст — иначе запись в журнале окажется пустой.
 */
export function describeError(error: unknown): { message: string; details: string[] } {
  if (error instanceof Error) {
    const message = `${error.name}: ${error.message}`;
    const stack = (error.stack ?? '').split('\n').filter((line) => line.trim() !== '');
    // Первая строка стека повторяет сообщение («Error: …») — в шапке оно уже есть.
    const details = stack[0] === message ? stack.slice(1) : stack;
    return { message, details };
  }
  return { message: stringify(error), details: [] };
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    // Круговые ссылки: JSON.stringify бросает, а показать хоть что-то нужно.
    return String(value);
  }
}

/**
 * Обычные причины завершения процесса: окно закрыли, процесс сняли по нашей же
 * просьбе. Писать о них в журнал и уж тем более звать человека нечем.
 * Всё прочее — `crashed`, `oom`, `launch-failed`, `abnormal-exit` — уже сбой.
 */
const QUIET_EXIT_REASONS = new Set(['clean-exit', 'killed']);

export function isQuietExit(reason: string): boolean {
  return QUIET_EXIT_REASONS.has(reason);
}
