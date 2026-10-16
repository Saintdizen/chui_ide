/**
 * Переход к следующей и предыдущей пометке языка.
 *
 * Раньше это делало действие движка: обходило
 * пометки всех открытых файлов и открывало нужное место. Своему редактору это
 * нечем — пометки лежат в нашем `DiagnosticsStore`, — поэтому обход пишем сами.
 *
 * Обход — чистое правило, и здесь оно отдельной функцией (`nextProblem`): из
 * упорядоченного списка пометок и текущего места получить СЛЕДУЮЩЕЕ (или
 * предыдущее), с заворотом по кругу. Так его видно в тестах без окна: сам переход
 * (открыть файл, поставить курсор) — дело вызывающего, а не этого модуля.
 *
 * Порядок обхода — файл, строка, столбец — тот же, что у `DiagnosticsStore.markers`:
 * тогда «следующая» пометка совпадает с тем, что видно в списке проблем, и переход
 * не прыгает по файлам вразнобой.
 *
 * Модуль чистый: ни DOM, ни движка. Проверяется тестами.
 */

import type { DiagnosticItem } from '../../../shared/api';

/** Место в документе, с которого ищем соседнюю пометку (обычно — курсор). */
export interface ProblemSpot {
  path: string;
  line: number;
  column: number;
}

/** Куда двигаться: к следующей пометке или к предыдущей. */
export type ProblemDirection = 'next' | 'previous';

/** Пометки в порядке обхода: файл, строка, столбец. */
export function orderProblems(items: readonly DiagnosticItem[]): DiagnosticItem[] {
  return [...items].sort(compareItems);
}

/**
 * Ближайшая пометка после (`next`) или до (`previous`) текущего места. По краям
 * заворачиваем: с последней пометки «следующая» ведёт к первой, с первой
 * «предыдущая» — к последней. Так и не приходится жать
 * команду «в обратную сторону», доехав до конца списка.
 *
 * `null` — пометок нет вовсе. Текущая позиция сама может быть пометкой: `next` уходит
 * с неё вперёд, `previous` — назад, а не топчется на месте.
 */
export function nextProblem(
  items: readonly DiagnosticItem[],
  current: ProblemSpot | null,
  direction: ProblemDirection,
): DiagnosticItem | null {
  const ordered = orderProblems(items);
  if (ordered.length === 0) return null;
  if (!current) return direction === 'next' ? ordered[0]! : ordered[ordered.length - 1]!;

  if (direction === 'next') {
    for (const item of ordered) {
      if (compareSpot(item, current) > 0) return item;
    }
    return ordered[0]!;
  }

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (compareSpot(ordered[index]!, current) < 0) return ordered[index]!;
  }
  return ordered[ordered.length - 1]!;
}

/** Что слою нужно от вызывающего: список пометок, место, переход и сообщение. */
export interface ProblemNavigationDeps {
  /** Пометки всех файлов — как их отдаёт `DiagnosticsStore.markers` без пути. */
  problems(): readonly DiagnosticItem[];
  /** Где мы стоим сейчас. `null` — файла нет, идём к первой пометке списка. */
  position(): ProblemSpot | null;
  /** Перейти к месту: открыть файл и поставить курсор. Дело вызывающего. */
  reveal(spot: ProblemSpot): void;
  /** Сообщить человеку, когда пометок нет. */
  notice?(text: string): void;
}

/**
 * Связка «список пометок → ближайшая → переход». Два входа (вперёд и назад) и один
 * переход; сам поиск — в чистой `nextProblem`, класс лишь связывает её с переходом.
 */
export class ProblemNavigation {
  constructor(private readonly deps: ProblemNavigationDeps) {}

  /** Перейти к следующей пометке (по кругу). */
  next(): void {
    this.go('next');
  }

  /** Перейти к предыдущей пометке (по кругу). */
  previous(): void {
    this.go('previous');
  }

  private go(direction: ProblemDirection): void {
    const problems = this.deps.problems();
    const target = nextProblem(problems, this.deps.position(), direction);
    if (!target) {
      this.deps.notice?.(direction === 'next' ? 'Пометок нет' : 'Пометок нет');
      return;
    }
    this.deps.reveal({ path: target.path, line: target.line, column: target.column });
  }
}

/** Сравнение пометок как позиций: файл, строка, столбец. */
function compareItems(a: DiagnosticItem, b: DiagnosticItem): number {
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
}

function compareSpot(item: ProblemSpot, spot: ProblemSpot): number {
  return item.path.localeCompare(spot.path) || item.line - spot.line || item.column - spot.column;
}
