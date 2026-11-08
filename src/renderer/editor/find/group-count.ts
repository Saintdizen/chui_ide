import type { FindMatch } from './search';

/** Сколько раз встретилась каждая группа регэкспа. */
export interface GroupCount {
  /** Номер группы с единицы: 1, 2, … */
  index: number;
  /** Сколько совпадений имеют эту группу (участвовавшую в матче). */
  count: number;
  /** Пример значения группы — чтобы понять, о чём счёт, без беготни по файлу. */
  sample: string;
}

/**
 * Счёт по группам регэкспа: «13 совпадений, группа 1 — 13, группа 2 — 4».
 *
 * Зачем в панели поиска: замена с `$1` и `$2` выглядит одинаково, как бы ни
 * легли группы, а результат зависит именно от них. По счёту видно сразу,
 * что необязательная группа не участвовала (0 или меньше, чем всего) — и
 * почему замена дала не то, что ждали.
 *
 * Группа, не участвовавшая в совпадении (`undefined`), не считается: в
 * JavaScript `(a)?b` на строке «b» даёт `groups[0] === undefined`, и считать
 * это «пустым значением» значило бы показать группу там, где её нет.
 */
export function countByGroup(matches: readonly FindMatch[]): GroupCount[] {
  const counts = new Map<number, { count: number; sample: string }>();

  for (const match of matches) {
    const groups = match.groups;
    if (!groups) continue;
    for (let index = 0; index < groups.length; index += 1) {
      const value = groups[index];
      if (value === undefined) continue;
      const number = index + 1;
      const seen = counts.get(number);
      if (seen) seen.count += 1;
      else counts.set(number, { count: 1, sample: value });
    }
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, value]) => ({ index, count: value.count, sample: value.sample }));
}

/**
 * Строка для панели: `группы: 1 — 13, 2 — 4`. Пусто — группировать нечего
 * (шаблон без `()`), и панель ничего не добавляет.
 */
export function groupCountLabel(counts: readonly GroupCount[], total: number): string {
  if (counts.length === 0) return '';
  const parts = counts.map(({ index, count, sample }) => `${index} — ${count} (${sample})`);
  return `группы: ${parts.join(', ')} из ${total}`;
}
