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

/** Пункт меню быстрой правки. Структура та же, что у `CommandItem` реестра команд. */
export interface InstallMenuItem {
  id: string;
  title: string;
  category: string;
  run: () => void;
}

/**
 * Язык, который умеет «поставить пакет»: для него быстрая правка переводит
 * имя модуля в имя пакета и зовёт менеджер.
 */
export function installLanguageOf(languageId: string): { python: boolean } | null {
  if (languageId === 'python') return { python: true };
  if (languageId === 'javascript' || languageId === 'typescript') return { python: false };
  return null;
}

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

/**
 * Пункты меню для предложений «поставить пакет»: одно действие на пакет.
 *
 * Живёт здесь, а не в `app.ts`, потому что это подпись, а не поведение:
 * что написать в меню для Python (`pip`) и для Node (`npm`), решает тот же
 * модуль, что решает, какие пакеты предлагать. Как ставить — знает вызывающий
 * (`installPackage` он получает функцией).
 */
export function installMenuItems(
  suggestions: readonly InstallSuggestion[],
  python: boolean,
  installPackage: (pkg: string, python: boolean) => void,
): InstallMenuItem[] {
  return suggestions.map((suggestion) => ({
    id: `install:${suggestion.package}@${python ? 'pip' : 'npm'}`,
    title: python ? `Установить пакет ${suggestion.package} (pip)` : `Установить пакет ${suggestion.package} (npm)`,
    category: python ? 'Python' : 'Node',
    run: () => installPackage(suggestion.package, python),
  }));
}

/**
 * Слово к числу файлов и папок в корзине: 1 объект, 2 объекта, 5 объектов.
 *
 * Своё склонение, а не `plural` из `run-log`: там слово возвращается вместе с
 * числом, а здесь нужна подстановка в фразу (`… ${n} ${objectsWord(n)}?`).
 */
export function objectsWord(count: number): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return 'объектов';
  const last = count % 10;
  if (last === 1) return 'объект';
  if (last >= 2 && last <= 4) return 'объекта';
  return 'объектов';
}
