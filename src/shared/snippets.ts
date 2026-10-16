/**
 * Сниппеты — короткие шаблоны частого кода с местами для подстановки.
 *
 * Свои сниппеты нужны затем же, зачем в любой IDE: рутинная заготовка (`if main`,
 * функция, цикл) набирается одним словом-триггером. Языковые серверы тоже дают
 * сниппеты, но только те, что заложил автор сервера; здесь — те, что завёл человек
 * в настройках, плюс небольшой набор по умолчанию.
 *
 * Тело сниппета записывается привычной разметкой: `${1:имя}` — место с подстановкой,
 * `$0` — где встанет курсор после вставки. Проверки и разбор тела здесь чистые:
 * редактор только показывает готовые подсказки, а настройки приходят из файла.
 */

/** Один сниппет: слово-триггер и тело с местами подстановки. */
export interface Snippet {
  /** По чему сниппет находится в подсказке — набираемое слово. */
  prefix: string;
  /** Тело в привычной разметке сниппетов (`${1:…}`, `$0`). */
  body: string;
  /** Пояснение в списке подсказок. */
  description?: string;
  /** Языки, к которым сниппет применим; пусто — ко всем. */
  languages?: readonly string[];
}

/** Пределы, чтобы файл настроек и список подсказок оставались разумными. */
const MAX_SNIPPETS = 200;
const MAX_BODY_CHARS = 2000;
const MAX_PREFIX_CHARS = 40;

/**
 * Небольшой набор по умолчанию: только то, что набирают чаще всего и что не
 * совпадает по слову с объявлениями языков (иначе подсказка спорила бы с самим
 * языком). Свои сниппеты человек добавляет в настройках — они дополняют этот набор.
 */
export const DEFAULT_SNIPPETS: readonly Snippet[] = [
  {
    prefix: 'ifmain',
    description: 'Точка входа Python',
    languages: ['python'],
    body: 'if __name__ == "__main__":\n    ${1:main()}',
  },
  {
    prefix: 'deff',
    description: 'Функция Python',
    languages: ['python'],
    body: 'def ${1:name}(${2}):\n    ${3:pass}',
  },
  {
    prefix: 'classs',
    description: 'Класс Python',
    languages: ['python'],
    body: 'class ${1:Name}:\n    def __init__(self${2}):\n        ${3:pass}',
  },
  {
    prefix: 'trye',
    description: 'try / except',
    languages: ['python'],
    body: 'try:\n    ${1:pass}\nexcept ${2:Exception} as error:\n    ${3:raise}',
  },
  {
    prefix: 'clg',
    description: 'console.log',
    languages: ['javascript', 'typescript'],
    body: 'console.log(${1})',
  },
  {
    prefix: 'afn',
    description: 'Асинхронная функция',
    languages: ['javascript', 'typescript'],
    body: 'async function ${1:name}(${2}) {\n  ${3}\n}',
  },
  {
    prefix: 'fn',
    description: 'Функция',
    languages: ['javascript', 'typescript'],
    body: 'function ${1:name}(${2}) {\n  ${3}\n}',
  },
];

/** Обрезать и почистить одну строку: сниппеты приходят из файла, доверять им нельзя. */
function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit);
}

/** Привести один сниппет к нашей форме; null — запись непригодна (нет триггера или тела). */
function normalizeSnippet(value: unknown): Snippet | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const prefix = clean(record.prefix, MAX_PREFIX_CHARS).trim();
  const body = clean(record.body, MAX_BODY_CHARS);
  // Триггер пробелов не содержит: иначе он не наберётся как слово; тело непустое.
  if (!prefix || /\s/.test(prefix) || !body.trim()) return null;

  const snippet: Snippet = { prefix, body };
  const description = clean(record.description, 200).trim();
  if (description) snippet.description = description;

  if (Array.isArray(record.languages)) {
    const languages = record.languages
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (languages.length > 0) snippet.languages = [...new Set(languages)];
  }
  return snippet;
}

/**
 * Разобрать список сниппетов из настроек: мусор пропускаем, повторы по триггеру
 * и языкам убираем (побеждает первый — тот, что задан раньше).
 */
export function normalizeSnippets(value: unknown): Snippet[] {
  if (!Array.isArray(value)) return [];
  const result: Snippet[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const snippet = normalizeSnippet(item);
    if (!snippet) continue;
    const key = `${snippet.prefix}\u0000${(snippet.languages ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(snippet);
    if (result.length >= MAX_SNIPPETS) break;
  }
  return result;
}

/**
 * Сниппеты, применимые к языку: пользовательские плюс те, где язык совпал или
 * не ограничен вовсе. Свои сниппеты идут первыми — при совпадении триггера
 * выигрывает тот, что человек задал сам.
 */
export function snippetsForLanguage(snippets: readonly Snippet[], language: string): Snippet[] {
  return snippets.filter((snippet) => !snippet.languages || snippet.languages.includes(language));
}
