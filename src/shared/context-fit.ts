import type { ChatAttachment, ChatMessage, ChatUsage } from './api';
import { contextWindow } from './providers';
import { AGENT_TOOLS, parseToolArguments } from './tools';

/**
 * Предохранитель от переполнения контекста в многошаговом агентном цикле.
 *
 * Renderer проверяет окно перед отправкой вопроса, но сам прогон агента живёт в
 * main и растёт на каждом шаге: `assistant(вызовы)` → `tool(результаты)`. Крупный
 * `read_file` десяток раз подряд — и запрос перестаёт помещаться в окно посреди
 * цикла, где renderer уже ничего не поправит. Здесь — грубая, но дешёвая оценка
 * и обрезка «целыми ходами», которая не рвёт связку вызов→результат.
 */

/**
 * Символов на токен для узких символов — латиницы, кода, разметки. Значение чуть
 * ниже реального (там около четырёх): предохранителю важнее переоценить объём, чем
 * недооценить. Тем же числом оцениваются строки, состав которых мы не разбираем, —
 * см. `estimateTokens`.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Символов на токен для широких символов — кириллицы, иероглифов и прочего
 * не-ASCII. Их токенизатор дробит мельче (нередко в отдельные токены), поэтому цена
 * выше. Раньше весь текст считался по узкой ставке — из-за этого русская беседа
 * незаметно переполняла окно: оценка была вдвое ниже правды.
 */
export const CHARS_PER_TOKEN_WIDE = 2;

/**
 * Сколько «стоит» одна картинка. Считать по длине data-URL нельзя: base64-строка
 * в разы длиннее, чем токены, которые за неё возьмёт провайдер, — оценка раздуется
 * и обрезка сработает на пустом месте.
 *
 * Экспортируется затем, что по этой же цене картинка сворачивается в истории
 * (`age-results.ts`): длина её текста ничего не говорит о том, сколько она стоит.
 */
export const IMAGE_TOKENS = 1_000;

/**
 * Потолок резерва под ответ: больше этого модель за один ответ не напишет.
 *
 * «Не больше» — не догадка о среднем, а верхняя граница разумного: 32 000 токенов
 * это десятки тысяч слов, то есть ответ на порядок длиннее всего, что человек
 * читает в ленте. Всё, что настройка назначает сверх, остаётся потолком запроса
 * (`max_tokens`), но в окне не резервируется.
 */
export const MAX_ANSWER_RESERVE = 32_000;

/** Какую долю окна можно отдать под резерв ответа. */
const ANSWER_RESERVE_SHARE = 0.25;

/**
 * Сколько окна резервировать под ответ модели.
 *
 * `maxTokens` из настроек — не «сколько ответ займёт», а предел, который провайдер
 * обязан соблюдать; человек ставит его с запасом (бывает и 360 000). Резервировать
 * весь этот запас нельзя: из миллиона токенов окна треть стояла бы пустой, и
 * обрезка истории вместе с автосжатием срабатывали бы вдвое раньше, чем нужно.
 * Поэтому резерв — не больше `MAX_ANSWER_RESERVE` и не больше четверти окна.
 */
export function answerReserve(maxTokens: number, windowTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return 0;
  const share = Math.floor(Math.max(1, windowTokens) * ANSWER_RESERVE_SHARE);
  return Math.min(Math.floor(maxTokens), share, MAX_ANSWER_RESERVE);
}

/** Оценка по одной лишь длине строки: состав не разбирает, см. `estimateTextTokens`. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Оценка токенов по самому тексту: широкие символы (кириллица) считаем дороже.
 *
 * `estimateTokens` знает только длину и слепа к составу строки. На русском тексте
 * это заметная недооценка: кириллица в токенах дороже латиницы, и запрос, который
 * по расчёту помещался, у провайдера не влезает. Точное число знает лишь
 * токенизатор, но нам важнее не занизить — округляем вверх.
 */
export function estimateTextTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 127) wide += 1;
  const narrow = text.length - wide;
  return Math.ceil(narrow / CHARS_PER_TOKEN + wide / CHARS_PER_TOKEN_WIDE);
}

