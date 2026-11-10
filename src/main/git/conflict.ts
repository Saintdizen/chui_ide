import type { GitStatus } from '../../shared/api';
import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import type { ConflictContext } from './contexts';
import { execGit } from './exec';
import { locateFile } from './locate';

/**
 * Вернуть файл в состояние «не слит»: стадии 1–3 в индексе и маркеры в рабочем файле.
 *
 * Зачем это нужно после «отметить решённым»: `git add` убивает стадии 1–3, и файл
 * становится обычным изменением — ни сторон, ни разбора, ни возможности переиграть.
 * `git checkout -m` восстанавливает стадии из информации о слиянии и заново вписывает
 * маркеры. Работа человека при этом теряется, поэтому сначала сравниваем с индексом:
 * если в файле есть правка поверх него (дописали руками после отметки), отказываем,
 * пока не сказали `force`.
 */
export async function remerge(context: ConflictContext, filePath: string, force = false): Promise<GitStatus> {
  const { repoRoot, relative } = await locateFile(context.status, filePath);

  if (!force && (await hasWorkAtRisk(repoRoot, relative))) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      'Пере-слияние затрёт то, что сейчас в файле. Сохрани нужное или подтверди потерю',
    );
  }

  const result = await execGit(['checkout', '-m', '--', relative], repoRoot, { allowFailure: true });
  if (!result.ok) {
    // Самая частая причина — слияния уже нет: `checkout -m` требует стадии 1–3
    // в индексе или незавершённого слияния, которого нет.
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'Пере-слияние невозможно: слияния уже нет или файл вне него');
  }
  return context.refresh();
}

/**
 * Есть ли в файле на диске что-то, чего нет в индексе.
 *
 * Не сравниваем с «нашей стороной»: после `git add` в индексе ЛЕЖИТ РЕЗУЛЬТАТ
 * разрешения — единственная копия работы человека. Отличить «он это написал» от
 * «git это написал» по содержимому нельзя, а «правили после отметки» — видно точно.
 * `--quiet` даёт только код возврата: 0 — совпадает, 1 — нет.
 */
async function hasWorkAtRisk(repoRoot: string, relative: string): Promise<boolean> {
  const result = await execGit(['diff', '--quiet', '--', relative], repoRoot, { allowFailure: true });
  return !result.ok;
}

export async function markResolved(context: ConflictContext, filePath: string): Promise<GitStatus> {
  const { repoRoot, relative } = await locateFile(context.status, filePath);
  await execGit(['add', '--', relative], repoRoot);
  return context.refresh();
}
