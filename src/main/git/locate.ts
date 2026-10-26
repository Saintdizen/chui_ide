import path from 'node:path';
import { RpcErrorCode, type GitStatus } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * Абсолютные пути из интерфейса → корень репозитория и пути от него.
 *
 * Границы задаёт статус: индекс знает только файлы со своими правками, и это
 * здесь нарочно. Так откат блока не превращается в «применить патч к чему угодно
 * внутри корня»: цель обязана быть файлом, о котором git уже что-то говорит.
 */
export async function locatePaths(
  status: () => Promise<GitStatus>,
  paths: string[],
): Promise<{ repoRoot: string; relative: string[] }> {
  const current = await status();
  const repoRoot = current.repository?.root;
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const known = new Map(current.files.map((file) => [file.path, file]));
  const relative = paths.map((target) => {
    const absolute = path.resolve(target);
    const file = known.get(absolute);
    if (!file) throw new RpcFailure(RpcErrorCode.NotFound, `Вне репозитория или без изменений: ${absolute}`);
    return file.relative;
  });

  return { repoRoot, relative };
}

/** То же для одного файла, у которого берут блоки изменений. */
export async function locateFile(
  status: () => Promise<GitStatus>,
  filePath: string,
): Promise<{ repoRoot: string; relative: string }> {
  const current = await status();
  const repoRoot = current.repository?.root;
  if (!repoRoot) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Это не репозиторий git');

  const known = current.files.find((file) => file.path === path.resolve(filePath));
  if (!known) throw new RpcFailure(RpcErrorCode.NotFound, 'У файла нет изменений');
  return { repoRoot, relative: known.relative };
}