/** Оценка одного сообщения: текст, служебные поля, вызовы инструментов и картинки. */
function messageTokens(message: ChatMessage): number {
  let tokens = estimateTextTokens(message.content ?? '');
  if (message.name) tokens += estimateTextTokens(message.name);
  if (message.toolCallId) tokens += estimateTextTokens(message.toolCallId);
  // Размышления уезжают обратно провайдеру вместе с вызовами инструментов:
  // не считать их — значит врать о заполнении контекста.
  if (message.reasoning) tokens += estimateTextTokens(message.reasoning);
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTextTokens(call.id) + estimateTextTokens(call.name) + estimateTextTokens(call.arguments);
  }
  return tokens + (message.images?.length ?? 0) * IMAGE_TOKENS;
}

/** Оценка размера истории в токенах: текст по составу, картинки — фиксированно. */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) tokens += messageTokens(message);
  return tokens;
}

/* ── состав контекста и заполнение окна ─────────────────────────────────────
 * Провайдер сообщает только общий размер запроса (`usage.promptTokens`), разбивку
 * по частям он не отдаёт. Считаем её сами — по тем же ставкам, что и обрезка
 * (`estimateTextTokens`): тогда оценка в renderer и в main не разъезжается, и
 * кириллица не занижается ровно вдвое — иначе автосжатие запаздывает.
 */

/** Из чего состоит контекст: токены по частям запроса. */
export interface ContextParts {
  /** Системный промпт и контекст проекта. */
  system: number;
  /** Описания инструментов, которые уезжают модели. */
  tools: number;
  /** Обычные сообщения беседы (включая ещё не отправленный вопрос). */
  messages: number;
  /** Результаты вызовов инструментов — они растут быстрее всего. */
  results: number;
  /** Приложенные пользователем файлы и выделение. */
  files: number;
}

/** Всё, из чего складывается контекст сессии. */
export interface ContextPartsInput {
  history: readonly ChatMessage[];
  attachments: readonly ChatAttachment[];
  systemPrompt: string;
  /** Предлагаются ли модели описания инструментов. */
  tools: boolean;
  /**
   * Реальный вес описаний инструментов из последнего прогона (main кладёт его
   * в след беседы). Если он известен, берём его: какой набор предложить, решает
   * main (`canRun` + внешние инструменты), и по общему списку renderer ошибался
   * бы в обе стороны. Не задан — считаем по полному списку, как раньше.
   */
  toolsTokens?: number;
  /**
   * Вопрос, который вот-вот уйдёт в модель, но ещё не попал в историю. Без него
   * оценка перед отправкой занижена ровно на вес отправляемого сообщения.
   */
  pending?: string;
}

/**
 * Разбивка контекста по частям. Сообщения и результаты инструментов считаем
 * раздельно: у агента результаты растут очень неровно, и по разбивке сразу видно,
 * что именно съело окно.
 */
export function estimateContextParts(input: ContextPartsInput): ContextParts {
  let messages = 0;
  let results = 0;
  for (const message of input.history) {
    const tokens = messageTokens(message);
    if (message.role === 'tool') results += tokens;
    else messages += tokens;
  }
  // Вопрос, который ещё не в истории, но уже уезжает в модель.
  if (input.pending) messages += estimateTextTokens(input.pending);

  return {
    system: estimateTextTokens(input.systemPrompt),
    // Факт из последнего прогона важнее расчёта: он про тот набор, который
    // реально ушёл. Без него — оценка по всему списку инструментов.
    tools: input.tools ? (input.toolsTokens ?? estimateTextTokens(JSON.stringify(AGENT_TOOLS))) : 0,
    messages,
    results,
    files: input.attachments.reduce((sum, item) => sum + estimateTextTokens(item.text), 0),
  };
}

/** Сколько контекста занято: итог — реальный, если провайдер его сообщил. */
export interface ContextUsage {
  used: number;
  limit: number;
  percent: number;
  /** Итог известен точно или пока оценён по символам. */
  exact: boolean;
}

