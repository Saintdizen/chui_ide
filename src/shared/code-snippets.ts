import type { Snippet } from './snippets';

/**
 * Сниппеты из файлов VS Code — `.code-snippets` (проект) и `*.json` в папке
 * пользовательских сниппетов редактора.
 *
 * Чужой проект приносит свои сниппеты именно в этом виде, и человек, открыв его
 * здесь, ждёт те же триггеры. Формат почти наш, но с двумя отличиями: `body` там
 * бывает массивом строк, а язык записан в имени файла (`python.code-snippets`).
 */

/**
 * Языки, которые узнаём по имени файла.
 *
 * Список закрыт намеренно: `helpers.code-snippets` — это набор общих сниппетов,
 * и подписать его языком «helpers» значит спрятать их от всех файлов сразу.
 * Лучше пропустить редкий язык, чем потерять весь набор.
 */
const KNOWN_LANGUAGES = new Set([
  'python',
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'java',
  'kotlin',
  'swift',
  'go',
  'rust',
  'ruby',
  'php',
  'csharp',
  'cpp',
  'c',
  'html',
  'css',
  'scss',
  'less',
  'json',
  'yaml',
  'toml',
  'markdown',
  'sql',
  'shellscript',
  'bash',
  'zsh',
  'powershell',
  'dockerfile',
  'lua',
  'r',
  'dart',
  'scala',
  'elixir',
  'haskell',
  'vue',
  'svelte',
  'graphql',
  'xml',
]);

/**
 * Язык по имени файла: `python.code-snippets` → `python`.
 *
 * Работает только для файла со сниппетами одного языка. У `my-helpers.code-snippets`
 * языка нет — вернуть нечего; VS Code тоже считает такие сниппеты общими.
 */
export function languageOfSnippetFile(fileName: string): string | null {
  const name = fileName.split('/').pop() ?? fileName;
  const match = /^([a-z0-9+#-]+)\.code-snippets$/i.exec(name);
  if (!match) return null;
  const language = (match[1] ?? '').toLowerCase();
  return KNOWN_LANGUAGES.has(language) ? language : null;
}

/**
 * Тело сниппета: строка или массив строк.
 *
 * Между строками ставим перевод строки: в VS Code массив — ровно те же строки
 * через `\n`, и склейка встык сломала бы отступы.
 */
export function bodyText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((line): line is string => typeof line === 'string').join('\n');
  return '';
}

/**
 * Триггер: строка или список строк.
 *
 * Несколько триггеров на одно тело — обычное дело (`log` и `clg`). Берём первый:
 * телом и описанием они одинаковы, а второй попал бы в подсказки вторым «тем же».
 */
export function prefixText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((item): item is string => typeof item === 'string' && item.trim() !== '');
    return first?.trim() ?? '';
  }
  return '';
}

/**
 * Сниппеты из текста `.code-snippets` (JSONC: комментарии и висячие запятые).
 *
 * `language` — из имени файла; язык, объявленный в записи, сильнее: в общем файле
 * так помечают отдельные сниппеты.
 */
export function snippetsFromCodeSnippets(text: string, language: string | null = null): Snippet[] {
  const parsed = parseJsonc(text);
  if (!parsed) return [];

  const result: Snippet[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    // Имя ключа — запасной триггер: VS Code позволяет не писать `prefix`.
    const prefix = prefixText(record.prefix) || key.trim();
    const body = bodyText(record.body);
    // Триггер без пробелов: иначе он не наберётся как слово, и подсказка мертва.
    if (!prefix || /\s/.test(prefix) || !body.trim()) continue;

    const snippet: Snippet = { prefix, body };
    if (typeof record.description === 'string' && record.description.trim() !== '') {
      snippet.description = record.description.trim();
    }
    const declared = Array.isArray(record.languages)
      ? record.languages.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [];
    if (declared.length > 0) snippet.languages = [...new Set(declared)];
    else if (language) snippet.languages = [language];
    result.push(snippet);
  }
  return result;
}

/** JSONC → объект; битый файл — null (сниппеты чужого проекта не повод падать). */
function parseJsonc(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
