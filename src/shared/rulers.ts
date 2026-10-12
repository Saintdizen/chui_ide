/**
 * Направляющие (ruler): столбцы, у которых в редакторе рисуется вертикальная черта.
 *
 * В настройках они задаются и списком чисел, и строкой «80, 120»: первое удобно
 * писать в JSON, второе — в поле формы. Поэтому разбор один и живёт здесь: он
 * принимает и то, и другое, а наружу отдаёт всегда одно — отсортированный список
 * целых столбцов без повторов. Так настройка из файла и из формы не расходится.
 *
 * Модуль чистый: ни DOM, ни настроек — только приведение значения к виду. Поэтому
 * его видно в тестах без окна (`tests/editor-rulers.test.ts`).
 */

/** Потолок числа направляющих: больше — уже не ориентир, а сетка на весь экран. */
const MAX_RULERS = 20;
/** Потолок столбца: за ним черта всё равно за краем любой разумной строки. */
const MAX_COLUMN = 10_000;

/**
 * Привести значение настройки к списку столбцов: целые положительные числа,
 * по возрастанию, без повторов. Принимаем массив чисел или строку «80, 120».
 * Всё непонятное отбрасываем — направляющая без номера столбца смысла не имеет.
 */
export function normalizeRulers(value: unknown): number[] {
  const raw = typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [];
  const columns = new Set<number>();
  for (const item of raw) {
    const column = typeof item === 'number' ? item : Number.parseInt(String(item), 10);
    if (!Number.isFinite(column)) continue;
    const whole = Math.trunc(column);
    if (whole < 1 || whole > MAX_COLUMN) continue;
    columns.add(whole);
  }
  return [...columns].sort((a, b) => a - b).slice(0, MAX_RULERS);
}

/** Столбцы в виде строки для поля формы: «80, 120». */
export function rulersToText(rulers: readonly number[]): string {
  return rulers.join(', ');
}
