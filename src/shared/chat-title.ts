/**
 * Название беседы: короткое, по сути разговора.
 *
 * Заголовок вкладки до сих пор брался по первому вопросу — обрезанная строка в
 * 24 символа. Для «проверь, что тут сломалось в сборке» это читается как
 * «проверь, что тут слома…», и в полосе из пяти вкладок такие подписи не
 * различаются вовсе. Модель, которая видела и вопрос, и ответ, называет беседу
 * по сути: «Сборка падает на macOS».
 *
 * Здесь только чистая часть: правило для модели, промпт и очистка ответа. Запрос
 * к провайдеру живёт в main, вкладку переименовывает renderer — поэтому логика
 * проверяется без сети и без окна.
 *
 * Почему не через чат: название — это одна строка, а не беседа. Один короткий
 * запрос без истории, инструментов и карты проекта — как у подсказок и сообщения
 * коммита (`shared/inline-ai.ts`, `shared/commit-message.ts`).
 */

/** Длина названия: в полосе вкладок больше не читается, а место занимает. */
export const CHAT_TITLE_MAX_CHARS = 60;
/** Потолок ответа: название — это строка. */
export const CHAT_TITLE_MAX_TOKENS = 60;
/** Сколько вопроса и ответа отдаём модели: сути хватает и в обрывке. */
export const CHAT_TITLE_SOURCE_MAX_CHARS = 2000;

/**
 * Правило для модели. Главное — потребовать ТОЛЬКО название: кавычки, «Тема:» и
 * markdown-ограждения иначе попадут в подпись вкладки, и их пришлось бы стирать.
 */
export const CHAT_TITLE_SYSTEM_PROMPT = [
  'Ты придумываешь короткое название для беседы с ассистентом-программистом.',
  'Верни ТОЛЬКО название: 2–6 слов, по-русски, без кавычек, без точки в конце,',
  'без markdown и без пояснений. Название должно говорить, о чём разговор по сути',
  '(«Починка сборки на macOS», «Переименование символов»), а не пересказывать первый',
  'вопрос дословно. Если по разговору темы не видно — верни пустую строку.',
].join('\n');

/** Что известно о начале беседы: первый вопрос и первый ответ. */
export interface ChatTitleParts {
  question: string;
  answer: string;
}

/** Промпт: пара «вопрос — ответ» в обрывках, каждый в своём пределе. */
export function buildTitlePrompt(parts: ChatTitleParts): string {
  const clip = (text: string): string =>
    text.length > CHAT_TITLE_SOURCE_MAX_CHARS ? `${text.slice(0, CHAT_TITLE_SOURCE_MAX_CHARS)}\n… (обрезано)` : text;
  return [`Вопрос: ${clip(parts.question.trim())}`, '', `Ответ: ${clip(parts.answer.trim())}`].join('\n');
}

/**
 * Очистить ответ модели: снять ограждения и кавычки, убрать служебное «Тема:»,
 * схлопнуть пробелы, обрезать по потолку. Пустая строка — названия нет.
 */
export function cleanChatTitle(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  // Ограждение могло прийти вокруг всего ответа — как у кода.
  const fence = /^```[^\n]*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = (fence[1] ?? '').trim();
  // Модели любят начинать с «Тема:» или «Название беседы:».
  text = text.replace(/^(?:тема|название(?: беседы)?|заголовок)\s*:\s*/i, '');
  // Первый абзац: остальное — уже пояснение, которому в подписи не место. Режем
  // именно по пустой строке, а не по первому переводу: модель могла свернуть
  // название на две строки, и терять вторую половину незачем.
  text = (text.split(/\n\s*\n/)[0] ?? '').trim();
  text = text
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/, '')
    .trim();
  // Кавычки снимаем в конце: так не тронем честные кавычки внутри названия.
  text = stripQuotes(text);
  if (text.length > CHAT_TITLE_MAX_CHARS) {
    text = `${text.slice(0, CHAT_TITLE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text;
}

/** Парные кавычки и звёздочки вокруг всего названия — это оформление, а не текст. */
function stripQuotes(text: string): string {
  let value = text.trim();
  const pairs: ReadonlyArray<[string, string]> = [
    ['«', '»'],
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['**', '**'],
  ];
  let changed = true;
  while (changed && value.length > 1) {
    changed = false;
    for (const [open, close] of pairs) {
      if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length - 1) {
        value = value.slice(open.length, value.length - close.length).trim();
        changed = true;
      }
    }
  }
  return value;
}

/**
 * Заголовок по первому вопросу — то, что ставится сразу, пока модель не назвала
 * беседу. Общая функция с renderer: по ней же видно, поставлен заголовок
 * автоматически или его уже дала модель.
 */
export function titleFromQuestion(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Новая беседа';
  return flat.length > 24 ? `${flat.slice(0, 23)}…` : flat;
}

/**
 * Заголовок всё ещё «по вопросу»? Тогда его можно заменить названием от модели.
 * Если человек видел в ленте наименование от модели (или беседа пришла из файла
 * с ним), трогать его не нужно.
 */
export function isAutoTitle(title: string, firstQuestion: string): boolean {
  return title === titleFromQuestion(firstQuestion);
}
