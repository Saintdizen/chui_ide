/**
 * Тема из файла: формат, разбор и проверка.
 *
 * Формат — свой, но нарочно простой: JSON с именем и ЧАСТИЧНЫМИ
 * переопределениями наших ролей. Полный файл даёт «Сохранить шаблон…»: человек
 * берёт рабочую тему, правит цвета и импортирует обратно.
 *
 * Ключи ролей объявлены ЗДЕСЬ, а не в `renderer/core/theme.ts`: список нужен и
 * main-процессу (проверить тему при сохранении в настройки), а renderer в main не
 * тянется. Совпадение с реальными ролями стережёт `tests/theme-file.test.ts`.
 *
 * Цвета задаются как `#RGB`, `#RRGGBB` или `#RRGGBBAA` — как их пишут руками.
 * Внутри палитры (`core/theme.ts`) значения живут без `#`, и разбор снимает его сам.
 */

/** Роли обвязки: поверхности, текст, акценты, git. Порядок — как в `core/theme.ts`. */
export const CHROME_KEYS = [
  'background',
  'foreground',
  'lineNumber',
  'lineNumberActive',
  'cursor',
  'selection',
  'selectionInactive',
  'lineHighlight',
  'indentGuide',
  'indentGuideActive',
  'whitespace',
  'popover',
  'border',
  'separator',
  'sunken',
  'tint',
  'tintHover',
  'text',
  'textSecondary',
  'textTertiary',
  'placeholder',
  'textDisabled',
  'selectionFill',
  'accent',
  'accentFill',
  'accentText',
  'textOnFill',
  'purple',
  'error',
  'warning',
  'highlight',
  'highlightStrong',
  'added',
  'modified',
  'deleted',
  'scrollbar',
  'scrollbarHover',
  'scrollbarActive',
  'shadow',
] as const;
export type ChromeKey = (typeof CHROME_KEYS)[number];

/** Роли подсветки кода. */
export const TOKEN_KEYS = [
  'comment',
  'string',
  'number',
  'keyword',
  'keywordControl',
  'identifier',
  'function',
  'type',
  'constant',
  'tag',
  'attribute',
] as const;
export type TokenKey = (typeof TOKEN_KEYS)[number];

export interface ThemeFile {
  /** Имя для интерфейса. */
  name: string;
  /** Частичные переопределения ролей обвязки. */
  chrome: Partial<Record<ChromeKey, string>>;
  /** Частичные переопределения ролей подсветки кода. */
  tokens: Partial<Record<TokenKey, string>>;
}

export type ThemeParseResult = { ok: true; theme: ThemeFile } | { ok: false; error: string };

/** `#RGB`, `#RRGGBB` или `#RRGGBBAA` — других записей цвета в теме нет. */
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const MAX_NAME = 60;

/** `#RGB` разворачиваем в `#RRGGBB`; остальное — только в нижний регистр. */
function normalizeColor(hex: string): string {
  const body = hex.slice(1).toLowerCase();
  if (body.length === 3) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  return `#${body}`;
}

function asObject(
  value: unknown,
  label: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: {} };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: `«${label}» должен быть объектом` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function readColors<K extends string>(
  source: Record<string, unknown>,
  allowed: readonly K[],
  label: string,
): { ok: true; value: Partial<Record<K, string>> } | { ok: false; error: string } {
  const value: Partial<Record<K, string>> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!(allowed as readonly string[]).includes(key)) {
      return { ok: false, error: `неизвестная роль: «${label}.${key}»` };
    }
    if (typeof raw !== 'string' || !COLOR.test(raw.trim())) {
      return { ok: false, error: `«${label}.${key}» — не цвет вида #RRGGBB` };
    }
    value[key as K] = normalizeColor(raw.trim());
  }
  return { ok: true, value };
}

/** Разбор уже разобранного JSON (значение) — общий путь для файла и настроек. */
export function parseThemeObject(input: unknown): ThemeParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'тема — это объект JSON' };
  }
  const source = input as Record<string, unknown>;

  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) return { ok: false, error: 'не задано имя темы («name»)' };
  if (name.length > MAX_NAME) return { ok: false, error: `имя темы длиннее ${MAX_NAME} символов` };

  // Схема в приложении одна — тёмная. Старый файл со `"scheme": "dark"` читаем
  // (поле лишнее, но безвредное), а светлую схему отвергаем: её больше нет.
  const { scheme } = source;
  if (scheme !== undefined && scheme !== 'dark') {
    return { ok: false, error: 'светлой схемы нет: приложение работает в тёмной, «scheme» — только «dark»' };
  }

  const chromeSource = asObject(source.chrome, 'chrome');
  if (!chromeSource.ok) return { ok: false, error: chromeSource.error };
  const tokensSource = asObject(source.tokens, 'tokens');
  if (!tokensSource.ok) return { ok: false, error: tokensSource.error };

  const chrome = readColors(chromeSource.value, CHROME_KEYS, 'chrome');
  if (!chrome.ok) return { ok: false, error: chrome.error };
  const tokens = readColors(tokensSource.value, TOKEN_KEYS, 'tokens');
  if (!tokens.ok) return { ok: false, error: tokens.error };

  return { ok: true, theme: { name, chrome: chrome.value, tokens: tokens.value } };
}

/** Разбор текста файла темы. */
export function parseThemeFile(text: string): ThemeParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'файл не читается как JSON' };
  }
  return parseThemeObject(raw);
}

/**
 * Для настроек: значение могло быть правлено руками или записано старой версией.
 * `null`/`undefined` — темы нет; испорченное значение тоже читаем как «нет темы»,
 * чтобы одна опечатка не уносила окно настроек.
 */
export function sanitizeThemeFile(value: unknown): ThemeFile | null {
  if (value === null || value === undefined) return null;
  const result = parseThemeObject(value);
  if (!result.ok) return null;
  // Тема без единой роли ничего не задаёт: считаем её отсутствующей, а не активной.
  const { chrome, tokens } = result.theme;
  if (Object.keys(chrome).length === 0 && Object.keys(tokens).length === 0) return null;
  return result.theme;
}

export function serializeThemeFile(theme: ThemeFile): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}
