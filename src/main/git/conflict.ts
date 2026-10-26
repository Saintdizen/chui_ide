import type { GitStatus } from '../../shared/api';
import type { ConflictContext } from './contexts';
import { execGit } from './exec';
import { locateFile } from './locate';

/**
 * Отметить конфликт решённым: содержимое рабочего файла уходит в индекс.
 *
 * Отдельно от `stage`: `add -A` тронул бы и соседние пути, а тут нужен ровно
 * этот — и именно `--`, иначе файл с именем вида `-f` станет флагом.
 */
export async function markResolved(context: ConflictContext, filePath: string): Promise<GitStatus> {
  const { repoRoot, relative } = await locateFile(context.status, filePath);
  await execGit(['add', '--', relative], repoRoot);
  return context.refresh();
}
