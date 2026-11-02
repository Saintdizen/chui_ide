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
// 2 — у отказа с кодом `other` на месте кода стоит форма (`unknown`). В записях v1
// там стоял сам код `other`, а формы не было: отчёт старых прогонов не держим.
export const STEP_COUNTS_VERSION = 2;

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
  /**
   * Первая строка отказа для кода-заглушки (`other`, `command`, `exit`, `arg`): чистая форма,
   * без путей и кавычек. Правило замера: причину, которую нельзя прочитать,
   * нельзя и лечить, — поэтому нечитаемые отказы едут в отчёт текстом, а не
   * молчанием (61 % отказов по замеру 30.10).
   */
  unknown?: string;
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
  /**
   * Команда отработала и ответила «нет»: ненулевой код выхода или сигнал.
   * Это ответ, а не поломка инструмента — в таблице отказов стоит отдельно
   * (47 отказов `terminal` из 94, замер 30.10).
   */
  | 'exit'
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
  // `failed` — тоже отказ: тест упал или команда вернула ненулевой код. Без него
  // отчёт по шагам считал такие вызовы успешными и отказы «тихо очищались».
  const reason = call.ok === false ? callFailureReason(call) : call.failed ? 'exit' : undefined;
  // Ответ команды («нет», код выхода 1/6/—) — не поломка инструмента: он
  // стоит отдельным кодом `exit`, чтобы в таблице отказов не мешаться с
  // `arg`, `not-found`, `unavailable`, `permission` (47 отказов `terminal` из
  // 94 были именно такими, замер 30.10).
  // Форма пишется трём кодам-заглушкам: `exit` и `other` называют вид, но не
  // причину, `arg` прячет причину за общим «не задан аргумент» (замер 30.10 —
  // 201 отказ из 326 с кодом `other`).
  // `arg` — тоже: техника говорит «файл на 386 строк», а читают с 590-й;
  // такое видно только в тексте. Склейка — после refusalShape(), иначе очистка
  // путей съела бы хвост пометки («cwd» → «…»).
  // Код в форму не подмешиваем: «failed:» ломал сверку с записью до v2.
  const shape = refusalShape(call);
  const shapeless = reason === 'other' || reason === 'exit' || reason === 'arg';
  const unknown = shapeless && reason !== undefined && !shape.startsWith('(') ? shape : '';
  // Код-заглушку в записи не держим: причина у неё — ровно форма, и с кодом
  // отчёт считал бы такой отказ дважды. `exit` — единственное исключение: он
  // называет ответ команды, и отчёт по коду должен их видеть отдельно.
  const shown = reason === 'other' ? '' : (reason ?? '');
  return {
    name: call.name,
    ok: call.ok !== false && !call.failed,
    chars,
    ...(call.ms !== undefined ? { ms: call.ms } : {}),
    ...(call.note ? { note: call.note } : {}),
    ...(shown ? { reason: shown } : {}),
    ...(unknown ? { unknown } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

/** Причина отказа кодов, чтобы отчёт не нёс текст ошибки. */
export function callFailureReason(call: Pick<RunCallLog, 'ok' | 'summary' | 'detail'>): CallFailureReason {
  if (call.ok !== false) return 'other';
  const text = `${call.summary ?? ''}\n${call.detail ?? ''}`;
  // Помётка сжатия вместо аргумента — наш же отказ формы замера (30.10): аргумент
  // подменился текстом сжатия и до инструмента не дошёл. 24 отказа `edit` из 266
  // всех провалов сидели в «other» именно этим текстом.
  if (/пометкой сжатия/u.test(text)) return 'arg';
  // Формы наших же отказов пишутся строчными («нужна строка», «не задан path»,
  // «ожидался объект») и не попадали ни под «Нужен » (там «нужен», а не «нужна»),
  // ни под «не задан аргумент» — 116 отказов `edit` из 152 осели в «other»,
  // то есть причину правок нельзя было назвать (замер 29.10).
  if (
    /Не хватает аргумента|Не задан аргумент|Не задан\w*\s+(?:аргумент\w*|path)|Нужен |нужна строка|нужен непустой|ожидался объект|не задан|не задан path|нужно целое число|ни одной правки|должен быть массивом|Передай |неверно|Неизвестное значение аргумента|Аргументы инструмента должны|не задан аргумент|слишком длинн|длиннее \d+ символов/iu.test(
      text,
    )
  ) {
    return 'arg';
  }
  // Отказ до `unknown`: текст формы есть, значит причина известна и это форма вызова.
  // Перепись 02.11: 11 вызовов `{patches: [{oldText, newText}]}` уходили в `unknown`,
  // потому что шаблон знал только строчное «не задан path», а пришло `patches[0]: не задан path` — с индексом впереди.
  if (/не задан\w*\s+path|не задан аргумент|path.{0,20}не задан/iu.test(text)) return 'arg';
  if (/Неизвестное действие|Неизвестное значение действия/u.test(text)) return 'action';
  // Текст, который сам называет причину: файл уже есть (это состояние, а не форма
  // вызова), и неразобранный JSON (пришёл битый вызов — лечится повтором).
  // Оба слова взяты из переписи 02.11: по одному вызову, но оба точно не `other`.
  if (/Уже существует/u.test(text)) return 'not-found';
  if (/Не удалось разобрать аргументы|in JSON at position/u.test(text)) return 'arg';
  // Номер строки за концом файла — не поломка инструмента, а догадка модели о длине
  // файла. Чинится перечитыванием (read без диапазона) — код назван замером 30.10.
  if (/диапазона \d+ за концом файла|Строки \d+ нет/u.test(text)) return 'arg';
  // Корень «недоступ», а не форма: рядом живут «недоступен» (веб-поиск),
  // «недоступна» (память), «недоступны» (задания). Форма, вписанная целиком,
  // закрывала только свои отказы, а хвост оседал в «other» — 22 отказа `mind`
  // из 89 и оба отказа `web` из двух (замер 30.10).
  if (/недоступ|не подключён|нет доступа|не подключено/.test(text)) return 'unavailable';
  // «код выхода —» — тоже провал шелла: код неизвестен, но команда не прошла.
  // Узкое «[1-9]» отправляло такие отказы в «other» (call-census, 30.10).
  // Свой код `exit`: это ответ команды, а не поломка инструмента.
  if (/код выхода (?:[1-9]|—|-|\?)|убит сигналом/u.test(text)) return 'exit';
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
  if (
    /отказано|отменен|подтвержд|спроси|Жд[её]т|Недостаточно прав|режим плана|доступ запрещ|вне рабочей папки|вне проекта/iu.test(
      text,
    )
  ) {
    return 'permission';
  }
  return 'other';
}

/**
 * Форма отказа для кода `other` — то, чего классификатор не узнал.
 *
 * Берём первую строку: там подлежащее, а хвост отказа часто несёт аргументы
 * модели (путь, якорь, команду) — в отчёт они попадать не должны. Вычищаем
 * содержимое кавычек и похожего на путь: остаётся «Не задан аргумент <…>».
 * Длина ограничена, чтобы строка отчёта читалась. Пустая форма («отказ без
 * текста») — тоже сигнал, и он честно помечается, а не пропадает.
 */
export function refusalShape(call: Pick<RunCallLog, 'ok' | 'summary' | 'detail'>): string {
  const first = `${call.summary ?? ''}\n${call.detail ?? ''}`.split('\n').find((line) => line.trim()) ?? '';
  const shape = first
    // Парные кавычки — только парой: одиночная замена съедала текст между
    // разными кавычками. Одиночная кавычка без пары остаётся: она часть формы.
    .replace(/«[^«»]*»/gu, '…')
    .replace(/"[^"]*"/gu, '…')
    .replace(/'[^']*'/gu, '…')
    .replace(/`[^`]*`/gu, '…')
    // Индекс в адресе (`patches[0]`, `edits[1]`) — позиция в списке, а не поле —
    // такие строки несли причину отказа, разбитую по значениям индекса.
    .replace(/\[\d+\]/gu, '[]')
    // Путь узнаём по косой или по расширению: `src/a.ts`, `a.ts`, `/abs/x`.
    .replace(/(?:[~.]?\/[^\s«»"'`]+|\b[\w.-]+\/[\w./-]+|\b[\w-]+\.[A-Za-z]{1,5}\b)/gu, '…')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!shape) return '(отказ без текста)';
  // Обрезка по словам: хвост обрезанного слова («подстав» вместо «подставить»)
  // в отчёте читается как другая форма — замер 02.11.
  const words = shape.split(' ');
  // Служебное слово не оставляем последним: «ожидался» без «объект» — это уже
  // другая форма. Замер 02.11: `patches[]: не задан path. В элементе лежат`.
  while (
    words.length > 1 &&
    (words.join(' ').length > 60 || STOP_WORDS.has(words[words.length - 1]!.toLowerCase()))
  ) {
    words.pop();
  }
  const short = words.join(' ');
  return short.length > 60 ? `${short.slice(0, 59)}…` : short;
}

/** Слова, после которых обрывать форму бессмысленно: она теряет смысл. */
const STOP_WORDS = new Set([
  'в',
  'и',
  'а',
  'не',
  'на',
  'из',
  'с',
  'к',
  'у',
  'о',
  'уже',
  'лежат',
  'нужен',
  'нужна',
  'это',
  'если',
  'то',
  'или',
]);



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
