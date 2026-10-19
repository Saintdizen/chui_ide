/**
 * `run_code`: программа вместо десятка вызовов инструментов.
 *
 * Обычно агент ходит к модели за каждым шагом: прочитать файл, найти совпадение,
 * взять ещё три файла — это три оборота, три раза оплаченный контекст и три раза
 * пересказанные результаты. Здесь он пишет одну программу, где инструменты —
 * обычные функции, а перебор, фильтрация и склейка делаются кодом.
 *
 * Модуль чистый: что считается допустимой программой, как выглядит её файл, как
 * читается ответ. Запуск (отдельный процесс, права, обрыв) живёт в main —
 * `ai/run-code.ts`, и проверяется отдельно.
 *
 * Программа — обычный **JavaScript** (ESM без импортов): так она исполняется
 * любым Node без сборки и стирания типов, а ошибка видна моделью сразу, а не
 * после транспиляции.
 */

/** Потолок исходника программы: длиннее — это уже не вызов инструмента. */
export const RUN_CODE_MAX_CHARS = 20_000;
/** Сколько вызовов инструментов программа может сделать за запуск. */
export const RUN_CODE_MAX_CALLS = 80;
/** Сколько ждём программу по умолчанию и сколько — по просьбе модели. */
export const RUN_CODE_DEFAULT_TIMEOUT_MS = 120_000;
export const RUN_CODE_MAX_TIMEOUT_MS = 300_000;
/** Сколько текста результата отдаём модели. */
export const RUN_CODE_MAX_RESULT = 8_000;
/** Сколько строк вывода программы отдаём модели. */
export const RUN_CODE_MAX_LOGS = 8_000;

/**
 * Инструменты, которые программа не зовёт.
 *
 * `run_code` — сама себя (рекурсия съела бы и время, и контекст). `ask` —
 * вопрос человеку: программа ждала бы ответа, а человек в этот момент видел бы
 * только крутящуюся карточку. `update_plan` и `update_goal` — состояние беседы,
 * а не действие: его разбирает service, и из программы оно ничего не поменяет.
 * `read_image` — картинка уходит модели отдельным сообщением прогона, а из
 * программы такого сообщения нет: она получила бы текст «картинку отправили»,
 * которой модель не видит. `workflow` — сценарий с агентами: у него свой запуск и
 * свои пределы (`shared/workflow.ts`), внутри программы ему делать нечего.
 */
const DENIED_IN_PROGRAM = new Set([
  'run_code',
  'workflow',
  'ask',
  'update_plan',
  'update_goal',
  'exit_plan_mode',
  'read_image',
]);

/** Можно ли звать этот инструмент изнутри программы. */
export function runCodeToolAllowed(name: string): boolean {
  return !DENIED_IN_PROGRAM.has(name);
}

/**
 * Что не так с программой — или `null`, если она годится. Проверка до запуска:
 * пустой ответ модели иначе выглядел бы как «программа ничего не сделала».
 */
