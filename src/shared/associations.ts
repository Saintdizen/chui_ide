/**
 * Файловые ассоциации (`files.associations`): шаблон имени файла → язык.
 *
 * Нужны там, где расширение само по себе язык не выдаёт: `*.proto`, `*.tpl.html`,
 * `Jakefile`. Сервер для языка может быть настроен, но файл остаётся без подсветки,
 * пока его никто не назвал. Как и направляющие (см. `rulers.ts`), настройка живёт и
 * списком объектов в JSON, и строкой «*.proto = proto» в форме, поэтому разбор один
 * и живёт здесь. Модуль чистый: ни DOM, ни настроек — его видно в тестах без окна
 * (`tests/file-associations.test.ts`).
 */

export interface FileAssociation {
  /** Шаблон имени: `*.proto`, `Jakefile`, `*.tpl.html`. `*` — любая часть, `?` — знак. */
  pattern: string;
  /** Язык — идентификатор сервера (`proto`, `cpp`), не подпись. */
  language: string;
}

/** Потолок правил: больше — уже не список, а вторая таблица языков. */
const MAX_ASSOCIATIONS = 200;

/**
 * Привести значение настройки к списку правил. Принимаем строку с переводами строк,
 * массив таких строк и массив объектов. Всё, где нет шаблона или языка, отбрасываем:
 * правило без одной из половин ничего не значит.
 */
export function normalizeFileAssociations(value: unknown): FileAssociation[] {
  const items = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  const result: FileAssociation[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const pair =
      typeof item === 'string'
        ? parseLine(item)
        : item !== null && typeof item === 'object'
          ? describe(item as { pattern?: unknown; language?: unknown })
          : null;
    if (pair === null) continue;
    const key = `${pair.pattern.toLowerCase()}\u0000${pair.language.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(pair);
    if (result.length >= MAX_ASSOCIATIONS) break;
  }
  return result;
}

/** Правила в виде строк для поля формы: по одному «*.proto = proto» на строку. */
export function fileAssociationsToText(list: readonly FileAssociation[]): string {
  return list.map((item) => `${item.pattern} = ${item.language}`).join('\n');
}

/**
 * Язык по правилам: побеждает последнее подходящее, как в VS Code — так общим
 * правилом (`*.html`) можно перекрыть частный случай (`*.tpl.html`).
 * Ничего не подошло — null, и решает обычная таблица языков.
 */
export function languageFromAssociations(filePath: string, list: readonly FileAssociation[]): string | null {
  const name = basename(filePath);
  let found: string | null = null;
  for (const item of list) {
    if (matchesPattern(item.pattern, name)) found = item.language;
  }
  return found;
}

/** Имя файла без каталогов: шаблоны сравниваются с ним, а не с полным путём. */
function basename(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut >= 0 ? filePath.slice(cut + 1) : filePath;
}

/** Строка «*.proto = proto» → правило. Разделитель — `=` или `:`; `#` — комментарий. */
function parseLine(line: string): FileAssociation | null {
  const text = line.split('#')[0]!.trim();
  if (text === '') return null;
  const cut = text.search(/[=:]/);
  if (cut < 0) return null;
  return describe({ pattern: text.slice(0, cut), language: text.slice(cut + 1) });
}

/** Правило из пары полей: пустая половина — не правило. */
function describe(raw: { pattern?: unknown; language?: unknown }): FileAssociation | null {
  const pattern = typeof raw.pattern === 'string' ? raw.pattern.trim() : '';
  const language = typeof raw.language === 'string' ? raw.language.trim() : '';
  if (pattern === '' || language === '') return null;
  return { pattern, language };
}

/** Совпадает ли шаблон с именем файла: `*` — любая часть, `?` — один знак. */
function matchesPattern(pattern: string, name: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern.toLowerCase() === name.toLowerCase();
  }
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '.*';
      if (char === '?') return '.';
      return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, 'i').test(name);
}
