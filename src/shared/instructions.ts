/**
 * Файлы правил проекта в системном промпте: целиком, если влезают, иначе —
 * голова и карта разделов.
 *
 * Раньше длинный файл просто резался по символу: модель получала правила,
 * оборванные посреди фразы, и не знала ни того, что дальше есть ещё, ни как
 * дочитать — при том что файл лежит в проекте и читается обычным `read_file`.
 * Здесь отброшенная часть не исчезает без адреса: вместо неё едет список
 * разделов и подсказка, чем их достать. Хвост правил при этом дешевле не
 * становится — он становится находимым.
 */

/** Сколько места в начале файла отдаём под сами правила (доля от доступного). */
const HEAD_SHARE = 0.7;
/** Раздел длиннее не перечисляем: в карте нужен ориентир, а не заголовок-рассказ. */
const MAX_SECTION_CHARS = 90;
/** Больше разделов — уже не карта, а второй файл. */
const MAX_SECTIONS = 24;

/** Строка похожа на заголовок: markdown-раздел или строка-подпись с двоеточием. */
function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  // Жирная строка целиком (`**Правила**`) — тоже раздел, так пишут и в .ai_rules.
  if (/^\*\*[^*]{3,}\*\*:?$/.test(trimmed)) return true;
  return /^[A-ZА-ЯЁ][^.!?]{2,60}:$/.test(trimmed);
}

/** Обрезать по границе строки, чтобы не оборвать фразу на середине слова. */
function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const line = slice.lastIndexOf('\n');
  return line > limit / 2 ? slice.slice(0, line) : slice;
}

/**
 * Текст файла правил для промпта.
 *
 * `room` — сколько символов можно занять. Файл длиннее — показываем голову
 * (большую часть доступного места) и карту разделов из остатка: по ней видно,
 * о чём файл дальше, и есть чем попросить продолжение.
 */
export function formatInstructionFile(name: string, text: string, room: number): string {
  const budget = Math.max(400, room);
  if (text.length <= budget) return `Инструкции из ${name}:\n${text}`;

  const head = cutAtLine(text, Math.floor(budget * HEAD_SHARE));
  const rest = text.slice(head.length);
  const sections: string[] = [];
  for (const line of rest.split('\n')) {
    if (!isHeading(line)) continue;
    const title = line.trim().slice(0, MAX_SECTION_CHARS);
    if (sections.includes(title)) continue;
    sections.push(title);
    if (sections.length >= MAX_SECTIONS) break;
  }
  const map =
    sections.length > 0
      ? `дальше в файле разделы: ${sections.join(' · ')}.`
      : 'дальше в файле продолжение без заголовков.';
  return (
    `Инструкции из ${name}:\n${head}\n` +
    `… (правила длиннее, чем можно показать целиком — ${text.length} симв.; ${map} ` +
    `Нужное из отброшенного ищи по этому файлу: search с path=${name} или read_file с диапазоном строк.)`
  );
}