/** Данные для расчёта заполнения контекстного окна. */
export interface ContextUsageInput extends ContextPartsInput {
  model: string;
  /** Явный размер окна из настроек; не задан — считается по имени модели. */
  contextWindow?: number;
  usage?: ChatUsage;
}

/**
 * Заполнение контекстного окна. Итог берём у провайдера (`promptTokens`), а пока
 * его нет — считаем по символам: без знаменателя заполнение не показать. Новый
 * вопрос добавляем и к точному итогу: иначе перед отправкой его вес не виден, и
 * сжатие срабатывает позже, чем нужно.
 */
export function contextUsage(input: ContextUsageInput): ContextUsage {
  const parts = estimateContextParts(input);
  const estimated = parts.system + parts.tools + parts.messages + parts.results + parts.files;
  const pendingTokens = input.pending ? estimateTextTokens(input.pending) : 0;
  const actual = input.usage?.promptTokens;
  const used = actual !== undefined ? actual + pendingTokens : estimated;
  const limit = contextWindow(input.model, input.contextWindow);
  return {
    used,
    limit,
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    exact: actual !== undefined,
  };
}

export interface TrimOptions {
  /** Размер окна модели в токенах. */
  limitTokens: number;
  /**
   * Оценка всего, что не входит в историю: описания инструментов, системный
   * промпт, приложенный контекст. Считается снаружи — эти части обрезке не подлежат.
   */
  overheadTokens?: number;
  /** Резерв под ответ модели: его тоже нужно вписать в окно. */
  reserveTokens?: number;
  /**
   * Сколько последних «ходов» не трогать даже при переполнении. Ход — это
   * сообщение пользователя (или обычный ответ ассистента) вместе со всем, что
   * за ним следует.
   */
  keepRecent?: number;
  /** Заметка, которая встанет на месте выброшенной истории. */
  marker?: string;
}

/**
 * Обрезать историю до окна, выбрасывая старые ходы целиком.
 *
 * Ведущий блок system-сообщений (инструкции, контекст проекта) не трогаем — это
 * не история, а рамка. Остальное делим на ходы: граница хода — сообщение
 * пользователя или ответ ассистента без вызовов инструментов. Границы ищутся
 * только там, поэтому пара `assistant.toolCalls` → `tool` никогда не расщепляется:
 * иначе провайдер отклонит запрос как нарушающий протокол вызова.
 *
 * Возвращаем новый массив (исходный не меняем) и число выброшенных сообщений —
 * по нему видно, пришлось ли что-то резать. Если даже минимальный хвост не
 * помещается, оставляем его как есть: лучше попробовать, чем отправить пустоту.
 */
export function trimMessagesToFit(
  messages: readonly ChatMessage[],
  options: TrimOptions,
): { messages: ChatMessage[]; dropped: number } {
  const budget = options.limitTokens - (options.overheadTokens ?? 0) - (options.reserveTokens ?? 0);
  const unchanged = { messages: [...messages], dropped: 0 };
  // Окно не вмещает даже накладные расходы — резать историю бессмысленно.
  if (budget <= 0) return unchanged;
  if (estimateMessagesTokens(messages) <= budget) return unchanged;

  // Ведущий system-блок: инструкции, контекст проекта, приложения. Это рамка
  // запроса, а не беседа, поэтому обрезке не подлежит.
  let prefix = 0;
  while (prefix < messages.length && messages[prefix]!.role === 'system') prefix += 1;
  const head = messages.slice(0, prefix);
  const rest = messages.slice(prefix);

  // Индексы, с которых можно начать обрезанный хвост и не порвать протокол.
  const boundaries = [0];
  for (let i = 1; i < rest.length; i += 1) {
    const message = rest[i]!;
    if (message.role === 'user' || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) === 0)) {
      boundaries.push(i);
    }
  }

  const marker: ChatMessage | undefined = options.marker ? { role: 'system', content: options.marker } : undefined;
  const markerTokens = marker ? estimateTextTokens(marker.content) : 0;
  const keepRecent = Math.max(1, options.keepRecent ?? 1);
  const headTokens = estimateMessagesTokens(head) + markerTokens;

  // Отбрасываем минимально возможное число ходов: перебираем от одного и вверх.
  let from = rest.length;
  for (let k = 1; k <= boundaries.length - keepRecent; k += 1) {
    const cut = boundaries[k]!;
    if (headTokens + estimateMessagesTokens(rest.slice(cut)) <= budget) {
      from = cut;
      break;
    }
  }
  // Не влезло ничего — оставляем хотя бы keepRecent последних ходов.
  if (from === rest.length) from = boundaries[Math.max(0, boundaries.length - keepRecent)] ?? rest.length;

  const kept = rest.slice(from);
  const dropped = rest.length - kept.length;
  if (dropped === 0) return unchanged;

  return { messages: marker ? [...head, marker, ...kept] : [...head, ...kept], dropped };
}

