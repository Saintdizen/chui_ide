import { TOKEN_KEYS, type ChromeKey, type ThemeFile, type TokenKey } from '../../shared/theme-file';

export type Scheme = 'dark' | 'light';

/**
 * Палитра консоли: цвета ANSI и служебные цвета полотна. Раньше этот тип давал xterm;
 * теперь он живёт здесь, вместе с данными палитры: терминал у нас свой, а консольная
 * схема — часть общей темы.
 */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Переопределения активной темы из файла. Значения — HEX без `#` (как в самой
 * палитре ниже). Пусто — работают встроенные роли. Хранятся рядом с палитрой, а
 * не в сервисе темы: их читают и подсветка кода в чате (`tokenStyle`), и тема из
 * файла (`themeCssVariables`), которым сервис недоступен.
 */
let chromeOverrides: Partial<Record<ChromeKey, string>> = {};
let tokenOverrides: Partial<Record<TokenKey, string>> = {};

const withoutHash = (value: string): string => (value.startsWith('#') ? value.slice(1) : value);

/**
 * Включить переопределения темы из файла; `null` — вернуть встроенную палитру.
 * Вызывается до перерисовки редактора и чата — там уже читают новые значения.
 */
export function setThemeOverrides(theme: ThemeFile | null): void {
  chromeOverrides = {};
  tokenOverrides = {};
  if (!theme) return;
  for (const [key, value] of Object.entries(theme.chrome)) {
    chromeOverrides[key as ChromeKey] = withoutHash(value);
  }
  for (const [key, value] of Object.entries(theme.tokens)) {
    tokenOverrides[key as TokenKey] = withoutHash(value);
  }
}

/**
 * Подсветка кода — цвета VS Code (Dark+ и Light+).
 *
 * Здесь лежат ИСХОДНЫЕ значения VS Code: перед применением их прогоняет `vivid()`,
 * который поднимает насыщенность и яркость. Так и Monaco, и чат в одном проекте
 * получают один и тот же цвет, а таблица остаётся узнаваемой палитрой VS Code.
 */
type TokenRules = Record<TokenKey, string>;

const VSCODE_DARK_TOKENS: TokenRules = {
  comment: '6a9955',
  string: 'ce9178',
  number: 'b5cea8',
  keyword: '569cd6',
  keywordControl: 'c586c0',
  identifier: '9cdcfe',
  function: 'dcdcaa',
  type: '4ec9b0',
  constant: '4fc1ff',
  tag: '569cd6',
  attribute: '9cdcfe',
};

/**
 * Светлая палитра. От VS Code Light+ отличается ровно двумя значениями —
 * `number` и `type`: их оригинальные тона (#098658, #267F99) на белом дают
 * 4.14:1 и 4.25:1, то есть ниже нормы 4.5:1 для обычного текста (WCAG AA).
 * Взяты те же оттенки на ступень темнее — это не своя палитра, а починка
 * контраста; обе ступени стережёт тест `tests/theme.test.ts`.
 */
const VSCODE_LIGHT_TOKENS: TokenRules = {
  comment: '008000',
  string: 'a31515',
  number: '0a7a4d',
  keyword: '0000ff',
  keywordControl: 'af00db',
  identifier: '001080',
  function: '795e26',
  type: '22768d',
  constant: '0070c1',
  tag: '800000',
  attribute: 'e50000',
};

/* ── насыщенность и яркость ─────────────────────────────────────────────── */

/**
 * Одна ступень усиления палитры VS Code — не своя палитра: оттенки остаются
 * теми же, растут только насыщенность и (в тёмной схеме) светлота.
 *
 * Зачем: в чате блок кода лежит на более тёмной подложке, чем полотно
 * редактора, и цвета Dark+ на ней читаются вяло. Усиление применяется к палитре
 * целиком, поэтому редактор и чат остаются согласованными. Под правило попадают
 * те роли, которые мы объявляем ниже; редкие области (операторы, шаблонные
 * строки и прочее) остаются ровно как в VS Code — их берёт базовая тема Monaco.
 */
