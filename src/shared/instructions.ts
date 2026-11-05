/**
 * Файлы правил проекта в системном промпте: целиком, если влезают, иначе —
 * голова и карта разделов.
 *
 * Раньше длинный файл просто резался по символу: модель получала правила,
 * оборванные посреди фразы, и не знала ни того, что дальше есть ещё, ни как
 * дочитать — при том что файл лежит в проекте и читается обычным `read`.
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
 * Всего файлов в списке, который считается полным, при котором проверяются ссылки.
 *
 * Проверка ссылок — подсказка, а не запрет: если список путей неполон (скан упёрся в
 * потолок, файлов больше MAX_SCAN_FILES), правило на живом пути объявят битым зря.
 * Пустой список — это не «в проекте пусто», а «путей не передали»: тоже молчим.
 */
const LINK_CHECK_MAX_FILES = 20_000;

/** Что из путей проекта считаем существующим: всё, что есть на диске. */
export interface ProjectPaths {
  /** Относительные POSIX-пути файлов. */
  files: readonly string[];
  /** Каталоги проекта (без корня, относительно него же). */
  dirs?: readonly string[];
}

/**
 * Ссылка в правилах: `src/app.ts`, `../shared/api.ts`, `tests/helpers/`.
 *
 * Берём только то, что похоже на путь, а не на речь: сегменты без пробелов, есть слэш
 * или известное расширение. Без слэша — только имена с расширением: одиночное `read`
 * или `tests` — это слово, а не путь, и краснеть на нём было бы стыдно.
 */
