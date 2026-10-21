/**
 * Итог операции с историей — текстом и тоном.
 *
 * Rebase не заканчивается одним исходом: он может встать с конфликтом (человек должен
 * его разрешить), может остаться незавершённым (коммит исправлен — надо продолжить)
 * и может просто пройти. Порядок проверок — не стиль: конфликт важнее «идёт», иначе
 * человек увидит бодрое «rebase идёт», хотя дальше шаг не пройдёт без него.
 */

export type GitResult = { ok: boolean; inProgress: boolean; conflict: boolean; message: string };

export interface Notice {
  message: string;
  kind: 'info' | 'error';
}

/** Сообщение самому rebase — в нём есть собственная ошибка из git. */
export function rebaseNotice(result: GitResult): Notice {
  if (result.conflict) return { message: 'Есть конфликты — разрешите их и продолжите rebase', kind: 'error' };
  if (result.inProgress) return { message: 'Rebase идёт: исправьте коммит и продолжите', kind: 'info' };
  if (result.ok) return { message: 'Rebase завершён', kind: 'info' };
  return { message: result.message, kind: 'error' };
}

/**
 * Сообщение продолжения/пропуска/отмены.
 *
 * Провал берём из `message`: там git говорит, чего он не смог (например, «нет
 * rebase в процессе»). Общий текст «не удалось» заставил бы гадать.
 */
export function gitStepNotice(result: GitResult, done: string): Notice {
  if (result.conflict) return { message: 'Есть конфликты — разрешите их и продолжите rebase', kind: 'error' };
  return result.ok ? { message: done, kind: 'info' } : { message: result.message, kind: 'error' };
}