const VIVID_SATURATION = 1.1;
const VIVID_SATURATION_STEP = 0.06;
const VIVID_LIGHTNESS = 0.14;

/** `RRGGBB` → каналы в долях. */
function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/** Цвет → тон в градусах, насыщенность и светлота в долях. */
function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) return [0, 0, lightness];

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;

  return [hue * 60, saturation, lightness];
}

/** Обратно в `#RRGGBB`. */
function toHex(hue: number, saturation: number, lightness: number): string {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness - c / 2;

  let rgb: [number, number, number] = [0, 0, 0];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  const part = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/**
 * Цвет VS Code одной ступенью ярче и насыщеннее. На белом «ярче» означает
 * «глубже», поэтому в светлой схеме светлота не меняется — только насыщенность,
 * иначе светлые тона вымывались бы в пастель.
 */
export function vivid(hex: string, scheme: Scheme): string {
  const [hue, saturation, lightness] = toHsl(hex);
  const nextSaturation = Math.min(1, saturation * VIVID_SATURATION + VIVID_SATURATION_STEP);
  const nextLightness = scheme === 'dark' ? lightness + (1 - lightness) * VIVID_LIGHTNESS : lightness;
  return toHex(hue, nextSaturation, nextLightness);
}

function vividTokens(source: TokenRules, scheme: Scheme): TokenRules {
  const out = {} as TokenRules;
  for (const key of Object.keys(source) as Array<keyof TokenRules>) {
    out[key] = vivid(source[key], scheme).slice(1);
  }
  return out;
}

/**
 * Соответствие типов токенов палитре — ОДИН список на две задачи: из него
 * собираются правила темы Monaco и по нему красится код в чате. Держать две
 * таблицы рядом с одинаковыми значениями — верный способ их развести.
 * Порядок важен: частное правило идёт раньше общего (`keyword.control` до `keyword`).
 */
interface TokenRule {
  prefix: string;
  key: keyof TokenRules;
  italic?: boolean;
  bold?: boolean;
}

/**
 * Нецветовые признаки: часть ролей различается ещё и начертанием, чтобы код
 * читался, даже если убрать цвет (дальтонизм, чёрно-белая печать, тема в
 * оттенках серого). Комментарии — курсив (принято в VS Code), ключевые слова —
 * полужирные (принято в IntelliJ). Это не украшение: признак несёт ту же роль,
 * что и краска, и поэтому живёт рядом с цветом в одной таблице.
 */
const TOKEN_RULES: readonly TokenRule[] = [
  { prefix: 'comment', key: 'comment', italic: true },
  { prefix: 'string.escape', key: 'string' },
  { prefix: 'string', key: 'string' },
  { prefix: 'regexp', key: 'string' },
  { prefix: 'number', key: 'number' },
  // VS Code красит управляющие конструкции отдельно от const/let/class.
  { prefix: 'keyword.flow', key: 'keywordControl', bold: true },
  { prefix: 'keyword.control', key: 'keywordControl', bold: true },
  { prefix: 'keyword', key: 'keyword', bold: true },
  { prefix: 'type.identifier', key: 'type' },
  { prefix: 'type', key: 'type' },
  { prefix: 'function', key: 'function' },
  { prefix: 'constant', key: 'constant' },
  { prefix: 'tag', key: 'tag' },
  { prefix: 'attribute.name', key: 'attribute' },
  { prefix: 'annotation', key: 'identifier' },
  // Имена переменных в VS Code того же цвета, что идентификаторы: отдельной
  // краски у роли нет, но правило нужно — иначе `variable` из своих
  // грамматик (Makefile, shell) остаётся неокрашенным.
  { prefix: 'variable', key: 'identifier' },
  { prefix: 'identifier', key: 'identifier' },
];

/**
 * Палитра в том виде, в каком её читают Monaco и чат: цвета VS Code, поднятые
 * `vivid()`. Одно значение на две задачи — держать две таблицы рядом с
 * одинаковыми числами верный способ их развести.
 */
const VIVID_TOKENS: Record<Scheme, TokenRules> = {
  dark: vividTokens(VSCODE_DARK_TOKENS, 'dark'),
  light: vividTokens(VSCODE_LIGHT_TOKENS, 'light'),
};

function tokensFor(scheme: Scheme): TokenRules {
  // На тему из файла правило накладывается поверх: её цвета берём как заданы,
  // без усиления `vivid` — человек назвал их сам.
  return { ...VIVID_TOKENS[scheme], ...tokenOverrides };
}

/** Правило токена: частное (`keyword.control`) важнее общего (`keyword`). */
function ruleFor(tokenType: string): TokenRule | undefined {
  const type = tokenType.toLowerCase();
  return TOKEN_RULES.find((item) => type === item.prefix || type.startsWith(`${item.prefix}.`));
}

/**
 * Оформление токена для подсветки В ЧАТЕ: цвет плюс нецветовые признаки.
 *
 * Тут мы красим сами, а не просим Monaco отрисовать разметку: цвета его разметки
 * живут в отдельной таблице стилей, а если та не применилась — весь код в чате
 * остаётся белым, хотя токены размечены правильно. Начертание отдаём вместе с
 * цветом, иначе чат и редактор расходились бы: в редакторе комментарий курсивный
 * и ключевое слово полужирное, а в чате — нет.
 */
export interface TokenStyle {
  /** `null` — цвет по умолчанию (цвет текста). */
  color: string | null;
  italic: boolean;
  bold: boolean;
}

export function tokenStyle(scheme: Scheme, tokenType: string): TokenStyle {
  const rule = ruleFor(tokenType);
  if (!rule) return { color: null, italic: false, bold: false };
  return {
    color: `#${tokensFor(scheme)[rule.key]}`,
    italic: rule.italic === true,
    bold: rule.bold === true,
  };
}

/** Цвет токена — то же оформление без начертания (см. `tokenStyle`). */
export function tokenColor(scheme: Scheme, tokenType: string): string | null {
  return tokenStyle(scheme, tokenType).color;
}

/**
 * Роль палитры для типа токена. Нужна нашему редактору: он ставит на корень
 * переменные цветов по ролям, а каждый токен получает класс этой роли — и краску
 * берёт переменной, а не строкой стиля на каждый знак (см. `editor/style.ts`).
 */
export function tokenKeyFor(tokenType: string): TokenKey | null {
  return ruleFor(tokenType)?.key ?? null;
}

/** Цвета всех ролей подсветки в текущей схеме — с учётом переопределений из файла. */
export function tokenPalette(scheme: Scheme): Record<TokenKey, string> {
  const rules = tokensFor(scheme);
  const out = {} as Record<TokenKey, string>;
  for (const key of TOKEN_KEYS) out[key] = `#${rules[key]}`;
  return out;
}

/**
 * Оформление редактора и его всплывающих слоёв. Значения повторяют токены
 * `styles/theme.css` — Monaco не читает CSS-переменные, — поэтому у каждого поля
 * назван токен, который оно повторяет: при правке палитры менять нужно в обоих
 * местах. Полотно, гуттер и цвета кода остаются как в VS Code: подсветка кода
 * живёт по правилам VS Code, а обвязка редактора — по нашим.
 */
interface Chrome extends Record<ChromeKey, string> {
  /* полотно и код — цвета VS Code */
  background: string;
  foreground: string;
  lineNumber: string;
  lineNumberActive: string;
  cursor: string;
  selection: string;
  selectionInactive: string;
  lineHighlight: string;
  indentGuide: string;
  indentGuideActive: string;
  whitespace: string;

  /* всплывающие слои: меню, палитра F1, подсказки, поиск, поля */
  popover: string; // --popup_background
  border: string; // --border_color
  separator: string; // --separator_color
  sunken: string; // --sunken_background
  tint: string; // --element_background
  tintHover: string; // --element_background_hover
  text: string; // --text_color
  textSecondary: string; // --text_color_secondary
  textTertiary: string; // --text_color_tertiary
  placeholder: string; // --placeholder_text_color
  textDisabled: string; // --text_color_disabled
  selectionFill: string; // --selection_background
  accent: string; // --blue_prime_background
  accentFill: string; // --accent_fill
  accentText: string; // --link_color
  textOnFill: string; // --text_color_hover
  purple: string; // --purple_prime_background
  error: string; // --red_prime_background
  warning: string; // --yellow_prime_background
  highlight: string; // --highlight_background
  highlightStrong: string; // текущее совпадение поиска
  added: string; // --git_added
  modified: string; // --git_modified
  deleted: string; // --git_deleted
  scrollbar: string;
  scrollbarHover: string;
  scrollbarActive: string;
  shadow: string;
}

const DARK_CHROME: Chrome = {
  background: '1e1e1e',
  foreground: 'd4d4d4',
  lineNumber: '858585',
  lineNumberActive: 'c6c6c6',
  cursor: 'aeafad',
  selection: '264f78',
  selectionInactive: '3a3d41',
  lineHighlight: '282828',
  indentGuide: '2b2b2b',
  indentGuideActive: '6a6a6a',
  whitespace: '3b3b3b',

  // Карточка интерфейса — та же поверхность, что у наших попапов: без прозрачности.
  // Значение совпадает с `--surface_popup` в `styles/theme.css` (#2c2c2e): виджеты
  // редактора и наши дропдауны должны читаться как один и тот же слой. Прозрачность и
  // блюр наших попапов сюда не переносятся — виджет редактора лежит над живым кодом, и
  // размытие пришлось бы пересчитывать на каждой правке (см. README о попапах Monaco).
  popover: '2c2c2e',
  border: '313134',
  separator: '545458a6',
  sunken: '00000033',
  tint: '78788052',
  tintHover: '7878805c',
  text: 'ffffffeb',
  textSecondary: 'ffffffb3',
  textTertiary: 'ffffff85',
  placeholder: 'ffffff7a',
  textDisabled: 'ffffffb3',
  // color-mix(синий 30 %, карточка): та же заливка, что у строки дерева и вкладки.
  selectionFill: '154162',
  accent: '0091ff',
  accentFill: '0a63e6',
  accentText: '4da6ff',
  textOnFill: 'ffffff',
  purple: 'db34f2',
  error: 'ff4245',
  warning: 'ffd600',
  highlight: 'ffd6003d',
  highlightStrong: 'ffd60073',
  // Цвета изменений — те же, что `--git_*` в styles/theme.css (#30D158, #FFD600, #FF4245).
  added: '30D158', // --git_added
  modified: 'FFD600', // --git_modified
  deleted: 'FF4245', // --git_deleted
  scrollbar: '79797966',
  scrollbarHover: '646464b3',
  scrollbarActive: 'bfbfbf66',
  shadow: '00000073',
};

const LIGHT_CHROME: Chrome = {
  background: 'ffffff',
  foreground: '000000',
  lineNumber: '237893',
  lineNumberActive: '0b216f',
  cursor: '000000',
  selection: 'add6ff',
  selectionInactive: 'e5ebf1',
  lineHighlight: 'f5f5f5',
  indentGuide: 'e3e3e3',
  indentGuideActive: 'a0a0a0',
  whitespace: '33333333',

  // Карточка интерфейса — та же поверхность, что у наших попапов: без прозрачности.
  popover: 'ffffff',
  border: 'dfdfe3',
  separator: '3c3c4349',
  sunken: '0000000d',
  tint: '78788029',
  tintHover: '7878803d',
  text: '000000d9',
  textSecondary: '000000ad',
  textTertiary: '00000094',
  placeholder: '0000008c',
  textDisabled: '00000080',
  // color-mix(синий 14 %, карточка): на белом доля акцента меньше.
  selectionFill: 'dbeeff',
  accent: '0088ff',
  accentFill: '0066cc',
  accentText: '0066cc',
  textOnFill: 'ffffff',
  purple: 'cb30e0',
  error: 'ff383c',
  warning: 'ffcc00',
  highlight: 'ffcc0052',
  highlightStrong: 'ffcc0080',
  // Светлая схема — те же роли темнее: #008932, #A16A00, #E9152D.
  added: '008932', // --git_added
  modified: 'A16A00', // --git_modified
  deleted: 'E9152D', // --git_deleted
  scrollbar: '64646466',
  scrollbarHover: '646464b3',
  scrollbarActive: '00000099',
  shadow: '00000026',
};

/** Роли обвязки схемы с наложенной темой из файла. */
function chromeFor(scheme: Scheme): Chrome {
  return { ...(scheme === 'dark' ? DARK_CHROME : LIGHT_CHROME), ...chromeOverrides };
}

/** `RRGGBB` / `RRGGBBAA` (без `#`) → цвет CSS. */
const cssHex = (value: string): string => `#${value}`;

/**
 * Роли обвязки → CSS-переменные приложения (см. `styles/theme.css`). Нужны только
 * активной теме из файла: встроенные схемы заданы прямо в таблице стилей, и
 * трогать их из кода незачем. Фоном окна и содержимого становится один цвет —
 * тема из файла задаёт плоскую поверхность, а не нашу лестницу высоты.
 */
export function themeCssVariables(scheme: Scheme): Record<string, string> {
  const chrome = chromeFor(scheme);
  return {
    '--surface_window': cssHex(chrome.background),
    '--surface_content': cssHex(chrome.background),
    '--main_background': cssHex(chrome.background),
    '--element_background_2': cssHex(chrome.background),
    '--editor_background': cssHex(chrome.background),
    '--editor_terminal_background': cssHex(chrome.background),
    '--surface_popup': cssHex(chrome.popover),
    '--popup_background': cssHex(chrome.popover),
    '--popup_border': cssHex(chrome.border),
    '--border_color': cssHex(chrome.border),
    '--separator_color': cssHex(chrome.separator),
    '--sunken_background': cssHex(chrome.sunken),
    '--element_background': cssHex(chrome.tint),
    '--button_background': cssHex(chrome.tint),
    '--element_background_hover': cssHex(chrome.tintHover),
    '--text_color': cssHex(chrome.text),
    '--text_color_secondary': cssHex(chrome.textSecondary),
    '--text_color_tertiary': cssHex(chrome.textTertiary),
    '--placeholder_text_color': cssHex(chrome.placeholder),
    '--text_color_disabled': cssHex(chrome.textDisabled),
    '--selection_background': cssHex(chrome.selectionFill),
    '--blue_prime_background': cssHex(chrome.accent),
    '--focus_ring_color': cssHex(chrome.accent),
    '--accent_fill': cssHex(chrome.accentFill),
    '--link_color': cssHex(chrome.accentText),
    '--text_color_hover': cssHex(chrome.textOnFill),
    '--purple_prime_background': cssHex(chrome.purple),
    '--red_prime_background': cssHex(chrome.error),
    '--yellow_prime_background': cssHex(chrome.warning),
    '--highlight_background': cssHex(chrome.highlight),
    '--git_added': cssHex(chrome.added),
    '--git_modified': cssHex(chrome.modified),
    '--git_deleted': cssHex(chrome.deleted),
  };
}

/**
 * Полный файл встроенной схемы — заготовка для правки: человек сохраняет её,
 * меняет цвета и импортирует обратно. Схему берём без активной темы из файла.
 */
export function themeTemplate(scheme: Scheme): ThemeFile {
  const withHash = (value: string): string => `#${value}`;
  const fill = <K extends string>(source: Record<K, string>): Record<K, string> => {
    const out = {} as Record<K, string>;
    for (const [key, value] of Object.entries(source) as Array<[K, string]>) out[key] = withHash(value);
    return out;
  };
  return {
    name: scheme === 'dark' ? 'Моя тёмная тема' : 'Моя светлая тема',
    scheme,
    chrome: fill(scheme === 'dark' ? DARK_CHROME : LIGHT_CHROME),
    tokens: fill(VIVID_TOKENS[scheme]),
  };
}

/** Палитра консоли VS Code; фон тот же, что у редактора, поэтому панели не спорят. */
export const TERMINAL_THEMES: Record<Scheme, TerminalTheme> = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
  light: {
    background: '#ffffff',
    foreground: '#333333',
    cursor: '#333333',
    cursorAccent: '#ffffff',
    selectionBackground: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
};
