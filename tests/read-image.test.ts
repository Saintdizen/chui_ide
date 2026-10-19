import { describe, expect, it } from 'vitest';
import {
  MAX_READ_IMAGE_BYTES,
  READ_IMAGE_MAX_SIDE,
  READ_IMAGE_TARGET_BYTES,
  fitInto,
  formatReadImageReply,
  formatReadImageSummary,
  imageFitsAsIs,
  imageRefusal,
  shrinkSteps,
  type ReadImageReport,
} from '../src/shared/read-image';
import { AGENT_TOOLS } from '../src/shared/tools';

describe('imageRefusal', () => {
  it('не картинка — отказ с подсказкой про read_file', () => {
    const reason = imageRefusal(null, 1024);
    expect(reason).toContain('не изображение');
    expect(reason).toContain('read_file');
  });

  it('SVG — это текст, а не картинка для модели', () => {
    expect(imageRefusal('image/svg+xml', 2048)).toContain('SVG — это текст');
  });

  it('форматы, которых провайдер не принимает', () => {
    // TIFF движок рисует, но картинкой модели он не уходит: пересохранить.
    expect(imageRefusal('image/tiff', 2048)).toContain('не принимают');
    expect(imageRefusal('image/heic', 2048)).toContain('PNG или JPEG');
  });

  it('принимаемые форматы проходят, пока файл невелик', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(imageRefusal(mime, 1024)).toBeNull();
    }
  });

  it('файл больше предела — отказ с числами', () => {
    const reason = imageRefusal('image/png', MAX_READ_IMAGE_BYTES + 1);
    expect(reason).toContain('больше предела');
    expect(reason).toContain('12.0 МБ');
  });
});

describe('imageFitsAsIs / shrinkSteps', () => {
  it('небольшая картинка отправляется как есть', () => {
    const size = { width: 800, height: 600, bytes: 200_000 };
    expect(imageFitsAsIs(size)).toBe(true);
    expect(shrinkSteps(size)).toEqual([]);
  });

  it('длинная сторона сверх предела — уменьшать', () => {
    expect(shrinkSteps({ width: 4000, height: 100, bytes: 100_000 }).length).toBeGreaterThan(0);
  });

  it('тяжёлый кадр в пределах стороны — тоже уменьшать', () => {
    expect(shrinkSteps({ width: 1200, height: 900, bytes: READ_IMAGE_TARGET_BYTES + 1 }).length).toBeGreaterThan(0);
  });

  it('ступени идут от безопасного к дешёвому', () => {
    const steps = shrinkSteps({ width: 4000, height: 3000, bytes: 6_000_000 });
    // Первая — PNG в нужном размере: прозрачность не теряется.
    expect(steps[0]).toEqual({ maxSide: READ_IMAGE_MAX_SIDE, format: 'png' });
    // Последняя — мельче по стороне, чтобы шумный кадр всё-таки уложился.
    expect(steps[steps.length - 1]!.maxSide).toBeLessThan(READ_IMAGE_MAX_SIDE);
    expect(steps[steps.length - 1]!.format).toBe('jpeg');
  });

  it('неизвестные размеры не мешают решить по весу', () => {
    expect(shrinkSteps({ width: 0, height: 0, bytes: 1000 })).toEqual([]);
    expect(shrinkSteps({ width: 0, height: 0, bytes: READ_IMAGE_TARGET_BYTES + 1 }).length).toBeGreaterThan(0);
  });
});

describe('fitInto', () => {
  it('уменьшает по длинной стороне, сохраняя пропорции', () => {
    expect(fitInto({ width: 4000, height: 2000 }, 1000)).toEqual({ width: 1000, height: 500 });
    expect(fitInto({ width: 2000, height: 4000 }, 1000)).toEqual({ width: 500, height: 1000 });
  });

  it('меньшую не растягивает', () => {
    expect(fitInto({ width: 800, height: 600 }, 1568)).toEqual({ width: 800, height: 600 });
  });

  it('совсем тонкая сторона даёт хотя бы пиксель', () => {
    expect(fitInto({ width: 10000, height: 3 }, 10)).toEqual({ width: 10, height: 1 });
  });
});

describe('formatReadImageSummary / formatReadImageReply', () => {
  const plain: ReadImageReport = {
    mime: 'image/png',
    width: 1200,
    height: 800,
    bytes: 240_000,
    source: null,
  };

  it('сводка называет формат, размеры и вес', () => {
    expect(formatReadImageSummary(plain)).toBe('PNG 1200×800 · 234 КБ');
  });

  it('уменьшенная копия видна в сводке и в ответе', () => {
    const shrunk: ReadImageReport = {
      mime: 'image/jpeg',
      width: 1568,
      height: 1019,
      bytes: 420_000,
      source: { mime: 'image/png', width: 4000, height: 2600, bytes: 6_000_000 },
    };
    expect(formatReadImageSummary(shrunk)).toContain('уменьшено');
    const reply = formatReadImageReply('mockups/hero.png', shrunk);
    expect(reply).toContain('mockups/hero.png');
    expect(reply).toContain('JPEG 1568×1019');
    expect(reply).toContain('исходник — PNG 4000×2600');
    expect(reply).toContain('следующим сообщением');
  });

  it('размеры, которые определить не удалось, просто не называются', () => {
    const unknown: ReadImageReport = { mime: 'image/webp', width: 0, height: 0, bytes: 3000, source: null };
    expect(formatReadImageSummary(unknown)).toBe('WebP · 3 КБ');
  });

  it('про GIF сказано, что виден один кадр', () => {
    const gif: ReadImageReport = { mime: 'image/gif', width: 300, height: 200, bytes: 4000, source: null };
    expect(formatReadImageReply('anim.gif', gif)).toContain('один кадр');
  });
});

describe('схема инструмента read_image', () => {
  const tool = AGENT_TOOLS.find((item) => item.name === 'read_image');

  it('объявлен и требует путь', () => {
    expect(tool).toBeDefined();
    expect(tool!.side).toBe('main');
    expect(tool!.inputSchema.required).toEqual(['path']);
    expect(tool!.inputSchema.properties.path?.type).toBe('string');
  });

  it('описание объясняет, чем он отличается от read_file', () => {
    expect(tool!.description).toContain('read_file');
  });
});
