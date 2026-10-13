import { isInsidePath } from '../../shared/paths';

/**
 * Закреплённые файлы и папки дерева: их список живёт в сессии проекта и
 * показывается отдельным блоком сверху, чтобы часто нужное было под рукой.
 *
 * Логика чистая: список путей, добавление, снятие и переключение. Проверяется
 * тестами, а проводнику остаётся показать готовый список строк.
 *
 * Порядок закрепления сохраняем: человек сам решает, что выше. Повторное
 * закрепление не двигает путь вверх — иначе строка «прыгала» бы от лишнего клика.
 */

/** Потолок: закреплённый блок не должен вытеснять само дерево. */
export const MAX_PINNED = 40;

/** Переключить закрепление пути: закрепить, если его нет; снять, если есть. */
export function togglePin(pinned: readonly string[], path: string): string[] {
  if (pinned.includes(path)) return pinned.filter((item) => item !== path);
  return [...pinned, path].slice(0, MAX_PINNED);
}

export function isPinned(pinned: readonly string[], path: string): boolean {
  return pinned.includes(path);
}

/**
 * Убрать пути, лежащие вне проекта. Зовётся при смене проекта: закрепление на
 * файл другого проекта бессмысленно — открывать по нему нечего.
 */
export function normalizePins(pinned: readonly string[], root: string | null): string[] {
  if (!root) return [];
  return pinned.filter((path) => isInsidePath(root, path));
}
