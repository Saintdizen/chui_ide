/**
 * Счётчик «сколько спрятано» для хвоста папки в дереве.
 *
 * Почему отдельно от `ui/explorer.ts`: решение здесь чистое — по списку масок
 * и по путям сказать, кого спрятали и какая маска это сделала. Рисовать это
 * должен вид, а не этот файл; проверять — тест, а не окно.
 *
 * Разделение, которое легко потерять: **скрытое точкой — не исключённое**.
 * Точка — обычная тишина (её всё равно видно при `showHidden`), а маска
 * `explorer.exclude` — сознательное решение человека. Считать их одной цифрой
 * значит врать: «ещё 40 исключено» вместо «здесь просто нет ничего».
 *
 * Нет отдельной сущности «строка исключения»: считаем только то, что реально
 * отсеяно ИЗ ЭТОЙ папки и сейчас.
 */
import { maskToRegExp } from '../../shared/glob';

/** Что нужно от файла, чтобы решить, спрятан ли он. */
export interface ExcludableEntry {
  readonly name: string;
}

/** Итог: сколько спрятано и по каким маскам. */
export interface ExcludedCount {
  readonly count: number;
  /** Маски, которые сработали: пусто — нечего показывать. */
  readonly patterns: readonly string[];
}

/**
 * Посчитать, кого из папки съели маски.
 *
 * `relativeOf` отдаёт путь от корня проекта, иначе совпадение с `dist/*` не
 * найдётся — маска вида `dist` проверяется и по имени, и по пути.
 * Масок нет — не считаем ничего, даже не собираем регулярки: это частый случай.
 */
export function countExcluded(
  entries: readonly ExcludableEntry[],
  patterns: readonly string[],
  relativeOf: (entry: ExcludableEntry) => string,
  hiddenOf: (entry: ExcludableEntry) => boolean = () => false,
): ExcludedCount {
  if (patterns.length === 0) return { count: 0, patterns: [] };
  const regexps = patterns.map((pattern) => maskToRegExp(pattern));
  const hit = new Set<string>();
  let count = 0;
  for (const entry of entries) {
    // Скрытое точкой считаем отдельно: оно не «исключено», его просто не велено показывать.
    if (hiddenOf(entry)) continue;
    const relative = relativeOf(entry);
    const index = regexps.findIndex((regexp) => regexp.test(entry.name) || regexp.test(relative));
    if (index === -1) continue;
    count += 1;
    // Порядок масок сохраняем как в настройках: человек ищет свою строку сверху вниз.
    hit.add(patterns[index]!);
  }
  return { count, patterns: patterns.filter((pattern) => hit.has(pattern)) };
}

/** Подпись строки: «Ещё 3 файла исключено» без склонения в шаблоне. */
export function excludedLabel(
  count: number,
  plural: (n: number, one: string, few: string, many: string) => string,
): string {
  if (count <= 0) return '';
  return `Ещё ${count} ${plural(count, 'файл', 'файла', 'файлов')} исключено`;
}
