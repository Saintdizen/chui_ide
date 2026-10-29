import type { ChatRunLog, RunCallLog, RunStepLog } from './run-log';
import { callOverlaps, repeatedCallIndexes, type CallOverlapKind } from './call-overlaps';

/**
 * Счётчик шагов: выжимка прогона без единого слова переписки.
 *
 * Зачем отдельно от телеметрии. Полный журнал (`runs.jsonl`) пишется только по
 * включённой настройке: в нём инструкции, контекст проекта и ответы модели, то есть
 * чтение чужой переписки. Из-за этого все замеры до сих пор считались по `chats/*.json`,
 * где от прогона остались только итоги (`steps`, `toolCalls`, `usage`) — по шагам и
 * вызовам там нет ничего, и любая правка инструментов проверялась «на глаз».
 *
 * Здесь обратное: ни одного текста, только имена инструментов, числа и наши же
 * короткие пометки. Такую строку можно писать всегда — она не пересказывает беседу
 * и не требует согласия человека. Отсюда и правило модуля: **в записи нет полей
 * с текстом модели**. Появилось такое поле — запись перестала быть счётчиком.
 *
 * Цена вывода считается в символах: перевод в токены зависит от модели, а доля
 * инструмента в выводе — нет. Символы умножаются на 0,25 только при выводе отчёта
 * (`scripts/step-report.ts`), и там это подписано.
 */

/** Версия формата: разбор не должен молча читать чужую раскладку полей. */
export const STEP_COUNTS_VERSION = 1;

/**
 * Пометки о форме вызова. Считаются по аргументам, но текст аргументов в запись
 * не попадает: остаётся только вывод «вызов был такой формы».
 */
export type CallFlag =
  /** Команда терминала начинается с `cd <абсолютный путь> &&` — работать есть `cwd`. */
  | 'cd'
  /** Чтение файла через шелл (`cat`/`sed`/`grep`…) вместо `read`/`search`. */
  | 'shell-read'
  /** `read` целого файла: самый дорогой вид чтения. */
  | 'whole-read'
  /** `read` сразу нескольких файлов (`paths`): дешевле по шагам, дороже по символам. */
  | 'paths'
  /** Вызов с теми же именем и аргументами уже был в этом шаге. */
  | 'repeat';

export interface RunCountCall {
  name: string;
  ok: boolean;
  /** Сколько символов занял результат вызова (summary + detail). */
  chars: number;
  ms?: number;
  /** Пометка сервиса о необычном вызове («повтор», «пропущено») — наша, не модели. */
  note?: string;
  flags?: CallFlag[];
  /** Код причины отказа — только наша пометка, без текста аргументов. */
  reason?: CallFailureReason;
}

export interface RunCountStep {
  /** Номер шага в прогоне, с нуля. */
  i: number;
  ms: number;
  /** Оценка цены вывода шага в токенах, как её посчитала трасса. */
  out?: number;
  /** Сколько вызовов шага не поместилось в трассу (считаны числом). */
  hiddenCalls?: number;
  note?: string;
  usage?: { prompt: number; cached: number; output: number; cacheCreation: number };
  calls: RunCountCall[];
  /** Смысловые пересечения соседних вызовов шага, без текста аргументов. */
  overlaps?: { a: number; b: number; kind: CallOverlapKind }[];
}

export interface RunCountsRecord {
  version: number;
  /** Когда прогон закончился. */
  at: number;
  /** Когда начался: по нему прогоны склеиваются в беседу при разборе. */
  startedAt: number;
  conversation?: string;
  provider: string;
  model: string;
  mode: string;
  permission: string;
  finished: string;
  ms: number;
  /** Итоги прогона — те же числа, что видит лента (`ChatRunTrace`). */
  trace: {
    steps: number;
    toolCalls: number;
    prompt: number;
    cached: number;
    output: number;
    cacheCreation: number;
  };
  steps: RunCountStep[];
}

