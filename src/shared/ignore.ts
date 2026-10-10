/**
 * Правила исключения обхода: `.ai_ignore` и `.gitignore`.
 *
 * Синтаксис повторяет `.gitignore`, потому что это единственный формат, который
 * человек в проекте уже знает: пустые строки и `#` пропускаются, `!` возвращает
 * файл обратно, хвостовой `/` говорит «только папка», ведущий `/` привязывает
 * правило к корню, `**` перешагивает папки. Отличия от git: вложенные файлы
 * правил не читаются (берём только корневые), и правило не действует на файл,
 * лежащий внутри исключённой папки, — как и в git, впрочем: заглядывать внутрь
 * исключённой папки незачем, мы в неё просто не заходим.
 *
 * Правила чистые: ни файловой системы, ни Electron. Обход читает файлы правил
 * сам и спрашивает этот модуль (см. `WorkspaceService`).
 */

/** Одно разобранное правило. */
interface IgnoreRule {
  regex: RegExp;
  /** `!` впереди: правило возвращает совпавшее обратно. */
  negated: boolean;
  /** Хвостовой `/`: правило относится только к папкам. */
  dirOnly: boolean;
}

/** Превратить glob-часть правила в регулярное выражение. */
function globToPattern(glob: string): string {
  let out = '';
  let index = 0;

  while (index < glob.length) {
    const char = glob[index]!;

    if (char === '*') {
      // Считаем, сколько звёздочек подряд: `**` перешагивает папки, `*` — нет.
      let end = index;
      while (glob[end] === '*') end += 1;
      const stars = end - index;
      const beforeSlash = index === 0 || glob[index - 1] === '/';
      const afterSlash = glob[end] === '/';

      if (stars >= 2 && beforeSlash && afterSlash) {
        // `**/` — любая глубина, включая ноль папок.
        out += '(?:.*/)?';
        index = end + 1;
        continue;
      }
      out += stars >= 2 ? '.*' : '[^/]*';
      index = end;
      continue;
    }

    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      // Класс символов переносим как есть — `[0-9]`, `[abc]`. Незакрытую скобку
      // считаем обычным символом: иначе правило молча ломало бы весь разбор.
      const close = glob.indexOf(']', index + 1);
      if (close > index + 1) {
        out += glob.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      out += String.raw`\[`;
      index += 1;
      continue;
    }

    // Всё прочее — буквальный символ: экранируем то, что в регулярках значимо.
    out += /[.*+^$(){}|\\]/.test(char) ? `\\${char}` : char;
    index += 1;
  }

  return out;
}

/** Разобрать одну строку файла правил. `null` — строка пустая или комментарий. */
function parseRule(line: string): IgnoreRule | null {
  let text = line.trim();
  // Экранированный `#` в начале — это часть шаблона, а не комментарий.
  if (text === '' || (text.startsWith('#') && !text.startsWith('\\#'))) return null;
  if (text.startsWith('\\#')) text = text.slice(1);

  const negated = text.startsWith('!');
  if (negated) text = text.slice(1);

  const dirOnly = text.endsWith('/');
  if (dirOnly) text = text.replace(/\/+$/, '');

  // Хвостовые пробелы в gitignore можно экранировать: поддержки нет — в правилах
  // обхода они не встречаются, а лишний синтаксис только запутает.
  if (text === '') return null;

  // Ведущий `/` привязывает правило к корню; слэш внутри (`docs/*.md`) — тоже.
  const anchored = text.startsWith('/') || text.includes('/');
  const body = globToPattern(text.replace(/^\/+/, ''));
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { regex: new RegExp(`${prefix}${body}$`), negated, dirOnly };
}

/**
 * Набор правил исключения. Побеждает последнее совпавшее правило — как в git:
 * так `!docs/` может вернуть то, что раньше исключили.
 */
export class IgnoreRules {
  private readonly rules: readonly IgnoreRule[];

  constructor(rules: readonly IgnoreRule[]) {
    this.rules = rules;
  }

  static parse(text: string): IgnoreRules {
    return combineIgnoreFiles([text]);
  }

  static empty(): IgnoreRules {
    return new IgnoreRules([]);
  }

  get size(): number {
    return this.rules.length;
  }

  /** Итог по самому пути: `true` — исключить, `false` — вернуть, `null` — правило не говорило. */
  private decide(relativePath: string, isDir: boolean): boolean | null {
    let verdict: boolean | null = null;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(relativePath)) verdict = !rule.negated;
    }
    return verdict;
  }

  /**
   * Исключён ли путь. Для файла проверяются и папки на пути к нему: правило
   * `build/` относится ко всему внутри, и это же поведение у обхода — в
   * исключённую папку мы попросту не заходим.
   */
  ignores(relativePath: string, isDir = false): boolean {
    // Хвостовой слэш в самом пути — это тоже «папка»: так пишут и в правилах, и
    // при отладке (`build/`), и разбирать это как файл было бы неверно.
    const directory = isDir || relativePath.endsWith('/');
    const path = relativePath.replace(/^\.?\/*/, '').replace(/\/+$/, '');
    if (path === '') return false;

    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      if (this.decide(segments.slice(0, depth).join('/'), true) === true) return true;
    }
    return this.decide(path, directory) === true;
  }
}

/**
 * Сложить правила из нескольких файлов: `.ai_ignore` читается после `.gitignore`,
 * поэтому у него последнее слово. Порядок важен именно из-за `!`: последнее
 * совпадение побеждает, и «верни обратно» в `.ai_ignore` должно перебивать
 * исключение из `.gitignore`.
 */
export function combineIgnoreFiles(files: readonly string[]): IgnoreRules {
  const rules: IgnoreRule[] = [];
  for (const text of files) {
    for (const line of text.split('\n')) {
      const rule = parseRule(line);
      if (rule) rules.push(rule);
    }
  }
  return new IgnoreRules(rules);
}

/*
 * `IgnoreRules.parse` и `combineIgnoreFiles` — один и тот же разбор: первый
 * читает один текст, второй складывает правила из нескольких файлов по порядку
 * (он и важен из-за `!`: побеждает последнее совпавшее правило).
 */