export function programProblem(source: string): string | null {
  const text = source.trim();
  if (!text) return 'Программа пустая: нужен JavaScript с вызовами tools.<имя>(args).';
  if (text.length > RUN_CODE_MAX_CHARS) {
    return `Программа слишком длинная: ${text.length} символов при пределе ${RUN_CODE_MAX_CHARS}.`;
  }
  // Динамический `import('node:fs')` — законная часть программы, а объявления
  // `import x from …` и `export …` на верхнем уровне внутри функции невозможны.
  if (/^\s*(export\s|import\s+[\w{*'"])/m.test(text)) {
    return (
      'Программа — это тело функции, а не модуль: `import` и `export` в ней не нужны. ' +
      'Инструменты уже лежат в `tools`, а результат возвращается через `return`.'
    );
  }
  return null;
}

/** Что исполняется в отдельном процессе: программа с инструментами или сценарий с агентами. */
export type ProgramMode = 'code' | 'workflow';

/**
 * Файл программы: тело функции, которому обвязка отдаёт контекст.
 *
 * Обёртка даёт то, что модели привычно: `await` на верхнем уровне и `return`
 * результата. В контексте два имени: `tools` (вызовы инструментов в `run_code`) и
 * `agents` (подчинённые агенты в `workflow`). Одно из них всегда `undefined`:
 * сценарий не зовёт инструментов, а программа не раздаёт работу агентам. Разметку
 * контекста типами не описываем — это JavaScript, и лишняя строка в файле только
 * сдвигала бы номера в стеке ошибки.
 */
export function programModule(source: string, program: ProgramMode = 'code'): string {
  const title =
    program === 'workflow'
      ? '// Сгенерировано chui_iDE для инструмента workflow: тело сценария агента.'
      : '// Сгенерировано chui_iDE для инструмента run_code: тело программы агента.';
  return `${title}\nexport default async function (context) {\nconst { tools, agents } = context;\n${source}\n}\n`;
}

/** Один вызов инструмента из программы: что звали, чем кончилось, сколько заняло. */
export interface RunCodeCall {
  name: string;
  ok: boolean;
  summary: string;
  ms: number;
}

/** Один агент, которого запустил сценарий (`workflow`): кто, чем кончилось, сколько заняло. */
export interface RunCodeAgentCall {
  description: string;
  ok: boolean;
  summary: string;
  ms: number;
}

/** Чем кончился запуск программы. */
export interface RunCodeOutcome {
  /** Значение, которое вернула программа (уже строкой). */
  value?: string;
  /** Что программа напечатала через console. */
  logs: string;
  /** Вызовы инструментов по порядку. */
  calls: readonly RunCodeCall[];
  ms: number;
  /** Программа не уложилась в отведённое время. */
  timedOut: boolean;
  /** Что-то не поместилось: результат, вывод или сами вызовы. */
  truncated: boolean;
  /** Программа упала: причина и стек. */
  error?: string;
  stack?: string;
  /** Вызовов больше предела: остальные получили отказ. */
  callsExceeded?: boolean;
  /** Сценарий (`workflow`): запущенные агенты по порядку. */
  agents?: readonly RunCodeAgentCall[];
  /** Агентов больше предела: остальные не запускались. */
  agentsExceeded?: boolean;
}

/** Текст под потолок — без разрезания символа (кириллица, эмодзи). */
export function clampProgramText(text: string, limit = RUN_CODE_MAX_RESULT): { text: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= limit) return { text, truncated: false };
  return { text: `${points.slice(0, limit).join('')}…`, truncated: true };
}

/** Склонение: «1 вызов», «2 вызова», «5 вызовов». */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${count} ${word}`;
}

/** Длительность коротко: «820 мс», «12 с», «1 м 20 с». */
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} м ${rest} с` : `${minutes} м`;
}

/**
 * Сводка по вызовам: «5 вызовов: read_file ×3, search ×2».
 * Числа вместо перечисления подряд — в карточке видно, на что ушла программа.
 */
export function summarizeCalls(calls: readonly RunCodeCall[]): string {
  if (calls.length === 0) return 'без вызовов инструментов';
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const failed = calls.filter((call) => !call.ok).length;
  const tail = failed > 0 ? `, с ошибкой ${failed}` : '';
  return `${plural(calls.length, 'вызов', 'вызова', 'вызовов')}: ${parts.join(', ')}${tail}`;
}

/**
 * Ответ инструмента: сводка для карточки и разбор для модели.
 *
 * Порядок не случайный: сперва что сделала программа (по вызовам), потом её
 * ответ, потом её вывод. Модель читает сверху вниз и на результате останавливается.
 */
export function formatRunCode(outcome: RunCodeOutcome): { summary: string; detail: string } {
  const head: string[] = [];

  if (outcome.error) {
    head.push(`Программа упала: ${outcome.error}`);
  } else if (outcome.timedOut) {
    head.push('Программа не уложилась в отведённое время и была остановлена.');
  } else {
    head.push(`Программа отработала за ${duration(outcome.ms)}: ${summarizeCalls(outcome.calls)}.`);
  }

  if (outcome.callsExceeded) {
    head.push(`Вызовов больше предела: остальные получили отказ. Собери программу короче.`);
  }
  if (outcome.truncated) head.push('Часть ответа не показана — она не поместилась в потолок.');

  const parts: string[] = [head.join(' '), ''];

  if (outcome.calls.length > 0) {
    parts.push('Вызовы программы:');
    for (const [index, call] of outcome.calls.entries()) {
      parts.push(`${index + 1}. ${call.ok ? '' : '✗ '}${call.name} — ${call.summary} (${duration(call.ms)})`);
    }
    parts.push('');
  }

  if (outcome.value !== undefined) {
    parts.push('Что вернула программа:', outcome.value === '' ? '(пусто)' : outcome.value, '');
  }

  if (outcome.logs) {
    parts.push('Вывод программы (console):', outcome.logs, '');
  }

  if (outcome.error && outcome.stack) {
    parts.push('Стек:', outcome.stack, '');
  }

  if (outcome.error) {
    parts.push('Исправь программу и вызови run_code снова — или сделай это обычными инструментами.');
  } else {
    parts.push('Это ответ программы, а не пересказ: подробности выше уже проверены её вызовами.');
  }

  const summary = outcome.error
    ? `run_code: ошибка — ${outcome.error.slice(0, 140)}`
    : outcome.timedOut
      ? `run_code: остановлена по времени (${summarizeCalls(outcome.calls)})`
      : `run_code: ${summarizeCalls(outcome.calls)} за ${duration(outcome.ms)}`;

  return { summary, detail: parts.join('\n').trimEnd() };
}
