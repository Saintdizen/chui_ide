/**
 * Блок изменений по строке редактора.
 *
 * Нужно для действий из жёлоба: щёлкнули по полоске на строке — надо понять, к
 * какому блоку diff эта строка относится, чтобы проиндексировать, убрать из
 * индекса или откатить именно его. Номер блока берётся из того же разбора diff,
 * что и в `shared/git-hunks.ts`, поэтому он годится для `git apply --cached`.
 *
 * Модуль чистый: только числа. Ни git, ни DOM — поэтому проверяется тестами, в
 * том числе на согласованность с полосками в жёлобе (`shared/git-line-changes.ts`):
 * обе стороны обязаны понимать, где кончается один блок и начинается другой.
 */

/** Границы блока: как в `shared/git-hunks.ts` (строки с единицы, счётчик — сколько строк). */
export interface HunkLines {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/**
 * Диапазон строк ТЕКУЩЕЙ версии, который занимает блок. Для `newCount = 0`
 * (блок только удаляет) строк в новой версии нет — привязываем его к строке
 * ПЕРЕД удалённым местом: сама удалённая строка уже исчезла, а полоску в жёлобе
 * нужно к чему-то привязать (так же помечает удаления `git-line-changes`).
 */
export function hunkLineRange(hunk: HunkLines): { from: number; to: number } {
  if (hunk.newCount <= 0) return { from: Math.max(hunk.newStart, 1), to: Math.max(hunk.newStart, 1) };
  return { from: hunk.newStart, to: hunk.newStart + hunk.newCount - 1 };
}

/**
 * Номер блока diff, в который попадает строка редактора. `null` — строка не
 * задета ни одним блоком (правки рядом, но не здесь).
 *
 * Блоки идут по файлу, поэтому первый же подходящий — он и есть: пересекающихся
 * блоков в diff не бывает.
 */
export function hunkAtLine(hunks: readonly HunkLines[], line: number): number | null {
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = hunks[index];
    if (!hunk) continue;
    const { from, to } = hunkLineRange(hunk);
    // К удалению привязана одна строка — та, ПОСЛЕ которой удалили; берём её же:
    // человек щёлкает по полоске удаления, стоящей ровно на этой строке.
    if (line >= from && line <= to) return index;
  }
  return null;
}
