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

/** Что из путей проекта считаем существующим: всё, что есть на диске. */
export interface ProjectPaths {
  /** Относительные POSIX-пути файлов. */
  files: readonly string[];
  /** Каталоги проекта (без корня, относительно него же). */
  dirs?: readonly string[];
  /**
   * Обход упёрся в потолок — `files` и `dirs` неполны. По такому списку ссылки
   * не проверяем: отсутствие в обрезанном списке — не отсутствие в проекте.
   */
  truncated?: boolean;
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
  // каждая ссылка в правилах объявляется битой. Список обрезан потолком обхода —
  // тоже молчим: отсутствие в неполном списке не значит отсутствие на диске.
  //
  // Почему не `paths.files.length > LINK_CHECK_MAX_FILES`, как было раньше:
  // обход упирается в потолок и возвращает ровно `MAX_SCAN_FILES` файлов — условие
  // `>` не срабатывало никогда. Живой пример: существующий `zzz-last/a.ts` на
  // проекте из 20000 файлов объявлялся битым. Знать это точно может только сканер.
  if (paths.files.length === 0 || paths.truncated) return [];

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

export function formatInstructionFile(name: string, text: string, room: number, folder = ''): string {
  return formatInstructionScoped(name, text, room, folder);
}

/**
 * То же, но с пометкой папки: правило из `src/AGENTS.md` действует только там,
 * и без пометки модель приняла бы его за правило всего проекта (`''` — корень).
 */
export function formatInstructionScoped(name: string, text: string, room: number, folder = ''): string {
  const where = scopeOf(folder);
  return formatInstructionBody(name, text, room, where);
}

function formatInstructionBody(name: string, text: string, room: number, where: string): string {
  const budget = Math.max(400, room);
  if (text.length <= budget) return `Инструкции из ${name}${where}:\n${text}`;
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
    `Инструкции из ${name}${where}:\n${head}\n` +
    `… (правила длиннее, чем можно показать целиком — ${text.length} симв.; ${map} ` +
    `Нужное из отброшенного ищи по этому файлу: search с path=${name} или read с диапазоном строк.)`
  );
}

/** ` (в src/lib)` — так правило подпапки не путается с правилом всего проекта. */
function scopeOf(folder: string): string {
  const clean = normalizeInstructionFolder(folder);
  return clean ? ` (действуют в ${clean} и ниже)` : '';
}

/** Папка от корня проекта: без `./`, без слешей по краям, всегда через `/`. */
export function normalizeInstructionFolder(folder: string | undefined): string {
  return (folder ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Правило папки действует в ней самой и ниже, но не выше: `src/AGENTS.md` —
 * не про `tests`. Правило корня действует везде.
 */
export function instructionAppliesTo(ruleFolder: string, folder: string): boolean {
  const rule = normalizeInstructionFolder(ruleFolder);
  if (!rule) return true;
  const here = normalizeInstructionFolder(folder);
  return here === rule || here.startsWith(`${rule}/`);
}

/**
 * Папка для набора правил по пути файла: `src/app/main.ts` → `src/app`. Файл вне
 * корня — это корень: правила чужого дерева к проекту не относятся.
 */
export function instructionScopeOf(file: string, root: string): string {
  const path = file.replace(/\\/g, '/');
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!base || !path.startsWith(`${base}/`)) return '';
  const rel = path.slice(base.length + 1);
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? '' : normalizeInstructionFolder(rel.slice(0, cut));
}

/** Набор правил, который видит агент в папке: из неё и всех родительских, плюс корень. */
export function instructionFoldersFor(folder: string, at?: (dir: string) => boolean): string[] {
  const clean = normalizeInstructionFolder(folder);
  if (!clean) return [''];
  const parts = clean.split('/').filter(Boolean);
  const out: string[] = [''];
  for (let count = 1; count <= parts.length; count += 1) {
    const dir = parts.slice(0, count).join('/');
    // Не всякая папка на пути существует как папка проекта (`src` бывает путём файла).
    if (at && !at(dir)) continue;
    out.push(dir);
  }
  return out;
}