/* ── сжатие истории моделью ─────────────────────────────────────────────────
 * Здесь только подготовка текста для запроса-суммаризатора: бюджет и нарезка.
 * Сам запрос к модели делает renderer — эта часть чистая и потому тестируема.
 */

/**
 * Границы бюджета одного прохода сжатия, в символах. Основной бюджет считают от
 * окна модели (см. `compactionBudgetChars`). Минимум не даёт крошечному окну дробить
 * беседу на десятки проходов, максимум — защищает от неоправданно крупного запроса.
 */
export const COMPACT_MIN_CHARS = 20_000;
export const COMPACT_MAX_CHARS = 400_000;

/**
 * Абсолютный предел истории в токенах по умолчанию — значение настройки
 * `ai.compactAtTokens` и второй триггер автосжатия (0 — только по окну модели).
 *
 * Доля окна плохо работает на больших окнах: 80% от миллиона токенов недостижимо
 * за одну беседу. Поэтому сжимаем ещё и когда история переросла этот предел, — так
 * размер одного запроса не зависит от модели. Человек может поднять его в настройках.
 */
export const COMPACT_AT_TOKENS = 0;

/**
 * Через сколько ходов беседы сжимать по расписанию («сжимать чаще»). Ход — вопрос
 * пользователя вместе с ответом агента, поэтому 12 ходов это два-три экрана переписки.
 */
export const COMPACT_EVERY_TURNS = 12;

/**
 * Доля окна, после которой сжимаем, не дожидаясь других признаков: с запасом, а не
 * «в упор». Единственный порог, который действует всегда.
 */
export const COMPACT_AT_RATIO = 0.8;

/** Ниже этой доли попаданий в кеш он считается промахнувшимся. */
export const CACHE_MISS_RATIO = 0.3;

/* ── когда сжимать ───────────────────────────────────────────────────────────
 * Сжатие не бесплатное: это отдельный запрос к модели, а главное — оно
 * перестраивает префикс беседы и тем самым обнуляет кеш промпта. Поэтому решаем
 * не «по заполнению вообще», а по признакам того, что беседа стала дорогой:
 * кеш перестал попадать либо вот-вот упрёмся в окно. Логика живёт здесь, а не в
 * панели: так её видно тестами, а не только глазами в интерфейсе.
 */

/** Почему решили сжать — по нему видно, что сказать человеку. */
export type CompactionReason = 'cache-miss' | 'window' | 'history' | 'turns';

export interface CompactionInput {
  /** Заполнение окна и его предел — как их считает `contextUsage`. */
  used: number;
  limit: number;
  /** Резерв под ответ: его тоже надо вписать в окно. */
  reserve: number;
  /**
   * Беседа дописана после сжатия: `usage` последнего ответа относится к другой
   * истории. По нему промах кеша не судим.
   */
  usageFresh?: boolean;
  /** Расход последнего ответа: по попаданию в кеш видно, пишется ли префикс. */
  usage?: ChatUsage;
  /**
   * Абсолютный предел истории (`ai.compactAtTokens`); 0 — не сжимать по объёму.
   * Оставлен для тех, кому нужен жёсткий потолок запроса независимо от окна.
   */
  compactAtTokens?: number;
  /**
   * Ходов с прошлого сжатия и порог расписания. Порог 0 — расписание выключено.
   * Ход — вопрос пользователя вместе с ответом агента.
   */
  turnsSinceCompact?: number;
  turnsEvery?: number;
  /** Провайдер умеет компактное сжатие; не умеет — промах кеша не повод. */
  compactCapable?: boolean;
  /** Разрешено ли вообще сжимать по промаху кеша. */
  compactOnCacheMiss?: boolean;
}

