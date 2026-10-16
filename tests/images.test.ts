import { describe, expect, it } from 'vitest';
import {
  IMAGE_MIME_BY_EXTENSION,
  MAX_VIEW_IMAGE_BYTES,
  canRenderImageMime,
  imageExtension,
  imageFormatLabel,
  imageMimeType,
  isImagePath,
} from '../src/shared/images';

describe('imageExtension', () => {
  it('расширение из пути и в нижнем регистре', () => {
    expect(imageExtension('/home/u/Pictures/Hero.PNG')).toBe('png');
    expect(imageExtension('logo.svg')).toBe('svg');
  });

  it('без расширения — пустая строка', () => {
    expect(imageExtension('Makefile')).toBe('');
    expect(imageExtension('dir/')).toBe('');
  });
});

describe('imageMimeType', () => {
  it('распространённые форматы', () => {
    expect(imageMimeType('logo.png')).toBe('image/png');
    expect(imageMimeType('photo.JPG')).toBe('image/jpeg');
    expect(imageMimeType('shot.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('icon.svg')).toBe('image/svg+xml');
    expect(imageMimeType('anim.webp')).toBe('image/webp');
    expect(imageMimeType('mark.ico')).toBe('image/x-icon');
  });

  it('расширение ищется и в пути с папками', () => {
    expect(imageMimeType('/home/u/a/b/pic.avif')).toBe('image/avif');
  });

  it('дополнительные форматы', () => {
    // JFIF — тот же JPEG, APNG — тот же PNG: отдельные расширения, общий тип.
    expect(imageMimeType('photo.jfif')).toBe('image/jpeg');
    expect(imageMimeType('anim.apng')).toBe('image/png');
    // HEIC/HEIF приходят с телефонов: это картинки, хотя движок их не рисует.
    expect(imageMimeType('IMG_0001.HEIC')).toBe('image/heic');
    expect(imageMimeType('IMG_0001.heif')).toBe('image/heif');
  });

  it('текстовый файл — не картинка', () => {
    expect(imageMimeType('main.ts')).toBeNull();
    expect(imageMimeType('README')).toBeNull();
    // Похоже на картинку только видом — последнее расширение решает.
    expect(imageMimeType('notes.tiff.bak')).toBeNull();
  });
});

describe('isImagePath', () => {
  it('по расширению, без учёта регистра', () => {
    expect(isImagePath('assets/hero.AVIF')).toBe(true);
    expect(isImagePath('src/index.ts')).toBe(false);
  });

  it('формат без поддержки движка — всё равно картинка, а не текст', () => {
    // TIFF и HEIC не отрисуются, но текстовым редактором бинарь показывать нельзя:
    // вьюер покажет заглушку.
    expect(isImagePath('scan.tiff')).toBe(true);
    expect(isImagePath('IMG_0001.heic')).toBe(true);
  });

  it('файл без расширения — не картинка', () => {
    expect(isImagePath('Makefile')).toBe(false);
  });
});

/**
 * Отделяем «это картинка» от «это движок покажет»: без второго вьюер ловил бы
 * «битую» рамку на TIFF и HEIC. Список отрисовываемых типов — свойство движка,
 * и сторож держит границу, чтобы новый формат не попал туда по недосмотру.
 */
describe('canRenderImageMime', () => {
  const RENDERED = ['png', 'apng', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'];
  const NOT_RENDERED = ['tif', 'tiff', 'heic', 'heif'];

  it('повседневные форматы движок рисует', () => {
    for (const extension of RENDERED) {
      const mime = imageMimeType(`file.${extension}`);
      expect(canRenderImageMime(mime!), extension).toBe(true);
    }
  });

  it('TIFF и HEIC/HEIF — картинки, которые движок не рисует', () => {
    for (const extension of NOT_RENDERED) {
      const mime = imageMimeType(`file.${extension}`);
      expect(canRenderImageMime(mime!), extension).toBe(false);
    }
  });

  it('каждый отрисовываемый тип есть в таблице расширений', () => {
    const known = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));
    for (const extension of RENDERED) {
      const mime = imageMimeType(`file.${extension}`)!;
      expect(known.has(mime), `${extension} → ${mime}`).toBe(true);
    }
  });

  it('незнакомый тип — не отрисовывается', () => {
    expect(canRenderImageMime('image/psd')).toBe(false);
  });
});

describe('imageFormatLabel', () => {
  it('подписи форматов для интерфейса', () => {
    expect(imageFormatLabel('shot.jpg')).toBe('JPEG');
    expect(imageFormatLabel('shot.jfif')).toBe('JPEG');
    expect(imageFormatLabel('scan.tif')).toBe('TIFF');
    expect(imageFormatLabel('anim.apng')).toBe('APNG');
    expect(imageFormatLabel('IMG_0001.heic')).toBe('HEIC');
    expect(imageFormatLabel('logo.svg')).toBe('SVG');
    expect(imageFormatLabel('logo.png')).toBe('PNG');
  });
});

describe('таблица форматов', () => {
  it('каждое значение — тип изображения', () => {
    for (const [extension, mime] of Object.entries(IMAGE_MIME_BY_EXTENSION)) {
      expect(mime.startsWith('image/'), extension).toBe(true);
    }
  });

  it('предел просмотра щедрее, чем предел вложения в чат (5 МБ)', () => {
    expect(MAX_VIEW_IMAGE_BYTES).toBeGreaterThan(5 * 1024 * 1024);
  });
});
