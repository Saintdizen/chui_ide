/**
 * Навыки проекта: готовые сценарии работы, которые агент подгружает по надобности.
 *
 * Зачем отдельно от правил проекта: правила (`.ai_rules`, `AGENTS.md`) читаются
 * ЦЕЛИКОМ в каждый запрос. Файл на триста строк про git, тесты и выпуск релиза
 * съедает контекст даже тогда, когда речь о правке одной строки в CSS. Навык —
 * то же самое знание, но двумя частями: короткая строка в каталоге (её агент
 * видит всегда) и тело (его он просит инструментом `read_skill`, когда сценарий
 * действительно нужен). Платим за то, что используем.
 *
 * Файл навыка — `SKILL.md` в своей папке: `.../skills/<имя>/SKILL.md`. Годится и
 * одиночный `<имя>.md` — так короче заводить маленькие навыки.
 *
 * Начало файла — необязательная шапка между строками `---`:
 *
 *     ---
 *     name: release
 *     description: Как выпускать версию: коммит, тег, публикация
 *     ---
 *     # Выпуск версии
 *     …
 *
 * Шапки может не быть: тогда имя берётся из имени папки (или файла), а описание —
 * из первого абзаца тела. Навык без имени или без тела не существует: пустая
 * заготовка в каталоге только сбивает агента.
 *
 * Здесь только правило и текст: чтение с диска — дело main (`main/ai/skills.ts`).
 * Поэтому модуль чистый и проверяется без Electron.
 */

/** Область навыка: свой в проекте или общий для всех проектов. */
export type SkillScope = 'workspace' | 'global';

/** Один навык: строка каталога и путь, по которому читается тело. */
export interface SkillEntry {
  /** Имя для `read_skill`: латиница, цифры, дефис. Приводится к нижнему регистру. */
  name: string;
  /** Одна строка о том, когда этот навык нужен: по ней агент и выбирает. */
  description: string;
  /** Абсолютный путь к файлу навыка. */
  path: string;
  scope: SkillScope;
}

/** Имя длиннее — это уже заголовок, а не имя: в вызове инструмента его не набрать. */
export const MAX_SKILL_NAME = 64;
/** Описание — одна строка каталога. Длинное вытеснит из промпта другие навыки. */
export const MAX_SKILL_DESCRIPTION = 200;
/** Сколько навыков видит агент. Дальше каталог сам становится простынёй. */
export const MAX_SKILLS = 40;
/** Потолок тела навыка: сценарий — это инструкция, а не книга. */
export const MAX_SKILL_BODY_CHARS = 24_000;

/**
 * Привести имя к виду, в котором его можно назвать в вызове: нижний регистр,
 * пробелы и подчёркивания — дефисы, всё постороннее выброшено.
 */
export function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_NAME);
}

/** Значение из шапки без кавычек и лишних пробелов: `name: "release"` — тоже имя. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

interface ParsedSkillFile {
  /** Поля шапки: нужны только `name` и `description`, остальное не наше дело. */
  fields: Map<string, string>;
  /** Тело без шапки. */
  body: string;
}

/**
 * Разделить файл на шапку и тело. Шапка — только если файл НАЧИНАЕТСЯ со строки
 * `---`: дефисы в середине текста (разделитель в markdown) шапкой не считаются.
 */
function splitFrontMatter(text: string): ParsedSkillFile {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const fields = new Map<string, string>();
  if ((lines[0] ?? '').trim() !== '---') return { fields, body: text };

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') {
      end = index;
      break;
    }
    const line = lines[index]!;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!key) continue;
    fields.set(key, unquote(line.slice(colon + 1)));
  }
  // Шапка не закрыта — значит это не шапка, а обычный текст с дефисами.
  if (end < 0) return { fields: new Map(), body: text };
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/**
 * Первый абзац тела как описание — для файлов без шапки. Заголовки и списки
 * пропускаем: `# Выпуск версии` ничего не говорит о том, КОГДА навык нужен,
 * а вот первая строка-пояснение говорит.
 */
function firstParagraph(body: string): string {
  const parts: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (parts.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('```')) continue;
    parts.push(line.replace(/^[-*+]\s+/, ''));
    if (parts.join(' ').length >= MAX_SKILL_DESCRIPTION) break;
  }
  return parts.join(' ').trim();
}

/**
 * Разобрать файл навыка. `fallbackName` — имя папки (или файла без расширения):
 * им пользуемся, когда шапки нет или в ней не сказано имя.
 *
 * `null` — это не навык: нет ни имени, ни тела, либо имя после приведения пустое.
 */
export function parseSkillFile(
  text: string,
  options: { fallbackName: string; path: string; scope: SkillScope },
): SkillEntry | null {
  const { fields, body } = splitFrontMatter(text);
  if (!body.trim()) return null;

  const rawName = fields.get('name') ?? options.fallbackName;
  const name = normalizeSkillName(rawName) || normalizeSkillName(options.fallbackName);
  if (!name) return null;

  const described = (fields.get('description') ?? '').replace(/\s+/g, ' ').trim();
  const description = (described || firstParagraph(body)).slice(0, MAX_SKILL_DESCRIPTION);
  // Без описания навык не выбрать: строка каталога из одного имени ничего не обещает.
  if (!description) return null;

  return { name, description, path: options.path, scope: options.scope };
}

/** Тело навыка для агента: без шапки (она уже показана в каталоге) и с потолком. */
export function skillBody(text: string): string {
  const { body } = splitFrontMatter(text);
  const trimmed = body.trim();
  return trimmed.length > MAX_SKILL_BODY_CHARS ? trimmed.slice(0, MAX_SKILL_BODY_CHARS) : trimmed;
}

/**
 * Навык по имени вызова: без учёта регистра и с той же нормализацией, что при
 * разборе (`Release Notes` в имени папки — это `release-notes` в вызове).
 */
export function findSkill(skills: readonly SkillEntry[], name: string): SkillEntry | null {
  const wanted = normalizeSkillName(name);
  if (!wanted) return null;
  return skills.find((skill) => skill.name === wanted) ?? null;
}

/**
 * Каталог навыков для системного промпта: имя и одна строка о каждом. Тела здесь
 * нет — агент просит его инструментом, когда навык понадобился.
 *
 * `null` — навыков нет: пустой заголовок в промпте только занимает место.
 */
export function formatSkillCatalog(skills: readonly SkillEntry[]): string | null {
  if (skills.length === 0) return null;
  const lines = skills.slice(0, MAX_SKILLS).map((skill) => `- ${skill.name} — ${skill.description}`);
  return [
    'Навыки — готовые сценарии работы в этом проекте. Здесь только их список: тело навыка',
    'прочитай инструментом read_skill, когда он действительно нужен, а не на всякий случай.',
    ...lines,
  ].join('\n');
}