export interface CountsInput {
  /** Момент записи; в проверках подставляется фиксированный. */
  at?: number;
  conversation?: string;
}

/** Код причины отказа: наши короткие пометки, а не текст модели. */
export type CallFailureReason =
  /** Не хватает обязательного аргумента или не сошлась форма/допустимые значения. */
  | 'arg'
  /** Инструмент с `action` получил значение, которого нет в перечне. */
  | 'action'
  /** Мост или служба не подключены (LSP, линтер, MCP, окно редактора). */
  | 'unavailable'
  /** Файл/папка не найдены или язык не распознан. */
  | 'not-found'
  /** Команда упала: ненулевой код выхода или сигнал. */
  | 'command'
  /** Отказ подтверждения или ограничение прав/режима плана. */
  | 'permission'
  /** Правка по якорю не сошлась: якорь не найден, не применена, ничего не заменено. */
  | 'anchor'
  /** Человек отклонил правки, вопрос или подтверждение. */
  | 'rejected'
  | 'other';

/** Собрать счётчик прогона. Текстов модели в записи не остаётся — только числа. */
export function buildCountsRecord(run: ChatRunLog, input: CountsInput = {}): RunCountsRecord {
  const steps = run.steps.map(countStep);
  const usage = run.trace?.usage ?? {};
  return {
    version: STEP_COUNTS_VERSION,
    at: input.at ?? Date.now(),
    startedAt: run.startedAt,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    provider: run.system.provider,
    model: run.system.model,
    mode: run.system.mode,
    permission: run.system.permission,
    finished: run.finished,
    ms: run.ms,
    trace: {
      steps: run.trace?.steps ?? steps.length,
      toolCalls: run.trace?.toolCalls ?? steps.reduce((sum, step) => sum + step.calls.length, 0),
      prompt: usage.promptTokens ?? 0,
      cached: usage.cachedTokens ?? 0,
      output: usage.completionTokens ?? 0,
      cacheCreation: usage.cacheCreationTokens ?? 0,
    },
    steps,
  };
}

function countStep(step: RunStepLog): RunCountStep {
  const callLike = step.calls.map((call) => ({ name: call.name, arguments: call.args }));
  const repeated = new Set(repeatedCallIndexes(callLike));
  const calls = step.calls.map((call, index) => countCall(call, repeated.has(index)));
  const overlaps = callOverlaps(callLike).map(({ a, b, kind }) => ({ a, b, kind }));
  const usage = step.usage;
  return {
    i: step.index,
    ms: step.ms,
    ...(step.outputTokens !== undefined ? { out: step.outputTokens } : {}),
    ...(step.hiddenCalls !== undefined ? { hiddenCalls: step.hiddenCalls } : {}),
    ...(step.note ? { note: step.note } : {}),
    ...(overlaps.length > 0 ? { overlaps } : {}),
    ...(usage
      ? {
          usage: {
            prompt: usage.promptTokens ?? 0,
            cached: usage.cachedTokens ?? 0,
            output: usage.completionTokens ?? 0,
            cacheCreation: usage.cacheCreationTokens ?? 0,
          },
        }
      : {}),
    calls,
  };
}

