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
 * `recent` — пути, которые открывали раньше (свежие сверху). Пустой запрос — они
 * и есть ответ: палитра без букв должна открывать то, чем человек живёт, а не
 * алфавитное начало проекта. Недостающее добираем алфавитом — список приходит
 * уже отсортированным.
 *
 * С запросом совпадение ищем как подпоследовательность: «qjs» находит `src/queue.js`.
 * Совпадение в имени файла ценится выше, чем в пути, — имя человек помнит лучше
 * каталога. Недавние получают надбавку, но не убийственную: совпадение по имени
 * важнее привычки, иначе «app» никогда не найдёт `append.ts` ради вчерашнего `apps/`.
 */
export function rankFiles(
  files: readonly string[],
  query: string,
  limit = 50,
  recent: readonly string[] = [],
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    const seen = new Set<string>();
    const out: string[] = [];
    // Недавние — только те, что есть в этом проекте: история общая, а палитра — про текущий.
    for (const path of recent) {
      if (out.length >= limit) break;
      if (seen.has(path) || !files.includes(path)) continue;
      seen.add(path);
      out.push(path);
    }
    for (const path of files) {
      if (out.length >= limit) break;
      if (seen.has(path)) continue;
      out.push(path);
    }
    return out;
  }

  /** Место в истории: 0 — самое свежее. Нет в истории — ключа нет. */
  const order = new Map<string, number>();
  recent.forEach((path, index) => {
    order.set(path, index);
  });

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
    // Буквы нашлись по порядку, но не подряд: `cfg` есть в `config.ts`. Без этой ветки
    // такой файл получал только штраф за длину — меньше нуля — и проваливался ниже
    // любого, что вообще не совпал. Ставим его между «по пути подряд» и остальными.
    else score += 15;
    // Короткий путь ближе к цели, чем такой же по совпадению длинный.
    score -= Math.min(file.length, 200) * 0.05;
    // Недавние — надбавка за привычку, не больше 20: она перебивает разницу в длине
    // пути, но не разницу между «имя начинается с запроса» и «буквы нашлись в каталоге».
    const at = order.get(file);
    if (at !== undefined) score += Math.max(0, 20 - at * 2);
    scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return scored.slice(0, limit).map((item) => item.file);
}
