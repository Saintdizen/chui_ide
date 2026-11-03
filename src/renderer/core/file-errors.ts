/**
 * Причина отказа файловой операции — словами.
 *
 * ПОЧЕМУ ЭТОТ МОДУЛЬ ПОЯВИЛСЯ. В `file-mutation-commands.ts` перенос ловил
 * ошибку голым `catch {}` и на любую показывал «в целевой папке уже есть такое
 * имя». Переименовал файл без прав или перенёс в удалённую папку — получил тот
 * же текст и искал несуществующий конфликт имён. Ветка main живёт с правами
 * root, поэтому такие отказы вылезли только у пользователя.
 *
 * Разбираем по `code` из системного вызова, а не по тексту сообщения: тексты
 * приходят английские и разные в разных системах, а коды — часть договора.
 */
export interface FileErrorLike {
  /** Код системного вызова: `EACCES`, `ENOENT`, … Может лежать в `details`. */
  readonly code?: unknown;
  /** Сообщение — запасной путь, когда кода нет. */
  readonly message?: unknown;
}

/** Достать код из ошибки в любом виде, в каком он приходит. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const direct = (error as FileErrorLike).code;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  // `RpcError` несёт `details`, а туда main кладёт поле из системной ошибки.
  const details = (error as { details?: unknown }).details;
  if (typeof details === 'object' && details !== null) {
    const nested = (details as FileErrorLike).code;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  // Запасной путь: текст вида «ENOENT: no such file». Коды — латинские и в
  // верхнем регистре, поэтому ищем словоформу, а не любое «error».
  const rawMessage = (error as { message?: unknown }).message;
  const message = typeof rawMessage === 'string' ? rawMessage : '';

  const found = /\b(E[A-Z]{2,12})\b/.exec(message);
  return found ? found[1]! : null;
}

/**
 * Что сказать человеку про отказ. `null` — ничего полезного не знаем, пусть
 * вызывающий решает сам (или покажет своё сообщение по умолчанию).
 *
 * Тексты говорят не «что сломалось», а «что делать»: у каждого кода есть
 * действие, которое человек может предпринять сам.
 */
export function describeFileError(error: unknown, what = 'файл'): string | null {
  const code = errorCode(error);
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      // Не «нет прав» в воздух: человеку нужно знать, чьи это права и куда идти.
      return `Нет прав: ${what} защищён от записи. Правами владеет владелец файла или администратор.`;
    case 'ENOENT':
      return `Не найдено: ${what} исчез — возможно, его удалили или переместили в другом окне.`;
    case 'EEXIST':
      return `Имя занято: в папке уже есть такой ${what}.`;
    case 'ENOSPC':
      return 'Не хватает места на диске: освободите немного и повторите.';
    case 'ENAMETOOLONG':
      return 'Слишком длинное имя: сократите его или вложенность папок.';
    case 'EISDIR':
      return `Это папка, а не ${what}: операция ждёт файл.`;
    case 'ENOTDIR':
      return `Это ${what}, а не папка: адрес указывает на файл.`;
    case 'EBUSY':
      return `Занято: ${what} открыт в другой программе — закройте её и повторите.`;
    case 'EXDEV':
      return 'Разные диски: переместить напрямую нельзя — сделайте копию и удалите исходное.';
    case 'EROFS':
      return 'Диск только для чтения: записать нельзя.';
    default:
      return code ? `Не удалось: система ответила ${code}.` : null;
  }
}
