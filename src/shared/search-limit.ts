/**
 * Потолок совпадений на один файл.
 *
 * Поиск по проекту отдаёт до 200 совпадений, и один шумный файл выбирает их все:
 * `package-lock.json` или собранный бандл отвечают на любой запрос, а до остальных
 * файлов дело не доходит — модель видит двести строк из одного места и делает
 * вывод «больше нигде нет». Поэтому на файл отдаём десяток и говорим, сколько
 * ещё в нём есть: по этому числу видно, что файл шумный, и можно сузить запрос.
 *
 * Модуль чистый — отбирает из готового списка, ничего не читая.
 */

/** Сколько совпадений из одного файла показываем. */
export const MAX_HITS_PER_FILE = 10;

/** Что осталось после отбора: сами совпадения и сколько скрыто по файлам. */
export interface PerFileLimit<T> {
  hits: T[];
  /** Сколько совпадений скрыто потолком на файл — всего. */
  hidden: number;
  /** Достигнут ли общий предел списка (всё, что не влезло, скрыто уже им). */
  truncated: boolean;
}

/**
 * Отобрать совпадения с потолком на файл и общим пределом. Порядок сохраняется:
 * первый файл в выдаче — тот, где поиск нашёл больше (так его отдаёт ripgrep).
 *
 * `total` — общий предел списка; `0` и меньше — без предела.
 */
export function limitPerFile<T extends { path: string }>(
  hits: readonly T[],
  perFile: number,
  total: number,
): PerFileLimit<T> {
  const seen = new Map<string, number>();
  const kept: T[] = [];
  let hidden = 0;
  let truncated = false;

  for (const hit of hits) {
    const count = seen.get(hit.path) ?? 0;
    if (count >= perFile) {
      seen.set(hit.path, count + 1);
      hidden += 1;
      continue;
    }
    if (total > 0 && kept.length >= total) {
      truncated = true;
      break;
    }
    seen.set(hit.path, count + 1);
    kept.push(hit);
  }

  return { hits: kept, hidden, truncated };
}
