/**
 * Исполнение операций с файлами из `WorkspaceEdit` сервера (переименование, создание, удаление).
 *
 * Сервер присылает список операций вперемешку с флагами «пропустить молча»
 * (`ignoreIfExists`, `ignoreIfNotExists`): ими он говорит, что отсутствие файла или
 * существование цели — не беда, а не ошибка. Разбираться в этом на месте, в обвязке
 * редактора, значит держать четыре вложенных условия рядом с `rpc.request` — и не иметь
 * возможности проверить, что «молча» действительно молчит.
 *
 * Здесь только решения: что выполнить, что пропустить, чем кончится ошибка.
 * Запрос к main остаётся у окна — оно подставляет `createFile` / `rename` / `trash`.
 */

import type { FileOperation } from '../../shared/lsp-workspace-edit';

/** Что делать с упавшей операцией: выполнено (нужное уже есть) или пропущено. */
export type FileOperationOutcome = { kind: 'skipped' } | { kind: 'failed'; error: string };

/**
 * Как поступить с операцией, если её запрос упал.
 *
 * «Пропустить молча» уважаем только у своей операции: `ignoreIfExists` не прощает
 * провал удаления, иначе эти две политики склеились бы в одну и мы бы теряли ошибки
 * там, где их надо показывать.
 */
export function outcomeOfFailure(operation: FileOperation, error: unknown): FileOperationOutcome {
  if (operation.kind === 'create' && operation.ignoreIfExists) return { kind: 'skipped' };
  if (operation.kind === 'delete' && operation.ignoreIfNotExists) return { kind: 'skipped' };
  return { kind: 'failed', error: fileOperationError(operation, error) };
}

/**
 * Человеческая часть сообщения об ошибке: что именно не удалось.
 *
 * У переименования обе стороны: без «откуда → куда» сообщение не говорит, куда идти
 * смотреть.
 */
export function failedOperationLabel(operation: FileOperation): string {
  return operation.kind === 'rename' ? `${operation.from} → ${operation.to}` : operation.path;
}

/** Текст ошибки для человека — единый вид у всех трёх операций. */
export function fileOperationError(operation: FileOperation, error: unknown): string {
  return `Не удалось выполнить операцию с файлом ${failedOperationLabel(operation)}: ${String(error)}`;
}
