/**
 * Ранжирование файлов для быстрого открывателя (`Ctrl+Shift+O`).
 *
 * Отдельный модуль без DOM: это чистая логика, её проверяют юнит-тесты,
 * а панель только рисует то, что вернула эта функция.
 */

/** Позиция последнего совпадённого символа, если `needle` — подпоследовательность `hay`. */
function subsequenceEnd(hay: string, needle: string): number {
  let at = 0;
  for (const char of needle) {
    at = hay.indexOf(char, at);
    if (at < 0) return -1;
    at += 1;
  }
  return at;
}

/**
 * Подбор файлов под запрос.
 *
 * Пустой запрос — первые `limit` путей (список уже отсортирован сервером).
 * Иначе совпадение ищем как подпоследовательность символов: так «qjs» находит
 * `src/queue.js`. Совпадение в имени файла ценится выше, чем в пути, — человек
 * обычно помнит имя, а не каталог.
 */
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice(0, limit);

  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    if (subsequenceEnd(lower, needle) < 0) continue;

    const slash = lower.lastIndexOf('/');
    const base = lower.slice(slash + 1);
    let score = 0;
    if (base.startsWith(needle)) score += 100;
    else if (base.includes(needle)) score += 60;
    else if (lower.includes(needle)) score += 30;
    // Короткий путь ближе к цели, чем такой же по совпадению длинный.
    score -= Math.min(file.length, 200) * 0.05;
    scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return scored.slice(0, limit).map((item) => item.file);
}
