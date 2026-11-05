import type { LspServerConfig } from './api';

/**
 * Тот же ли это сервер и с теми же настройками.
 *
 * Сравниваем только то, что сервер получает при старте: команда, аргументы,
 * окружение, `initializationOptions` и доп. корни. `priority` не в счёт — он
 * решает, кого пробовать первым, и на уже поднятый процесс не влияет; по нему
 * перезапускать нечего. Для остального — перезапуск: сервер держит старую
 * команду и старые опции в памяти, по-другому их не поменять.
 */
export function sameServerConfig(a: LspServerConfig, b: LspServerConfig): boolean {
  return (
    a.language === b.language &&
    a.enabled === b.enabled &&
    a.command === b.command &&
    sameList(a.args, b.args) &&
    sameList(a.extraFolders ?? [], b.extraFolders ?? []) &&
    sameEntries(a.env, b.env) &&
    sameEntries(a.initializationOptions, b.initializationOptions)
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Записи — без учёта порядка: `{A:1,B:2}` и `{B:2,A:1}` сервер различить не может,
 * а правка одного поля в редакторе легко меняет порядок ключей.
 */
function sameEntries(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b ?? {}).sort(([x], [y]) => x.localeCompare(y));
  if (left.length !== right.length) return false;
  return left.every(([key, value], index) => {
    const [otherKey, otherValue] = right[index] ?? [];
    return key === otherKey && JSON.stringify(value) === JSON.stringify(otherValue);
  });
}