/**
 * Пора ли сжимать и почему. Проверки идут от последнего рубежа к первому: окно,
 * абсолютный потолок, расписание, кеш. Порядок важен только для сообщения
 * человеку — решать всё равно достаточно любой причины.
 *
 * Промах кеша — основной сигнал: префикс перестал кешироваться, и каждый следующий
 * запрос платится целиком. Сжатие перестраивает префикс один раз, и дальше
 * кешируется уже новая, короткая история. Если провайдер не умеет компактного
 * сжатия, переписывать префикс нечем — остаётся только окно.
 */
export function needsCompaction(input: CompactionInput): CompactionReason | null {
  const used = Math.max(0, Math.floor(input.used));
  const limit = Math.max(1, Math.floor(input.limit));
  if (used + input.reserve > limit * COMPACT_AT_RATIO) return 'window';

  const absolute = Math.floor(input.compactAtTokens ?? 0);
  if (absolute > 0 && used > absolute) return 'history';

  const every = Math.floor(input.turnsEvery ?? 0);
  if (every > 0 && (input.turnsSinceCompact ?? 0) >= every) return 'turns';

  if (input.compactOnCacheMiss !== false && input.compactCapable !== false && input.usageFresh !== false) {
    if (isCacheMiss(input.usage)) return 'cache-miss';
  }
  return null;
}

/**
 * Кеш промпта не сработал: попаданий почти нет при заметном входе.
 *
 * Маленький вход не считаем: на первых сообщениях кеш только пишется, и промах
 * там нормален — сжатие вышло бы дороже самого запроса. Как и отсутствие числа от
 * провайдера: локальные модели про кеш молчат, судить не по чему.
 */
export function isCacheMiss(usage: ChatUsage | undefined): boolean {
  const prompt = usage?.promptTokens ?? 0;
  if (prompt < 1_000) return false;
  if (usage?.cachedTokens === undefined) return false;
  return usage.cachedTokens / prompt < CACHE_MISS_RATIO;
}

/** Что сказать человеку о причине сжатия. */
export function compactionMessage(reason: CompactionReason): string {
  switch (reason) {
    case 'window':
      return 'Контекст подходит к концу — сжимаю беседу перед отправкой';
    case 'history':
      return 'Беседа слишком длинная — сжимаю перед отправкой';
    case 'turns':
      return 'Пора сжать беседу — сжимаю перед отправкой';
    case 'cache-miss':
      return 'Кеш контекста перестал попадать — сжимаю беседу, чтобы вернуть его';
  }
}

/**
 * Бюджет одного прохода сжатия: сколько символов истории можно отдать модели за
 * раз. Запрос (промпт + часть беседы) вместе с накопленным резюме должен помещаться
 * в окно, поэтому от него отнимаем резерв (ответ + сам промпт-инструкция).
 */
export function compactionBudgetChars(limitTokens: number, reserveTokens: number): number {
  const chars = Math.floor((limitTokens - reserveTokens) * CHARS_PER_TOKEN);
  return Math.max(COMPACT_MIN_CHARS, Math.min(chars, COMPACT_MAX_CHARS));
}

/**
 * История → части для каскадного сжатия, по бюджету символов каждая.
 *
 * Режем только между сообщениями. Отдельное сообщение больше бюджета (огромный
 * вывод инструмента) всё равно отдаём целиком, разбив по символам: терять его
 * нельзя — обычно оно и есть суть беседы. Раньше на сжатие уезжал только хвост
 * истории, и всё, что было до него, пропадало бесследно; нарезка на части это лечит.
 */
