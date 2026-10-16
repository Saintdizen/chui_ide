/**
 * Изображения: какие форматы редактор умеет ПОКАЗЫВАТЬ, а не открывать текстом.
 *
 * Список живёт в `shared`, потому что нужен обеим сторонам: main по нему решает,
 * отдавать ли файл как картинку (и каким типом), а renderer — открывать ли вкладку
 * вьюером вместо текста. Держать эти списки порознь — верный способ развести их
 * так, что файл откроется, но не отобразится.
 *
 * Текстовые расширения и значки файлов — не здесь: это `shared/languages.ts`.
 * Сюда попадает ровно то, что считается картинкой.
 */

/** Расширение (без точки, в нижнем регистре) → тип содержимого. */
export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  apng: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * Типы, которые движок отрисовывает в `<img>`. Всё остальное — тоже картинки
 * (TIFF, HEIC из телефона), но их Chromium не декодирует: вьюер покажет
 * заглушку с объяснением, а не «битую» рамку. Список живёт рядом с таблицей
 * форматов: разойтись значило бы опять показывать пустое место.
 */
const RENDERABLE_IMAGE_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/avif',
  'image/svg+xml',
]);

/** Рисует ли движок такой тип содержимого — или показывать придётся заглушку. */
export function canRenderImageMime(mime: string): boolean {
  return RENDERABLE_IMAGE_MIME.has(mime);
}

/** Предел на картинку для просмотра: выше — отказ, а не «полтора гигабайта в окне». */
export const MAX_VIEW_IMAGE_BYTES = 32 * 1024 * 1024;

/** Расширение файла в нижнем регистре (без точки); пустая строка — расширения нет. */
export function imageExtension(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Тип содержимого картинки по пути; `null` — это не изображение. */
export function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[imageExtension(filePath)] ?? null;
}

/** Открывать ли файл вьюером картинок, а не текстом. */
export function isImagePath(filePath: string): boolean {
  return imageMimeType(filePath) !== null;
}

/** Короткая подпись формата для интерфейса: «PNG», «JPEG», «SVG». */
export function imageFormatLabel(filePath: string): string {
  const extension = imageExtension(filePath);
  if (extension === 'jpg' || extension === 'jpe' || extension === 'jfif') return 'JPEG';
  if (extension === 'tif') return 'TIFF';
  if (extension === 'svg') return 'SVG';
  return extension ? extension.toUpperCase() : 'Изображение';
}
