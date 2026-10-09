/**
 * Предложения «поставить пакет» по недостающим импортам.
 *
 * Общее для Python и Node: подчёркивание импортов (`renderer/core/import-check.ts`)
 * знает, чего не хватает, а быстрая правка предлагает это доустановить. Разница
 * только в имени: у Python модуль и пакет — не одно и то же (`yaml` → `PyYAML`),
 * у Node имя пакета берётся из самого импорта (`zod`, `@scope/pkg`).
 *
 * Поэтому перевод «модуль → пакет» приходит сюда функцией: правило языка живёт
 * в своём модуле, а отбор уникальных предложений — здесь.
 */

import type { ImportRef } from './imports';

/** Что предложить поставить: модуль, из-за которого подняли, и имя пакета. */
export interface InstallSuggestion {
  /** Имя, как написано в импорте (`yaml`, `zod`). */
  module: string;
  /** Имя для менеджера пакетов (`PyYAML`, `zod`). */
  package: string;
}

/**
 * Что предложить поставить для импортов на указанных строках.
 *
 * Строки, а не позиции: быструю правку зовут с курсором в строке, и требовать
 * попасть точно в имя модуля незачем. Дубликаты убираем — один пакет ставится
 * один раз, сколько бы раз его ни импортировали.
 *
 * `toPackage` по умолчанию не меняет имя: у Node пакет и модуль совпадают.
 */
export function installSuggestions(
  refs: readonly ImportRef[],
  lines: ReadonlySet<number>,
  toPackage: (module: string) => string = (module) => module,
): InstallSuggestion[] {
  const seen = new Set<string>();
  const suggestions: InstallSuggestion[] = [];

  for (const ref of refs) {
    if (!lines.has(ref.line)) continue;
    const pkg = toPackage(ref.top);
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    suggestions.push({ module: ref.top, package: pkg });
  }

  return suggestions;
}