export function splitTranscript(history: readonly ChatMessage[], budgetChars: number): string[] {
  const budget = Math.max(1, Math.floor(budgetChars));
  const blocks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) blocks.push(current);
    current = '';
  };

  for (const message of history) {
    const line = `${message.role}: ${message.content ?? ''}`;
    if (line.length > budget) {
      flush();
      for (let at = 0; at < line.length; at += budget) blocks.push(line.slice(at, at + budget));
      continue;
    }
    if (current.length + line.length + 2 > budget) flush();
    current += (current ? '\n\n' : '') + line;
  }
  flush();
  return blocks;
}

/* ── переполнение окна у провайдера ────────────────────────────────────── */

/**
 * Признак переполнения контекста в теле ошибки провайдера. Формулировки у вендоров
 * разные (OpenAI, Anthropic, шлюзы), но говорят они одно: запрос не поместился в окно.
 */
const CONTEXT_OVERFLOW =
  /context[_ ]length|maximum context|too many tokens|exceeds the (model'?s )?maximum|reduce the length|prompt is too long|input (is )?too long/i;

/**
 * Отказал ли провайдер именно из-за переполнения контекста.
 *
 * Отличить это от прочих 400 важно: переполнение лечится обрезкой истории и
 * повтором, все прочие ошибки — нет. Текст ошибки (`message`) у нас уже переведён,
 * поэтому надёжный признак — сырое тело ответа в `details`.
 *
 * Работаем со структурой ошибки, а не с классом: так предикат остаётся чистым и
 * проверяется без Electron (см. `tests/context-fit.test.ts`).
 */
export function isContextOverflow(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { message, details } = error as { message?: unknown; details?: unknown };
  return (
    CONTEXT_OVERFLOW.test(typeof details === 'string' ? details : '') ||
    CONTEXT_OVERFLOW.test(typeof message === 'string' ? message : '')
  );
}

/* ── само-калибровка оценки по факту ───────────────────────────────────── */

/**
 * Границы поправки: оценка может врать, но не в разы. Если модель вернёт
 * `promptTokens` с учётом кеша или иной метрикой, отношение легко вылетит за
 * разумное — зажимаем, чтобы одна странная выборка не схлопнула окно.
 */
export const CALIBRATION_MIN = 0.5;
export const CALIBRATION_MAX = 3;

/** Вес новой точки в скользящем среднем: одна выборка не должна ломать поправку. */
const CALIBRATION_SMOOTHING = 0.3;

/**
 * Поправка к оценке токенов, выученная по фактическому `usage` провайдера.
 *
 * `estimateMessagesTokens` считает символы по ставке `CHARS_PER_TOKEN`, но это
 * лишь догадка: токенов на строку у разных моделей и языков разное число. Точное
 * значение провайдер отдаёт сам — в `usage.promptTokens` после ответа. Сравнив
 * факт с оценкой того же запроса, получаем поправку `факт / оценка` и храним её
 * (скользящим средним). Дальше окно для обрезки делим на эту поправку, и промах
 * оценки вниз перестаёт доходить до отказа провайдера.
 *
 * Работает поверх чистых `estimate*` и не меняет их: поправка нужна одному месту —
 * агентному циклу в main (см. `AiService.streamStep`). Поправки держим на диске
 * (`snapshot`/`load`), чтобы после перезапуска оценка не занижалась снова. Даже без
 * них предохранитель не пропадёт: реактивный повтор после отказа подстрахует.
 */
export class TokenCalibration {
  private readonly scales = new Map<string, number>();

  /** Во сколько раз оценка занижает факт (`actual / estimated`) для этого ключа. */
  scaleFor(key: string): number {
    return this.scales.get(key) ?? 1;
  }

  /**
   * Учесть один замер: `estimated` — наша оценка отправленного запроса,
   * `actual` — его настоящий размер из `usage.promptTokens`. Вырожденные значения
   * (ноль, не число) игнорируем: по ним поправку не построить.
   */
  observe(key: string, estimated: number, actual: number): void {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual) || estimated <= 0 || actual <= 0) return;
    const ratio = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, actual / estimated));
    const previous = this.scales.get(key);
    this.scales.set(key, previous === undefined ? ratio : previous + CALIBRATION_SMOOTHING * (ratio - previous));
  }

  /** Снимок поправок для сохранения между запусками (см. `AiService`). */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.scales);
  }

  /** Загрузить ранее сохранённые поправки. Мусор пропускаем: берём только числа. */
  load(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) this.scales.set(key, value);
    }
  }
}