function countCall(call: RunCallLog, repeated: boolean): RunCountCall {
  const chars = (call.detail?.length ?? 0) + (call.summary?.length ?? 0);
  const flags = [...callFlags(call.name, call.args), ...(repeated ? (['repeat'] as const) : [])];
  return {
    name: call.name,
    ok: call.ok !== false,
    chars,
    ...(call.ms !== undefined ? { ms: call.ms } : {}),
    ...(call.note ? { note: call.note } : {}),
    ...(call.ok === false ? { reason: callFailureReason(call) } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

/** Причина отказа кодов, чтобы отчёт не нёс текст ошибки. */
export function callFailureReason(call: Pick<RunCallLog, 'ok' | 'summary' | 'detail'>): CallFailureReason {
  if (call.ok !== false) return 'other';
  const text = `${call.summary ?? ''}\n${call.detail ?? ''}`;
  // Формы наших же отказов пишутся строчными («нужна строка», «не задан path»,
  // «ожидался объект») и не попадали ни под «Нужен » (там «нужен», а не «нужна»),
  // ни под «не задан аргумент» — 116 отказов `edit` из 152 осели в «other»,
  // то есть причину правок нельзя было назвать (замер 29.10).
  if (
    /Не хватает аргумента|Не задан аргумент|Нужен |нужна строка|нужен непустой|ожидался объект|не задан|нужно целое число|ни одной правки|должен быть массивом|Передай |неверно|Неизвестное значение аргумента|Аргументы инструмента должны|не задан аргумент/iu.test(
      text,
    )
  ) {
    return 'arg';
  }
  if (/Неизвестное действие|Неизвестное значение действия/u.test(text)) return 'action';
  if (/Инструмент недоступен|не подключён|недоступен|нет доступа|не подключено/.test(text)) return 'unavailable';
  if (/код выхода [1-9]|убит сигналом/.test(text)) return 'command';
  // Якорь — до `not-found`: отказ правки по якорю тоже говорит «не найден»,
  // но чинится он не перечитыванием пути, а другим якорем. В телеметрии без
  // этого кода 103 отказа `edit` из 136 попадали в глухое «other».
  if (
    /Правки не применены|не применена|якор|в файле не найден|Похожего места|ничего не заменено|Не найдено ни одного вхождения/iu.test(
      text,
    )
  ) {
    return 'anchor';
  }
  if (/отклонил|отклонена|не ответил|Ответа нет|прерван/u.test(text)) return 'rejected';
  if (/не найден|не найдено|нет файла|нет папки|ENOENT|язык не распознан/iu.test(text)) return 'not-found';
  if (/отказано|отменен|подтвержд|спроси|Жд[её]т|Недостаточно прав|режим плана|доступ запрещ/i.test(text))
    return 'permission';
  return 'other';
}

/** Команды, которыми читают файлы через шелл вместо `read`/`search`. */
const SHELL_READ = /\b(cat|head|tail|sed|grep|rg|awk|less|more|find|ls|tree|wc|nl)\b/;

/**
 * Форма вызова по аргументам. Разбор намеренно необязательный: испорченные
 * аргументы — это тоже данные (отказ формы), но пометок у них нет.
 */
export function callFlags(name: string, argsJson: string): CallFlag[] {
  const args = parseArgs(argsJson);
  if (!args) return [];
  const flags: CallFlag[] = [];
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (command) {
    if (/^cd\s/.test(command)) flags.push('cd');
    else if (SHELL_READ.test(command)) flags.push('shell-read');
  }
  if (name === 'read' || name === 'read_file') {
    const paths = Array.isArray(args.paths) ? args.paths.length : 0;
    if (paths > 1) {
      flags.push('paths');
      return flags;
    }
    const ranged = args.startLine !== undefined || args.endLine !== undefined;
    if (!ranged) flags.push('whole-read');
  }
  return flags;
}

function parseArgs(argsJson: string): Record<string, unknown> | null {
  if (!argsJson) return null;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Строка файла. Тот же JSON Lines, что у полного журнала: дописывание дешевле. */
export function formatCountsLine(record: RunCountsRecord): string {
  return JSON.stringify(record);
}

/** Разбор хвоста файла: битую строку (обрыв записи) пропускаем, а не роняем отчёт. */
export function parseCounts(text: string): RunCountsRecord[] {
  const out: RunCountsRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RunCountsRecord;
      if (parsed?.version === STEP_COUNTS_VERSION && Array.isArray(parsed.steps)) out.push(parsed);
    } catch {
      // Обрыв записи или чужая строка — этот прогон просто не попадёт в отчёт.
    }
  }
  return out;
}
