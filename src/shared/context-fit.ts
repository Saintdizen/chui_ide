import type { ChatMessage } from './api';

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
 * Символов на токен. То же значение, что и в окне «Информация о сессии»: смесь
 * русского текста, кода и латиницы. Точное число знает только токенизатор, но для
 * предохранителя важна не точность, а порядок величины.
 */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Сколько «стоит» одна картинка. Считать по длине data-URL нельзя: base64-строка
 * в разы длиннее, чем токены, которые за неё возьмёт провайдер, — оценка раздуется
 * и обрезка сработает на пустом месте.
 */
const IMAGE_TOKENS = 1_000;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Оценка размера истории в токенах: текст по символам, картинки — фиксированно. */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  let images = 0;

  for (const message of messages) {
    chars += (message.content ?? '').length;
    if (message.name) chars += message.name.length;
    if (message.toolCallId) chars += message.toolCallId.length;
    for (const call of message.toolCalls ?? []) {
      chars += call.id.length + call.name.length + call.arguments.length;
    }
    images += message.images?.length ?? 0;
  }

  return estimateTokens(chars) + images * IMAGE_TOKENS;
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
  const markerTokens = marker ? estimateTokens(marker.content.length) : 0;
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
