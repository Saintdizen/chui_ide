/**
 * Чтение `.editorconfig` для переводов строк и отступов.
 *
 * Зачем: `.editorconfig` — единственное место, где команда говорит про отступы
 * и концы строк всерьёз. Если в `.py` стоит `indent_style = space` и
 * `end_of_line = lf`, а IDE открыла файл как CRLF с табами, человек получает
 * первый же коммит «на весь файл».
 *
 * Разбираем сами, а не через пакет: нужны пять свойств из десяти, а
 * зависимость тянула бы целый парсер glob-шаблонов. Здешние шаблоны
 * понимают то, что реально пишут: `*`, `**`, `?`, `{a,b}`, `[abc]`.
 */

/** Что мы берём из секции. Остальные свойства молча пропускаются. */
export interface EditorConfigRule {
  /** Шаблоны путей из секции: `[*]`, `[*.{ts,tsx}]`. */
  patterns: string[];
  /** `tab` или `space`. */
  indentStyle?: 'tab' | 'space';
  /** Сколько пробелов на отступ. */
  indentSize?: number;
  /** `lf`, `crlf` — к чему приводить файл. */
  endOfLine?: 'lf' | 'crlf';
  /** `true` — срезать пробелы в конце строк. */
  trimTrailingWhitespace?: boolean;
  /** `true`/`false` — дописывать перевод строки в конце файла. */
  insertFinalNewline?: boolean;
}

export interface EditorConfigFile {
  /** `root = true` наверху: выше этой папки не искать. */
  isRoot: boolean;
  rules: EditorConfigRule[];
}

/**
 * Разобрать текст `.editorconfig`.
 *
 * Правила в порядке файла: в спецификации поздние секции перекрывают
 * ранние, а между папками ближняя к файлу важнее. Склейка — в
 * `resolveEditorConfig`, здесь только разбор.
 */
export function parseEditorConfig(text: string): EditorConfigFile {
  const rules: EditorConfigRule[] = [];
  let isRoot = false;
  let current: EditorConfigRule | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // `#` и `;` — комментарии; пустые строки тоже пропускаем.
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;

    // Секция — только строка, целая из скобок: `charset = [utf-8]` сюда не попадёт.
    if (line.startsWith('[') && line.endsWith(']')) {
      current = { patterns: splitPatterns(line.slice(1, -1).trim()) };
      rules.push(current);
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key.length === 0) continue;

    // `root` имеет смысл только до первой секции.
    if (key === 'root') {
      if (current === null && (value === 'true' || value === 'yes')) isRoot = true;
      continue;
    }
    if (current === null) continue;

    switch (key) {
      case 'indent_style':
        if (value === 'tab' || value === 'space') current.indentStyle = value;
        break;
      case 'indent_size':
      case 'tab_width': {
        const size = Number.parseInt(value, 10);
        // У `tab_width` приоритет ниже: заданный `indent_size` важнее.
        if (Number.isFinite(size) && size > 0) {
          if (key === 'indent_size' || current.indentSize === undefined) current.indentSize = size;
        }
        break;
      }
      case 'end_of_line':
        if (value === 'lf' || value === 'crlf') current.endOfLine = value;
        break;
      case 'trim_trailing_whitespace':
        current.trimTrailingWhitespace = value === 'true';
        break;
      case 'insert_final_newline':
        current.insertFinalNewline = value === 'true';
        break;
      default:
        break;
    }
  }

  return { isRoot, rules };
}

/** Шаблоны через запятую, но не внутри `{}`: `*.{ts,tsx}` — один шаблон. */
function splitPatterns(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      out.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  out.push(body.slice(start).trim());
  return out.filter((pattern) => pattern.length > 0);
}

/**
 * Итог для конкретного файла. Два имени у одного типа не случайны:
 * `EditorConfigValues` — то, что уходит в окно по RPC, `ResolvedEditorConfig` —
 * как это зовётся в разборе. Одна форма, чтобы не заводить копию ради имени.
 */
export interface ResolvedEditorConfig {
  indentStyle?: 'tab' | 'space';
  indentSize?: number;
  endOfLine?: 'lf' | 'crlf';
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
}

/**
 * Свести правила для файла. `relativePath` — путь от корня проекта с прямыми
 * слэшами; `layers` идут от дальнего `.editorconfig` к ближнему (ближний важнее).
 */
export function resolveEditorConfig(
  relativePath: string,
  layers: readonly EditorConfigFile[],
): ResolvedEditorConfig {
  const path = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const base = path.slice(path.lastIndexOf('/') + 1);
  const result: ResolvedEditorConfig = {};

  for (const layer of layers) {
    for (const rule of layer.rules) {
      if (!rule.patterns.some((pattern) => matchPattern(pattern, path, base))) continue;
      if (rule.indentStyle !== undefined) result.indentStyle = rule.indentStyle;
      if (rule.indentSize !== undefined) result.indentSize = rule.indentSize;
      if (rule.endOfLine !== undefined) result.endOfLine = rule.endOfLine;
      if (rule.trimTrailingWhitespace !== undefined) {
        result.trimTrailingWhitespace = rule.trimTrailingWhitespace;
      }
      if (rule.insertFinalNewline !== undefined) result.insertFinalNewline = rule.insertFinalNewline;
    }
  }

  return result;
}

/**
 * Что окно получает от main: те же правила, что нашлись в `.editorconfig`.
 * Имя отличается от `ResolvedEditorConfig` нарочно — по нему видно, что это
 * данные через границу процессов, а не внутренний результат разбора.
 */
export type EditorConfigValues = ResolvedEditorConfig;

/**
 * Совпадает ли путь с шаблоном `.editorconfig`.
 *
 * Если в шаблоне нет слэша, он сверяется с именем файла: `*.py` ловит
 * `src/x.py`. Со слэшем — с путём от корня проекта. `**` перекрывает папки.
 */
export function matchPattern(
  pattern: string,
  path: string,
  base = path.slice(path.lastIndexOf('/') + 1),
): boolean {
  const source = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = source.includes('/') ? path : base;
  return patternToRegExp(source).test(target);
}

/**
 * Сборка шаблонов кэшируется: один и тот же шаблон сверяется с каждым файлом
 * проекта, и пересобирать его тысячи раз незачем.
 */
const cache = new Map<string, RegExp>();

function patternToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` — «ноль или больше папок», `**` в конце — «всё остальное».
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        // Одна `*` не переходит через слэш: `*.py` не должен ловить `a/b.py`.
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '{') {
      const end = pattern.indexOf('}', index);
      if (end > index) {
        const options = pattern
          .slice(index + 1, end)
          .split(',')
          .map((option) => escapeRegExp(option.trim()))
          .join('|');
        out += `(?:${options})`;
        index = end;
        continue;
      }
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index);
      if (end > index) {
        const body = pattern.slice(index + 1, end);
        // `[!abc]` у glob значит «любой, кроме»; в регэкспе это `[^abc]`.
        out += `[${body.startsWith('!') ? `^${escapeRegExp(body.slice(1))}` : escapeRegExp(body)}]`;
        index = end;
        continue;
      }
    }
    out += escapeRegExp(char);
  }
  out += '$';

  const regex = new RegExp(out);
  cache.set(pattern, regex);
  return regex;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}