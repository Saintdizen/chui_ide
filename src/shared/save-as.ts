/**
 * Решение «куда сохранять файл под другим именем» (Save As).
 *
 * Выбор пути за человеком (диалог системы), но три случая из четырёх решаются без
 * диска: диалог отменили, выбран тот же путь (это обычное сохранение) и выбран путь
 * ВНЕ рабочей области (писать туда нельзя — IDE работает в границах области).
 * Остаётся единственный случай с работой — запись.
 *
 * Решение вынесено чистой функцией, потому что ошибиться здесь дорого, а проверить
 * без окна иначе нечем: у самого приложения выбор пути зашит в обработчик команды.
 * Ни ФС, ни IPC: только строки и корни области (`shared/workspace-roots.ts`).
 */

import { rootForPath, type WorkspaceRoot } from './workspace-roots';

export type SaveAsDecision =
  /** Диалог закрыли или путь пустой — сохранять нечего. */
  | { kind: 'cancel' }
  /** Выбран путь самого файла: это обычное сохранение, а не копия. */
  | { kind: 'same-path' }
  /** Путь вне рабочей области — писать туда нельзя. */
  | { kind: 'outside'; message: string }
  /** Осталось записать текст по этому пути. */
  | { kind: 'write'; target: string };

/** Текст отказа. Один и тот же и в решении, и в уведомлении — чтобы не разъехались. */
export const OUTSIDE_WORKSPACE_MESSAGE = 'Сохранять можно только внутри рабочей области';

/**
 * Путь без пробелов по краям и без хвостовых разделителей: диалог может вернуть
 * `/project/dir/`, и писать по такому пути — значит метить в каталог. Хвостовой
 * разделитель убираем ТЕМ ЖЕ правилом, что и `workspace-roots`, иначе решение
 * «внутри области» и путь записи разъехались бы.
 */
function normalizeTarget(value: string): string {
  return value.trim().replace(/[/\\]+$/, '');
}

/** Что делать с путём, выбранным в диалоге сохранения. */
export function decideSaveAs(
  current: string,
  picked: string | null | undefined,
  roots: readonly WorkspaceRoot[],
): SaveAsDecision {
  const target = typeof picked === 'string' ? normalizeTarget(picked) : '';
  if (!target) return { kind: 'cancel' };
  if (target === normalizeTarget(current)) return { kind: 'same-path' };
  if (!rootForPath(roots, target)) return { kind: 'outside', message: OUTSIDE_WORKSPACE_MESSAGE };
  return { kind: 'write', target };
}
