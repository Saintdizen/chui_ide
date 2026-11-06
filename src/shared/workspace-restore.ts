/**
 * Какие корни поднять при старте и какой сделать активным.
 *
 * Почему отдельная чистая функция: восстанавливать рабочую область надо
 * осторожно. Папка могла исчезнуть с диска или оказаться недоступной (флешка,
 * снимаемый диск, удалённый адрес без сети) — и тогда «вернуть как было»
 * означало бы не открыть НИЧЕГО. Поэтому запомненный набор проходит три сита:
 *
 * 1. пустые и не-строки выбрасываются (файл настроек правили руками);
 * 2. дубли убираются — два одинаковых корня дали бы две ветки одного дерева;
 * 3. живой проверяется снаружи и передаётся `alive`: несуществующие корни
 *    не поднимаем, иначе дерево начнёт с ошибки чужой папки.
 *
 * Активный выбирается последним: если он выпал, его роль берёт первый
 * выживший. Возвращать `activeRoot` вне набора нельзя — git и поиск пойдут в
 * путь, которого в области нет.
 */
export interface RestorePlan {
  readonly roots: readonly string[];
  readonly activeRoot: string | null;
}
export function restoreRoots(
  saved: readonly unknown[],
  active: unknown,
  alive: (root: string) => boolean,
): RestorePlan {
  const roots: string[] = [];
  for (const item of saved) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (roots.includes(item)) continue;
    if (!alive(item)) continue;
    roots.push(item);
  }
  const wanted = typeof active === 'string' && roots.includes(active) ? active : null;
  return { roots, activeRoot: wanted ?? roots[0] ?? null };
}