const PATH_IN_TEXT =
  /(?<![\w./-])(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+(?![\w/-])|(?<![\w./-])[\w-]+\.(?:[cm]?[jt]sx?|json|md|css|py|ya?ml|toml|sh)(?![\w/-])/g;

/**
 * Что в ссылке не путь, а шум: адреса, домены, числа.
 *
 * Список закрыт намеренно. Открыть его для всего, что «похоже на код», нельзя:
 * правила пишут люди, и ложная тревога на `example.com` или на `{a}/{b}` дороже,
 * чем пропущенная битая ссылка — та всё равно видна как текст в промпте.
 */
function isPathLike(token: string): boolean {
  if (token.includes('://') || token.startsWith('//')) return false;
  // Домен из двух частей с известным окончанием и без слэша — не файл.
  if (/^(?:[\w-]+\.(?:com|org|net|io|dev|ru|ai))$/i.test(token)) return false;
  // Шаблонные подстановки — по ним файла всё равно не искать.
  if (token.includes('{') || token.includes('}') || token.includes('$') || token.includes('*')) return false;
  // Имя без слэша — ссылка на файл, только если такого расширения в проекте не бывает
  // в виде версии: `v1.2.3` в правилах — это версия, а не файл на диске.
  if (!token.includes('/') && /^v?\d+(?:\.\d+)+$/.test(token)) return false;
  return true;
}

/** Путь ссылки к виду проекта: убрать `./` и начальный слэш, свести `..`. */
function normalizeLink(link: string): string {
  const parts = link.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Ссылка за пределы проекта ничего не доказывает: там нам нечем её проверить.
      if (out.length === 0) return '';
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Битые ссылки в тексте правил: те, которых нет среди путей проекта.
 *
 * Зачем это в промпте: правила ссылаются на файлы (`docs/api.md`, `src/config.ts`),
 * файл переименовали или удалили, а правило осталось. Человек читает его как
 * действующее и идёт по адресу, которого нет; модель получает то же самое. Ошибку
 * видно только при попытке прочитать — то есть уже потратив запрос.
 *
 * Возвращаются сами ссылки в порядке появления, без повторов.
 */
export function findBrokenLinks(text: string, paths: ProjectPaths): string[] {
  // Пустой список — это «путей не передали», а не «в проекте ничего нет»: иначе
  // каждая ссылка в правилах объявляется битой. Скан упёрся в потолок — тоже
  // молчим: на живом пути мы бы соврали.
  if (paths.files.length === 0 || paths.files.length > LINK_CHECK_MAX_FILES) return [];

  const known = new Set(paths.files);
  const dirs = new Set(paths.dirs ?? []);

  const broken: string[] = [];
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const raw = match[0];
    if (!isPathLike(raw)) continue;
    const link = normalizeLink(raw);
    if (!link || known.has(link) || dirs.has(link)) continue;
    // Ссылка без расширения — может быть каталогом, которого мы не знаем по имени.
    // Сверяем с каталогами файлов: всё, что не файл и не каталог, — битая.
    if (!broken.includes(raw)) broken.push(raw);
  }
  return broken;
}

/**
 * Строка-предупреждение о битых ссылках для промпта.
 *
 * Модель не может пройти по ссылке, чтобы увидеть, что её нет; правило с мёртвым
 * адресом она дочитает как действующее. Поэтому о таких ссылках говорим прямо и
 * НЕ переписываем сам текст правил: что перенёс файл — решает человек.
 */
export function describeBrokenLinks(name: string, links: readonly string[]): string {
  if (links.length === 0) return '';
  return (
    `Внимание: в правилах ${name} есть ссылки на отсутствующие в проекте пути: ${links.join(', ')}. ` +
    'Не выдумывай их содержимое и не используй эти адреса; скажи человеку, что ссылка устарела.'
  );
}

/**
 * Что из правил проекта реально ушло в контекст. В следе прогона нужны имя и
 * размер, а не текст: полный текст есть в файле, а без записи вообще нельзя
 * понять, откуда агент взял «в этом проекте так не делают».
 */
export interface AppliedInstruction {
  name: string;
  /** Сколько символов файла реально показано модели. */
  chars: number;
  /** Файл длиннее потолка: хвост модель увидит только через `read`. */
  truncated: boolean;
}

export function appliedInstruction(name: string, text: string, room: number): AppliedInstruction {
  const budget = Math.max(400, room);
  return { name, chars: Math.min(text.length, budget), truncated: text.length > budget };
}

/**
 * Отпечаток набора правил: по нему видно, поменялся ли он с прошлого хода.
 * Размер входит — иначе правка правила той же длины осталась бы незамеченной.
 */
export function instructionSignature(list: readonly AppliedInstruction[]): string {
  return list.map((item) => `${item.name}:${item.chars}`).join('|');
}

/**
 * Набор правил сменился с прошлого хода (или мы его ещё не видели).
 */
export function instructionsChanged(
  previous: readonly AppliedInstruction[] | undefined,
  next: readonly AppliedInstruction[],
): boolean {
  if (!previous) return true;
  return instructionSignature(previous) !== instructionSignature(next);
}

/**
 * Строки для ленты: какие правила видит модель и что с длинными файлами.
 * Пустой список — правил нет, и это тоже надо сказать: человек ищет файл, а его нет.
 */
export function appliedInstructionsLines(list: readonly AppliedInstruction[]): string[] {
  if (list.length === 0) {
    return [`правил не найдено: ${INSTRUCTION_FILE_NAMES}`];
  }
  const lines = list.map((item) => `${item.name} — ${formatSize(item.chars)}`);
  const cut = list.filter((item) => item.truncated).map((item) => item.name);
  if (cut.length > 0) lines.push(`показана голова: ${cut.join(', ')} — дальше модель читает файл сам`);
  return lines;
}

/** Имена файлов правил — одной строкой, чтобы подсказка в ленте не врала при их смене. */
const INSTRUCTION_FILE_NAMES = '.ai_rules, AGENTS.md, CHUI.md, CLAUDE.md';

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} симв.`;
  return `${(chars / 1000).toFixed(1).replace('.', ',')} тыс. симв.`;
}

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
    `Нужное из отброшенного ищи по этому файлу: search с path=${name} или read с диапазоном строк.)`
  );
}
