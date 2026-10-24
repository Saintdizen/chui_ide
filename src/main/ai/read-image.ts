import { nativeImage, type NativeImage } from 'electron';
import { formatBytes, imageMimeLabel } from '../../shared/images';
import { imageRefusal, shrinkSteps, fitInto, READ_IMAGE_TARGET_BYTES, type ImageSize } from '../../shared/read-image';
import type { WorkspaceService } from '../workspace/workspace';
import type { ReadImageResult, ReadImageRunner } from './tool-context';

/**
 * `read_image`: файл с диска → картинка для модели.
 *
 * Разбирать и перекодировать картинку умеет только движок (`nativeImage`:
 * PNG и JPEG он декодирует сам), поэтому процесс живёт здесь, а правила — в
 * `shared/read-image.ts`. Проверки путей и потолок «сколько файл вообще можно
 * открыть» — на `WorkspaceService`, как у всего остального чтения.
 *
 * Форматы, которые движок не декодирует (WebP, GIF, BMP, AVIF), отправляем как
 * есть, если они невелики: провайдеры их принимают. Уменьшить такой файл нечем —
 * тогда честный отказ вместо тихой отправки шестимегабайтного снимка.
 */
export function createReadImageRunner(workspace: WorkspaceService): ReadImageRunner {
  return {
    load: (filePath) => loadImageForModel(workspace, filePath),
  };
}

async function loadImageForModel(workspace: WorkspaceService, filePath: string): Promise<ReadImageResult> {
  // Путь проверен рабочим каталогом, тип — по расширению, общий потолок чтения — свой.
  const file = await workspace.readImage(filePath);
  const refusal = imageRefusal(file.mime, file.bytes);
  if (refusal) throw new Error(refusal);

  const buffer = Buffer.from(file.dataUrl.slice(file.dataUrl.indexOf(',') + 1), 'base64');
  const decoded = decode(buffer);
  const size: ImageSize = {
    width: decoded?.getSize().width ?? 0,
    height: decoded?.getSize().height ?? 0,
    bytes: file.bytes,
  };

  if (shrinkSteps(size).length === 0) {
    return { mime: file.mime, dataUrl: file.dataUrl, ...size, source: null };
  }

  if (!decoded) {
    throw new Error(
      `${imageMimeLabel(file.mime)} ${formatBytes(file.bytes)} уменьшить нельзя: этот формат движок не разбирает. ` +
        'Пересохрани файл в PNG или JPEG (или попроси человека это сделать) — тогда read_image сработает.',
    );
  }

  const steps = shrinkSteps(size);
  for (const [index, step] of steps.entries()) {
    const target = fitInto(size, step.maxSide);
    const scaled = decoded.resize({ width: target.width, height: target.height, quality: 'good' });
    const data = step.format === 'jpeg' ? scaled.toJPEG(step.quality ?? 82) : scaled.toPNG();
    const last = index === steps.length - 1;
    if (data.byteLength > READ_IMAGE_TARGET_BYTES && !last) continue;
    const mime = step.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      mime,
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      ...target,
      bytes: data.byteLength,
      source: { mime: file.mime, width: size.width, height: size.height, bytes: file.bytes },
    };
  }

  // Последняя ступень всегда возвращает результат — сюда попасть нельзя.
  throw new Error(`${imageMimeLabel(file.mime)} не удалось уменьшить: попроси человека пересохранить картинку.`);
}

/** Разбор файла движком. Пустое изображение — это «не разобралось», а не «картинка пуста». */
function decode(buffer: Buffer): NativeImage | null {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}
