import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_CHAT_IMAGES, MAX_IMAGE_BYTES, RpcErrorCode, type PickedImage } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * Картинки в чате: чтение, проверки и пределы.
 *
 * Файлы читает main — renderer файловой системы не видит. Отдаём сразу data-URL:
 * в таком виде картинку понимает и `<img>` в интерфейсе, и OpenAI-совместимый API,
 * поэтому вложение не приходится преобразовывать дважды.
 *
 * Пределы нужны по делу: одна фотография с телефона — это несколько мегабайт
 * base64 в каждом запросе, а история беседы пересылается целиком.
 */

/** Расширения, которые предлагает системный диалог. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Прочитать файл как data-URL. Проверяет и тип, и размер — иначе отказывает. */
export async function readImageAsDataUrl(filePath: string): Promise<PickedImage> {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `Не изображение: ${path.basename(filePath)}`);
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new RpcFailure(RpcErrorCode.NotFound, `Файл не найден: ${filePath}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      `${path.basename(filePath)}: ${formatBytes(stat.size)} — больше предела ${formatBytes(MAX_IMAGE_BYTES)}`,
    );
  }

  const data = await fs.readFile(filePath);
  return {
    name: path.basename(filePath),
    mime,
    bytes: data.byteLength,
    dataUrl: `data:${mime};base64,${data.toString('base64')}`,
  };
}

/**
 * Проверить картинки, пришедшие из renderer вместе с вопросом.
 *
 * Renderer — не источник истины: данные вложения собирает он (вставка из буфера
 * и перетаскивание файла не проходят через main), поэтому пределы проверяются
 * здесь, а не только в интерфейсе.
 */
export function assertChatImages(images: readonly string[]): void {
  if (images.length > MAX_CHAT_IMAGES) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      `К вопросу можно приложить не больше ${MAX_CHAT_IMAGES} изображений`,
    );
  }

  for (const image of images) {
    if (!image.startsWith('data:image/')) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, 'Вложение изображения повреждено: ожидается data:image/…');
    }
    // Ограничение на длину строки, а не на декодированные байты: base64 длиннее
    // исходника примерно на треть, и точное значение здесь не нужно — нужен предел.
    if (image.length > MAX_IMAGE_BYTES * 1.4) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Изображение больше предела ${formatBytes(MAX_IMAGE_BYTES)}`);
    }
  }
}

/** Размер по-человечески: «2.4 МБ» вместо «2516582». */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
