/**
 * PDF как вкладка-страница: правила, общие для main и renderer.
 *
 * PDF — не текст: открыть его редактором нельзя (в документ попал бы бинарь), а
 * показать — есть чем. Просмотрщик встроен в движок Chromium: `WebContentsView`
 * с включёнными плагинами рисует настоящий PDF со своей панелью страниц, масштаба
 * и печати. Поэтому вкладка PDF — это вкладка ВСТРОЕННОГО БРАУЗЕРА, а не файловая:
 * и модель у неё та же (`BrowserTabs`), и место на экране то же.
 *
 * Здесь только чистое: какие файлы считаем PDF, до какого размера их показываем и
 * как из пути получается `file:`-адрес. Проверка «путь внутри проекта» живёт в main
 * (`browser/panel.ts` спрашивает рабочую папку), потому что только она знает корень.
 */

/** Расширение в нижнем регистре: своё, чтобы не тянуть сюда `images.ts` ради одной строки. */
function extensionOf(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Это PDF (по имени файла). Содержимое не читаем: решает расширение, как и у картинок. */
export function isPdfPath(filePath: string): boolean {
  return extensionOf(filePath) === 'pdf';
}

/**
 * Предел на файл для просмотра. Просмотрщик держит документ в памяти целиком,
 * поэтому «паспорт скана на 800 МБ» открывать в окне IDE не надо — пусть его
 * откроет система. Своё число, а не предел редактора: тот считает текст.
 */
export const MAX_VIEW_PDF_BYTES = 64 * 1024 * 1024;

/** Подпись вкладки: имя файла, а не путь целиком — путь целиком не влезает в полосу. */
export function pdfTabTitle(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  return name || 'Документ.pdf';
}

/**
 * `file:`-адрес из абсолютного пути.
 *
 * `pathToFileURL` есть только в Node, а адрес нужен и renderer'у (он заводит
 * вкладку) — поэтому собираем сами. Кодируем посегментно: `#`, `?` и `%` в имени
 * файла иначе превратили бы адрес в другой; буква диска Windows остаётся как есть,
 * иначе `file:///C%3A/...` движок не откроет.
 */
export function fileUrlFor(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/');
  const encoded = segments
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  const withRoot = encoded.startsWith('/') ? encoded : `/${encoded}`;
  return `file://${withRoot}`;
}

/**
 * Обратный разбор: путь из `file:`-адреса. Нужен, чтобы main проверил адрес,
 * пришедший из renderer'а, тем же правилом, что и любой другой путь.
 */
export function pathFromFileUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol.toLowerCase() !== 'file:') return null;
  // `file:///C:/a/b.pdf` → `/C:/a/b.pdf` → `C:/a/b.pdf`.
  // decodeURIComponent бросает на битом проценте — тогда это не адрес.
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const unixLike = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  // Адрес с хозяином (`file://host/share`) — это сетевой путь, а не файл проекта.
  if (parsed.hostname && parsed.hostname !== 'localhost') return null;
  return unixLike;
}