/**
 * Тела, которые в истории больше не нужны после исполнения вызова.
 *
 * Это текст, который уже лёг в файл (правка, новый файл). Адрес у него есть —
 * файл, — а в контексте он висит до конца беседы и пересылается на каждом
 * шаге. Пометка говорит, сколько строк было и что делать дальше.
 */
// `command` здесь нет намеренно: аргумент остаётся в истории целым.
//
// Раньше он сжимался (`condenseAppliedCalls` звался для команд длиннее 400
// символов или с переносом строки), и это ломало повтор: вызов с пометкой
// вместо команды не имеет формы — в JSON вместо строки стоит объект. Повтор
// тем же вызовом (`apply_edit` с `oldText` → позиции, `terminal` с `command`
// → пометка) модель отправить не могла, хотя ей прямым текстом говорили
// «повтори». Голова команды, которую оставлял `commandLine`, не спасала:
// форма уже испорчена.
//
// Выигрыш от сжатия команд — сотни символов на редких heredoc'ах, цена —
// неисполнимый повтор лучшего инструмента правок. Тела правок сжимаются
// по-прежнему: там пометка — честный признак «этот текст уже на диске»,
// и проверка `staleCondensedBody` отказывает до записи.
const CONDENSE_FIELDS = new Set(['newText', 'oldText', 'content', 'contents', 'code']);

/**
 * С какого размера тело правки стоит забывать. Ниже — это одна-две строки:
 * пометка весит столько же и только мешает читать.
 */
export const CONDENSE_MIN_CHARS = 200;

/**
 * Сжать аргументы уже применённого изменения: длинные тела правок заменяем
 * пометкой, путь и прочие поля оставляем. Возвращает исходную строку, если это
 * не JSON или сжимать нечего. `minChars` отсекает мелочь — короткая правка и так
 * ничего не весит.
 */
export function condenseCallArguments(args: string, minChars: number): string {
  const parsed = parseToolArguments(args);
  if (!parsed.ok) return args;
  let changed = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    for (const [key, inner] of Object.entries(record)) {
      if (typeof inner === 'string' && CONDENSE_FIELDS.has(key) && inner.length >= minChars) {
        record[key] = `[свёрнуто: ${inner.split('\n').length} стр. — текст в файле, не копировать]`;
        changed = true;
      } else {
        record[key] = walk(inner);
      }
    }
    return record;
  };
  const result = walk(parsed.value);
  return changed ? JSON.stringify(result) : args;
}

/**
 * Пометка, которой `condenseCallArguments` заменяет тело правки в истории.
 *
 * Сжатие идёт только по копии для провайдера, и в норме в инструмент она не
 * попадает. Но если попадёт — файл получит эту строку вместо текста, а
 * инструмент отчитается «создан». Молчаливая порча хуже отказа, поэтому
 * `runTool` узнаёт пометку и не исполняет такой вызов.
 *
 * Слово — «свёрнуто», не «применено»: отчёт об удачной правке у `edit` —
 * `применено правок — 1` (`agent-edit.ts`), и одинаковое слово в двух разных
 * смыслах уже читалось как «правка легла в файл» там, где в файл положили
 * пометку. Старая форма осталась в регулярке: беседы, сжатые до переименования,
 * в истории ещё несут её, и `isCondenseMarker` обязан их узнавать.
 */
const CONDENSE_MARKER = /^\[(?:применено|свёрнуто): \d+ стр\. — текст в файле(, не копировать)?\]$/;

/** Аргумент — ровно пометка сжатия, а не текст, который модель написала сама. */
export function isCondenseMarker(value: unknown): boolean {
  return typeof value === 'string' && CONDENSE_MARKER.test(value.trim());
}

