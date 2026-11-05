/**
 * Ранжирование файлов для быстрого открывателя (`Ctrl+Shift+O`).
 *
 * Отдельный модуль без DOM: это чистая логика, её проверяют юнит-тесты,
 * а панель только рисует то, что вернула эта функция.
 */

import { matchScore } from '../../shared/fuzzy';

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
    const slash = lower.lastIndexOf('/');
    const base = lower.slice(slash + 1);
    // Нечёткость — общая с подсказками (`shared/fuzzy`), а не своя: горбы и начало
    // слова должны пониматься одинаково во всех списках. Раньше здесь стояла
    // подпоследовательность по всему пути — `gT` находил `src/README.md` (буквы
    // из разных каталогов), а оценка не знала ни горбов, ни начала слова.
    const inName = matchScore(base, needle);
    const inPath = inName ? null : matchScore(lower, needle);
    const hit = inName ?? inPath;
    if (!hit) continue;

    let score = hit.score;
    if (inName) score += 200;
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
