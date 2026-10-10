import type { FileEdit } from '../../shared/edits';

/**
 * Текстовые и числовые помощники панели чата. Вынесены из `chat.ts`: это чистые
 * функции без DOM и состояния — их можно проверять юнит-тестами, и они не
 * раздувают и без того большой файл панели.
 */

/** Русская форма слова для числа: `plural(2, 'файл', 'файла', 'файлов')`. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Русская форма слова «файл» для числа. */
export function fileWord(count: number): string {
  return plural(count, 'файл', 'файла', 'файлов');
}

/** Сколько строк добавила и убрала пачка правок — для сводки «+53 −4». */
export function countLines(edits: readonly FileEdit[], target: string): { added: number; removed: number } {
  const file = edits.find((item) => item.path === target);
  if (!file) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  for (const edit of file.edits) {
    removed += Math.max(edit.endLine - edit.startLine + 1, 0);
    added += edit.newText.length === 0 ? 0 : edit.newText.replace(/\n$/, '').split('\n').length;
  }
  return { added, removed };
}

/** Размер по-человечески: «2.4 МБ» вместо «2516582». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Заголовок вкладки — по первому вопросу: в списке видно, о чём беседа. */
export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'Новая беседа';
  return flat.length > 24 ? `${flat.slice(0, 23)}…` : flat;
}

/**
 * Окрестность первого вхождения запроса — строка результата поиска по беседам.
 * `null`, если запрос в тексте не встречается. Регистр не важен.
 */
export function snippetFor(text: string, query: string): string | null {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - 24);
  return text
    .slice(start, at + query.length + 48)
    .replace(/\s+/g, ' ')
    .trim();
}
