import { describe, expect, it } from 'vitest';
import { LARGE_FILE_BYTES, MAX_OPEN_BYTES, isReadOnlySize, withinOpenLimit } from '../src/shared/large-file';

/**
 * Размер решает, как редактор обойдётся с файлом: до порога — обычная правка, выше —
 * открытие только для чтения, за жёстким пределом — отказ. Проверяем обе границы и
 * то, что пороги не перепутаны местами.
 */
describe('isReadOnlySize', () => {
  it('файл у самого порога ещё правится', () => {
    expect(isReadOnlySize(LARGE_FILE_BYTES)).toBe(false);
  });

  it('выше порога — только чтение', () => {
    expect(isReadOnlySize(LARGE_FILE_BYTES + 1)).toBe(true);
  });

  it('маленький файл правится', () => {
    expect(isReadOnlySize(0)).toBe(false);
    expect(isReadOnlySize(1024)).toBe(false);
  });
});

describe('withinOpenLimit', () => {
  it('у жёсткого предела файл ещё открываем', () => {
    expect(withinOpenLimit(MAX_OPEN_BYTES)).toBe(true);
  });

  it('выше жёсткого предела — не берём', () => {
    expect(withinOpenLimit(MAX_OPEN_BYTES + 1)).toBe(false);
  });

  it('порог «только чтение» ниже жёсткого предела', () => {
    expect(LARGE_FILE_BYTES).toBeLessThan(MAX_OPEN_BYTES);
  });
});
