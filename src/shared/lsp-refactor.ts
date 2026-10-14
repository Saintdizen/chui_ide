/**
 * Извлечение и «разворачивание» (inline) как СВОИ команды редактора.
 *
 * Сам рефакторинг умеет только языковой сервер: он один знает, куда вынести выражение
 * и какие места переписать. Мы не изобретаем преобразование текста, а просим у сервера
 * действие нужного вида (`refactor.extract.*` / `refactor.inline.*`) и применяем то,
 * что он предложил. Здесь — чистое правило: какой вид просить и как отбирать действия
 * по виду из общего ответа `textDocument/codeAction`.
 *
 * Виды у LSP составные и иерархические: `refactor.extract` накрывает подвиды
 * (`refactor.extract.function`, `.variable`, `.constant`, `.method`, `.type_`), а
 * серверы сверяют вид по-разному — часть строго по имени, часть по префиксу. Поэтому
 * в запросе называем родителя (`refactor`), а нужный подвид отбираем сами, здесь.
 *
 * Модуль чистый: ни сети, ни DOM — проверяется тестами без окна.
 */

import type { CodeActionItem } from './lsp-code-actions';

/** Что делаем: вынести выражение в переменную/функцию или развернуть символ на месте. */
export type RefactorAction = 'extract' | 'inline';

/** Вид действия в LSP, с которого начинается нужный рефакторинг. */
export function refactorKind(action: RefactorAction): string {
  return action === 'extract' ? 'refactor.extract' : 'refactor.inline';
}

/** Русское имя рефакторинга — для сообщений человеку. */
export function refactorLabel(action: RefactorAction): string {
  return action === 'extract' ? 'извлечение' : 'разворачивание';
}

/**
 * Подходит ли действие под запрошенный рефакторинг. Сверяем по границе отрезка:
 * `refactor.extract` и `refactor.extract.function` — одно и то же действие, а вот
 * `refactor.extraction` (такого вида нет, но проверка должна быть строгой) — нет.
 */
export function isRefactorKind(kind: string, action: RefactorAction): boolean {
  const wanted = refactorKind(action);
  return kind === wanted || kind.startsWith(`${wanted}.`);
}

/** Отобрать из ответа сервера действия нужного вида — остальные рефакторинги не наши. */
export function pickRefactors(items: readonly CodeActionItem[], action: RefactorAction): CodeActionItem[] {
  return items.filter((item) => isRefactorKind(item.kind, action));
}

/**
 * Любой ли это рефакторинг — из раздела `refactor` (включая подвиды). Отбор по границе
 * отрезка тот же, что у `isRefactorKind`: вид `refactor` и `refactor.*` — наши, а похожее
 * слово (`refactoring`) — нет.
 */
export function isAnyRefactorKind(kind: string): boolean {
  return kind === 'refactor' || kind.startsWith('refactor.');
}

/**
 * Все рефакторинги из ответа сервера, без деления на извлечение и разворачивание. Так
 * работает общий список «Рефакторинг…»: что предложил сервер, то и показываем — не только
 * извлечение и inline, но и, например, «вынести в отдельный файл» или «преобразовать».
 */
export function pickAnyRefactors(items: readonly CodeActionItem[]): CodeActionItem[] {
  return items.filter((item) => isAnyRefactorKind(item.kind));
}
