/**
 * «Избранное» — постоянный список мест, к которым человек возвращается: папки
 * проектов, часто правимые файлы, чужие репозитории, которые открываешь заодно.
 *
 * Чем это отличается от закрепления сверху (см. `renderer/core/tree-pins.ts`).
 * Закрепление — про ТЕКУЩИЙ проект: список живёт в сессии проекта, при смене
 * проекта чистится от чужих путей, и всё это про «под рукой сейчас». Избранное —
 * про «вообще», оно живёт в настройках IDE, переживает смену проекта и может
 * указывать на папку ВНЕ рабочей области: клик по такой папке поднимает её
 * корнем области (см. `ui/explorer.ts`). Одно заменяет другое плохо, поэтому
 * списки разные, а не один с флажком.
 *
 * Логика чистая: список строк, порядок добавления, потолок. Проверяется тестами.
 */

/** Потолок: блок избранного не должен вытеснять дерево. */
export const MAX_FAVORITES = 50;

/**
 * Добавить путь в избранное. Повтор ничего не меняет и НЕ двигает путь вверх:
 * иначе случайный клик перестраивал бы привычный порядок.
 */
export function addFavorite(favorites: readonly string[], path: string): string[] {
  const clean = path.trim();
  if (!clean || favorites.includes(clean)) return [...favorites];
  return [...favorites, clean].slice(0, MAX_FAVORITES);
}

/** Убрать путь из избранного. */
export function removeFavorite(favorites: readonly string[], path: string): string[] {
  return favorites.filter((item) => item !== path);
}

/** Переключить: нет в списке — добавить, есть — убрать. */
export function toggleFavorite(favorites: readonly string[], path: string): string[] {
  return favorites.includes(path) ? removeFavorite(favorites, path) : addFavorite(favorites, path);
}

export function isFavorite(favorites: readonly string[], path: string): boolean {
  return favorites.includes(path);
}

/**
 * Привести список из настроек к безопасному виду: файл настроек мог быть правлен
 * руками. Пустые строки и повторы убираем, порядок сохраняем, потолок держим.
 */
export function normalizeFavorites(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean || result.includes(clean)) continue;
    result.push(clean);
    if (result.length >= MAX_FAVORITES) break;
  }
  return result;
}
