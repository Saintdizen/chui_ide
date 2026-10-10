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

export function unsavedClosePrompt(files: readonly string[]): UnsavedClosePrompt {
  if (files.length === 0) return { message: 'Нет несохранённых файлов', detail: '' };

  const names = files.map((file) => nameOf(file));
  const listed = names.slice(0, MAX_LISTED_NAMES).join(', ');
  const rest = names.length - Math.min(names.length, MAX_LISTED_NAMES);

  const message = names.length === 1 ? 'Файл изменён и не сохранён' : `Несохранённых файлов: ${names.length}`;
  const detail = `${listed}${rest > 0 ? ` и ещё ${rest}` : ''}. Сохранить перед закрытием?`;
  return { message, detail };
}
