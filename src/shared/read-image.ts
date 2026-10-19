import { formatBytes, imageMimeLabel } from './images';

/**
 * Картинка для агента (`read_image`): что модели можно отправлять, что делать с
 * крупными файлами и что инструмент отвечает словами.
 *
 * Модуль чистый: файл читает и уменьшает main (`ai/read-image.ts`), а здесь —
 * только правила. Поэтому их можно проверить тестом, не имея ни настоящего PNG,
 * ни Electron: пределы, порядок уменьшения и текст ответа считаются от чисел.
 *
 * Зачем уменьшать: картинка едет в КАЖДОМ следующем запросе беседы — история
 * пересылается целиком. Скриншот на 6 МБ, приложенный один раз, стоит дороже
 * десяти прочитанных файлов, и окно кончается на одном снимке экрана.
 */

/** Форматы, которые провайдеры принимают картинкой как есть (OpenAI и Anthropic совпадают). */
const SENDABLE_MIME: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Файл больше — отказ словами: в base64 он не влезет ни в запрос, ни в разумную память. */
export const MAX_READ_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Длинная сторона после уменьшения. 1568 — совет Anthropic: большее разрешение
 * модели всё равно не разбирают подробнее, а платят за него токенами.
 */
export const READ_IMAGE_MAX_SIDE = 1568;

/** Сколько картинка весит после уменьшения: это потолок, а не цель. */
export const READ_IMAGE_TARGET_BYTES = 1_500_000;

/** Размер картинки в пикселях и байтах. Размеры 0 — их определить не удалось. */
export interface ImageSize {
  width: number;
  height: number;
  bytes: number;
}

/** Одна попытка уменьшения: до какой стороны, во что перекодировать. */
export interface ShrinkStep {
  /** Длинная сторона после уменьшения. */
  maxSide: number;
  /** PNG сохраняет прозрачность, JPEG мельче для фото — поэтому ступени разные. */
  format: 'png' | 'jpeg';
  /** Качество JPEG: только для `format: 'jpeg'`. */
  quality?: number;
}

/**
 * Почему картинку не отправляем. `null` — можно.
 *
 * Отказы намеренно делят случаи: «это не картинка» (текст читай `read_file`),
 * «формат не тот» (SVG — это текст) и «файл велик» (человек может уменьшить).
 */
export function imageRefusal(mime: string | null, bytes: number): string | null {
  if (!mime) {
    return 'Это не изображение: read_image работает с PNG, JPEG, WebP и GIF. Текст читай read_file.';
  }
  if (mime === 'image/svg+xml') {
    return 'SVG — это текст: картинкой модель его не увидит. Читай SVG через read_file — там вся разметка и цвета.';
  }
  if (!SENDABLE_MIME.has(mime)) {
    return `${imageMimeLabel(mime)} провайдеры картинкой не принимают. Пересохрани в PNG или JPEG — тогда read_image сработает.`;
  }
  if (bytes > MAX_READ_IMAGE_BYTES) {
    return `${imageMimeLabel(mime)} ${formatBytes(bytes)} — больше предела ${formatBytes(MAX_READ_IMAGE_BYTES)}. Попроси человека уменьшить картинку или пересохранить её.`;
  }
  return null;
}

/** Отправлять ли картинку как есть: формат понятен модели, размеры и вес в норме. */
export function imageFitsAsIs(size: ImageSize): boolean {
  return size.bytes <= READ_IMAGE_TARGET_BYTES && Math.max(size.width, size.height) <= READ_IMAGE_MAX_SIDE;
}

/**
 * План уменьшения: пустой список — картинка уже подходит.
 *
 * Ступени идут от безопасной к дешёвой: сперва PNG в нужном размере (не теряет
 * прозрачность), затем JPEG (для фотографий он в разы мельче), затем тот же JPEG
 * мельче по стороне — если кадр шумный и первые две не уложились в предел.
 */
export function shrinkSteps(size: ImageSize): readonly ShrinkStep[] {
  if (imageFitsAsIs(size)) return [];
  return [
    { maxSide: READ_IMAGE_MAX_SIDE, format: 'png' },
    { maxSide: READ_IMAGE_MAX_SIDE, format: 'jpeg', quality: 82 },
    { maxSide: Math.round(READ_IMAGE_MAX_SIDE * 0.7), format: 'jpeg', quality: 72 },
  ];
}

/** Размеры после уменьшения длинной стороны; меньшую не растягиваем. */
export function fitInto(size: { width: number; height: number }, maxSide: number): { width: number; height: number } {
  const longest = Math.max(size.width, size.height);
  if (longest <= 0 || longest <= maxSide) return { width: size.width, height: size.height };
  const scale = maxSide / longest;
  // Хотя бы один пиксель: нулевая сторона — это картинка, которую нельзя отправить.
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** Исходник до уменьшения: тип, размеры и вес файла на диске. */
export interface ImageSource extends ImageSize {
  mime: string;
}

/** Что за картинка ушла модели: тип, размеры в пикселях и вес. */
export interface ReadImageReport extends ImageSize {
  /** Тип содержимого после уменьшения: он и уходит провайдеру. */
  mime: string;
  /** Исходник, когда пришлось уменьшать; `null` — отправлен файл как есть. */
  source: ImageSource | null;
}

/** Размеры и вес одной строкой: «PNG 1200×800 · 240 КБ». */
function describeImage(mime: string, size: ImageSize): string {
  const pixels = size.width > 0 && size.height > 0 ? ` ${size.width}×${size.height}` : '';
  return `${imageMimeLabel(mime)}${pixels} · ${formatBytes(size.bytes)}`;
}

/** Подпись для карточки вызова: человек видит, что именно смотрел агент. */
export function formatReadImageSummary(report: ReadImageReport): string {
  const shrunk = report.source ? ' (уменьшено)' : '';
  return `${describeImage(report.mime, report)}${shrunk}`;
}

/**
 * Ответ инструмента модели.
 *
 * Модель должна понимать две вещи: картинка придёт СЛЕДУЮЩИМ сообщением (в
 * результате вызова её нет — туда её не положить) и что именно она увидит
 * (уменьшенную копию или файл как есть).
 */
export function formatReadImageReply(name: string, report: ReadImageReport): string {
  const lines = [`${name}: ${describeImage(report.mime, report)}.`];
  if (report.source) {
    lines.push(
      `Отправлена уменьшенная копия: исходник — ${describeImage(report.source.mime, report.source)}. ` +
        'Если нужную деталь не разобрать, скажи, что именно рассмотреть, — попросим у человека исходник.',
    );
  }
  if (report.mime === 'image/gif') {
    lines.push('У GIF виден только один кадр: анимацию модель не увидит.');
  }
  lines.push('Изображение отправлено следующим сообщением — рассмотри его и отвечай по нему.');
  return lines.join('\n');
}
