export const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * Адрес можно отдать системному обработчику.
 *
 * Ссылки из интерфейса (ответ модели, документация) должны открываться в браузере
 * и почте, но не в обработчике произвольной схемы: `file:` откроет чужой файл,
 * а собственная схема запустит зарегистрированную программу. Проверяем схему
 * разбором через `URL`, а не поиском подстроки: `javascript:` и `data:` не должны
 * проходить, и регистр схемы значения не имеет.
 */
export function isSafeExternalUrl(target: string): boolean {
  try {
    return EXTERNAL_SCHEMES.includes(new URL(target).protocol.toLowerCase());
  } catch {
    return false;
  }
}
