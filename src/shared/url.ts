export const EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * Адрес, который можно показать во встроенном браузере (`<webview>`).
 *
 * Пускаем только сетевые схемы: `file:` показал бы локальный файл мимо дерева и
 * прав, а `javascript:` и `data:` — это уже запуск чужого кода. Схему читаем
 * разбором через `URL`, а не поиском подстроки: регистр не должен влиять.
 */
export function isWebPageUrl(target: string): boolean {
  try {
    const protocol = new URL(target).protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

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

/**
 * Тот же адрес приложения, что и `base` — один узел по схеме и хозяину.
 *
 * Нужно, чтобы отличить перезагрузку СВОЕЙ страницы (dev-сервер или собранный
 * renderer `app://`) от ухода на чужой сайт: первое мы пускаем в окне, второе
 * отдаём системному браузеру. Сравниваем схему и хозяина, а не весь URL: путь
 * роли не играет, а у нестандартной схемы (`app:`) браузерный `origin` пуст
 * («null») и на сравнение не годится.
 */
export function isSameUrlOrigin(target: string, base: string): boolean {
  try {
    const own = new URL(base);
    const dest = new URL(target);
    return dest.protocol === own.protocol && dest.host === own.host;
  } catch {
    return false;
  }
}
