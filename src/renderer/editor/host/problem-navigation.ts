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

/** Область обхода: без области — все файлы, с путём — только этот файл. */
export interface ProblemScope {
  path: string;
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
  scope?: ProblemScope,
): DiagnosticItem | null {
  let pool = items;
  if (scope) pool = items.filter((item) => item.path === scope.path);
  const ordered = orderProblems(pool);
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

  /** Следующая пометка в текущем файле (сквозь файлы — `next`). */
  nextInFile(): void {
    this.goInActiveFile('next');
  }

  /** Предыдущая пометка в текущем файле. */
  previousInFile(): void {
    this.goInActiveFile('previous');
  }

  private goInActiveFile(direction: ProblemDirection): void {
    const spot = this.deps.position();
    if (!spot) {
      // Файла нет — внутрифайловый обход бессмыслен; говорим тем же языком.
      this.deps.notice?.('Пометок нет');
      return;
    }
    this.go(direction, { path: spot.path });
  }

  private go(direction: ProblemDirection, scope?: ProblemScope): void {
    const problems = this.deps.problems();
    const target = nextProblem(problems, this.deps.position(), direction, scope);
    if (!target) {
      // Одна формулировка на оба направления: пометок нет — неважно, куда шли.
      this.deps.notice?.(scope ? 'В файле пометок нет' : 'Пометок нет');
      return;
    }
    this.deps.reveal({ path: target.path, line: target.line, column: target.column });
    // После перехода говорим, КУДА приехали и что там: иначе курсор прыгает по файлу
    // молча, и человек не отличает ошибку от предупреждения — только по подчёркиванию под
    // курсором, которого на другой строке может и не быть. Место считаем от единицы, как
    // договаривались в списке проблем: `line` у пометки — с единицы уже здесь.
    this.deps.notice?.(describeProblem(target));
  }
}

/** Название места для сообщения: имя файла и `строка:столбец`. */
function describeSpot(path: string, line: number, column: number): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return `${name}:${line}:${column}`;
}

/**
 * Короткая строка о пометке для тоста: место, уровень, текст и источник языка.
 *
 * Важность — словом, а не значком: тост — текстовая строка, а цветных значков в нём нет.
 * Источник (`ts`, `eslint`) — в скобках, потому что по нему один и тот же текст читается
 * по-разному (ошибка компилятора или придирка линтера).
 */
export function describeProblem(item: DiagnosticItem): string {
  const level = item.severity === 'error' ? 'ошибка' : item.severity === 'warning' ? 'предупреждение' : 'сведения';
  const source = item.source ? ` (${item.source})` : '';
  return `${describeSpot(item.path, item.line, item.column)} · ${level}${source}: ${item.message}`;
}

/** Сравнение пометок как позиций: файл, строка, столбец. */
function compareItems(a: DiagnosticItem, b: DiagnosticItem): number {
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
}

function compareSpot(item: ProblemSpot, spot: ProblemSpot): number {
  return item.path.localeCompare(spot.path) || item.line - spot.line || item.column - spot.column;
}
