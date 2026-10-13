import type { GitFileStatus } from './api';
import { parentOf } from './paths';

/**
 * Удалённые, но ещё не закоммиченные файлы, лежащие прямо в папке.
 *
 * Дерево проекта читает диск, поэтому удалённого файла в её списке нет вовсе —
 * хотя правка (удаление) есть, и о ней стоит знать. Такие файлы собираются
 * отдельно: чистая логика без DOM, поэтому проверяется тестами.
 *
 * Берём только смену `deleted`: переименование git показывает как пару путей, и
 * «удалённой» половины у него нет — файл просто переехал.
 */
export function deletedInFolder(files: readonly GitFileStatus[], dir: string): GitFileStatus[] {
  return files.filter((file) => file.change === 'deleted' && parentOf(file.path) === dir);
}