/**
 * Отпустить тела правок уже исполненного хода: заменить их пометкой в тех
 * вызовах, чьи правки действительно легли в файл.
 *
 * Зачем это делать сразу после шага, а не перед отправкой: аргументы прошлых
 * ходов входят в префикс запроса, а префикс — то, что кеширует провайдер. Если
 * сжимать задним числом, каждый шаг менял бы середину истории, и кеш слетал бы
 * с этого места на каждом шаге. Сжали один раз — и дальше префикс стабилен.
 *
 * `appliedIds` — id вызовов, чьи правки записаны (см. `ToolOutcome.applied`).
 * Остальные не трогаем: правку могли отклонить или она осталась в буфере, и
 * текст ещё понадобится. Возвращаем исходное сообщение, если сжимать нечего —
 * по ссылке, чтобы не плодить копии на каждом шаге.
 */

export function condenseAppliedCalls(
  message: ChatMessage,
  appliedIds: ReadonlySet<string>,
  minChars = CONDENSE_MIN_CHARS,
): ChatMessage {
  if (message.role !== 'assistant' || appliedIds.size === 0) return message;
  const calls = message.toolCalls ?? [];
  let changed = false;
  const toolCalls = calls.map((call) => {
    if (!appliedIds.has(call.id)) return call;
    const args = condenseCallArguments(call.arguments, minChars);
    if (args === call.arguments) return call;
    changed = true;
    return { ...call, arguments: args };
  });
  return changed ? { ...message, toolCalls } : message;
}

/**
 * Пометка для плана, который заменили более новым.
 *
 * `plan` с action steps присылает список шагов целиком и затирает прежний чек-лист,
 * поэтому старая версия в истории — повтор того же текста, только длиннее:
 * актуальные `status` уже в последнем вызове. Файла за планом нет, терять нечего.
 */
export const SUPERSEDED_PLAN_MARKER = '[план заменён: ниже актуальная версия]';

/**
 * План ли это: у общего инструмента `mind` действие `steps` (без действия — тоже оно)
 * и в аргументах есть сам список. Имя `plan` остаётся для старых бесед.
 */
function isPlanSteps(call: { name: string; arguments: string }): boolean {
  if (call.name !== 'mind' && call.name !== 'plan') return false;
  const parsed = parseToolArguments(call.arguments);
  if (parsed.ok) {
    if (parsed.value.action === 'goal') return false;
    return parsed.value.steps !== undefined;
  }
  return call.name === 'plan';
}

/** Аргументы плана, который уже заменён: `steps` — пометка, остальное на месте. */
function supersedePlan(args: string): string {
  if (args.includes(SUPERSEDED_PLAN_MARKER)) return args;
  const parsed = parseToolArguments(args);
  if (!parsed.ok) return args;
  const { steps, ...rest } = parsed.value;
  if (steps === undefined) return args;
  const replaced = JSON.stringify({ ...rest, steps: SUPERSEDED_PLAN_MARKER });
  // Меняем только если стало короче: план в одну строку дешевле оставить как есть.
  return replaced.length < args.length ? replaced : args;
}

/**
 * Оставить в истории один актуальный план.
 *
 * `keepId` — вызов `plan` (action steps), который и есть текущая версия; у остальных
 * `steps` заменяются пометкой. План едет в контексте на каждом шаге, а обновляется
 * обычно много раз за прогон: отметил шаг — прислал весь список заново.
 *
 * Меняем сразу после шага и по ссылке, как тела правок (см. `condenseAppliedCalls`):
 * сжатие задним числом двигало бы середину префикса и сбивало кеш.
 */
export function condenseSupersededPlans(message: ChatMessage, keepId: string): ChatMessage {
  if (message.role !== 'assistant' || !message.toolCalls?.length) return message;
  let changed = false;
  const toolCalls = message.toolCalls.map((call) => {
    if (!isPlanSteps(call) || call.id === keepId) return call;
    const args = supersedePlan(call.arguments);
    if (args === call.arguments) return call;
    changed = true;
    return { ...call, arguments: args };
  });
  return changed ? { ...message, toolCalls } : message;
}
