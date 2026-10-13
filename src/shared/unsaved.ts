import { nameOf } from './paths';

/**
 * Текст диалога при закрытии окна с несохранёнными файлами.
 *
 * Живёт в `shared`, а не в main: это то, что прочитает человек, и это стоит
 * закрепить тестом. Полные пути в диалоге не читаются, поэтому имена берём
 * последним сегментом (разделитель — из самого пути, см. `shared/paths`).
 */

/** Сколько имён перечисляем, прежде чем свернуть остальные в «и ещё N». */
const MAX_LISTED_NAMES = 8;

export interface UnsavedClosePrompt {
  message: string;
  detail: string;
}

/**
 * Список имён для подсказки: полные пути в диалоге не читаются, поэтому берём
 * последний сегмент (разделитель — из самого пути, см. `shared/paths`).
 */
function listNames(files: readonly string[]): string {
  const names = files.map((file) => nameOf(file));
  const listed = names.slice(0, MAX_LISTED_NAMES).join(', ');
  const rest = names.length - Math.min(names.length, MAX_LISTED_NAMES);
  return `${listed}${rest > 0 ? ` и ещё ${rest}` : ''}`;
}

export function unsavedClosePrompt(files: readonly string[]): UnsavedClosePrompt {
  if (files.length === 0) return { message: 'Нет несохранённых файлов', detail: '' };

  const message = files.length === 1 ? 'Файл изменён и не сохранён' : `Несохранённых файлов: ${files.length}`;
  return { message, detail: `${listNames(files)}. Сохранить перед закрытием?` };
}

/**
 * Текст подтверждения перед возвратом файлов к версии на диске. Правки в буфере
 * при этом теряются, поэтому спрашиваем отдельно и перечисляем, что потеряется.
 */
export function revertPrompt(files: readonly string[]): UnsavedClosePrompt {
  if (files.length === 0) return { message: 'Правок в буфере нет', detail: '' };

  const message = files.length === 1 ? 'Отменить правки в буфере?' : `Отменить правки в буфере: файлов ${files.length}`;
  return {
    message,
    detail: `${listNames(files)}. Файлы будут перечитаны с диска, правки в них потеряются.`,
  };
}
