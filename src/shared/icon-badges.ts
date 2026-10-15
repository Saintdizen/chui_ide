/**
 * Значки поверх дерева — от чужих наборов, а не от самой IDE.
 *
 * К своим украшениям дерево знает всё: git-буква у файла, точка у папки с правками,
 * значок подмодуля, приглушение игнорируемых. Но у проектов есть свои пометки:
 * «сгенерировано», «не трогать», «черновик», «это мокап», «здесь точка входа».
 * IDE их придумать не может — их приносит человек или сторонний набор (как тема
 * значков в других редакторах кладёт рядом JSON с правилами).
 *
 * Здесь — правила и разбор такого набора. Правило: маска пути и что рисовать —
 * короткую подпись (`TODO`, `mock`, `⚙`), цвет из роли палитры и необязательную
 * подсказку. Логика чистая: ни DOM, ни ФС, поэтому проверяется тестами, а дерево
 * лишь рисует то, что нашлось.
 *
 * Маска сверяется и с именем файла, и с путём от корня — как у исключений дерева
 * (`explorer.exclude`): `*.min.js` отсеет минифицированные, а `generated/**` —
 * папку целиком. Регистр не важен.
 */

/** Цвет значка берётся из роли палитры: обе схемы и тема из файла остаются согласованными. */
export type BadgeColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray';

export const BADGE_COLORS: readonly BadgeColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'];

/** Одно правило: что считать и что показывать. */
export interface IconBadgeRule {
  /** Маска: имя файла или путь от корня (`*.generated.ts`, `src/api/**`). */
  pattern: string;
  /** Короткая подпись на значке: 1–3 знака (`M`, `gen`, `⚙`). Пусто — просто точка. */
  badge?: string;
  /** Цвет значка. */
  color: BadgeColor;
  /** Подсказка при наведении: словами, что это за пометка. */
  title?: string;
}

/** Потолок правил: чужие наборы бывают большими, а дереву нужен короткий поиск. */
export const MAX_BADGE_RULES = 200;

/** Подпись значка не длиннее этого: в строке дерева больше не читается. */
const MAX_BADGE_CHARS = 3;

/** Привести цвет к известному: чужой набор может назвать его как угодно. */
function normalizeColor(value: unknown): BadgeColor {
  return BADGE_COLORS.includes(value as BadgeColor) ? (value as BadgeColor) : 'gray';
}

/** Маска в регулярное выражение: `*`, `?` и `**` — как у исключений дерева. */
function maskToRegExp(pattern: string): RegExp {
  const source = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^(?:${source})$`, 'i');
}

/**
 * Разбор списка правил. `fallbackColor` — цвет для правил без цвета: набор может
 * задавать только маски.
 */
export function sanitizeBadgeRules(raw: unknown, fallbackColor: BadgeColor = 'gray'): IconBadgeRule[] {
  if (!Array.isArray(raw)) return [];
  const result: IconBadgeRule[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.pattern !== 'string' || value.pattern.trim() === '') continue;
    const rule: IconBadgeRule = { pattern: value.pattern.trim(), color: normalizeColor(value.color ?? fallbackColor) };
    if (typeof value.badge === 'string' && value.badge.trim() !== '') {
      rule.badge = [...value.badge.trim()].slice(0, MAX_BADGE_CHARS).join('');
    }
    if (typeof value.title === 'string' && value.title.trim() !== '') rule.title = value.title.trim();
    result.push(rule);
    if (result.length >= MAX_BADGE_RULES) break;
  }
  return result;
}

/**
 * Разобрать набор значков из JSON-файла: он приходит от человека или сторонней
 * программы, поэтому структура проверяется. Принимаем два вида: массив правил и
 * объект с полем `badges` (как тема значков) — оба короткие и читаемые.
 */
export function parseBadgeTheme(text: string): { ok: true; rules: IconBadgeRule[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Это не JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null
      ? (raw as { badges?: unknown }).badges
      : undefined;
  if (!Array.isArray(list)) {
    return {
      ok: false,
      error: 'Нужен массив правил или объект с полем `badges`: `[{ pattern, badge, color, title }]`',
    };
  }
  const rules = sanitizeBadgeRules(list);
  if (rules.length === 0) return { ok: false, error: 'В наборе нет ни одного правила с маской (pattern)' };
  return { ok: true, rules };
}

/**
 * Значок для пути: первое подошедшее правило. Порядок правил — приоритет: человек
 * ставит частное выше общего, и это предсказуемее «самого длинного совпадения».
 * `relative` — путь от корня (по нему работают маски вида `src/api/**`).
 */
export function badgeFor(path: string, relative: string, rules: readonly IconBadgeRule[]): IconBadgeRule | null {
  if (rules.length === 0) return null;
  const name = path.split(/[/\\]/).pop() ?? path;
  for (const rule of rules) {
    const regexp = maskToRegExp(rule.pattern);
    if (regexp.test(name) || regexp.test(relative) || regexp.test(path)) return rule;
  }
  return null;
}

/** Подсказка значка: своя подпись правила, иначе — сам образец маски. */
export function badgeTitle(rule: IconBadgeRule): string {
  return rule.title ?? `Правило значка: ${rule.pattern}`;
}
