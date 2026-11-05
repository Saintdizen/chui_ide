import { describe, expect, it } from 'vitest';
import {
  LARGE_FILE_BYTES,
  MAX_OPEN_BYTES,
  MAX_WRAP_LINE_CHARS,
  MAX_WRAP_LINES,
  isReadOnlySize,
  withinOpenLimit,
  wrapsByLineCount,
  wrapsByLineLength,
} from '../src/shared/large-file';

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

describe('wrapsByLineCount', () => {
  /**
   * Найдено разбором: при включённом переносе `ensureRows` раскладывал на знаки
   * КАЖДУЮ строку файла — массив на каждый знак, и все разом. На ста тысячах
   * строк это миллионы чисел и пауза до первого кадра: окно замирает.
   */
  it('до порога перенос разрешён', () => {
    expect(wrapsByLineCount(MAX_WRAP_LINES)).toBe(true);
  });

  it('на строку сверх порога — уже нет', () => {
    expect(wrapsByLineCount(MAX_WRAP_LINES + 1)).toBe(false);
  });

  it('очень длинный файл — тем более нет', () => {
    expect(wrapsByLineCount(1_000_000)).toBe(false);
  });

  it('пустой и короткий файл — разрешён', () => {
    expect(wrapsByLineCount(0)).toBe(true);
    expect(wrapsByLineCount(1)).toBe(true);
  });

  it('порог по строкам ниже жёсткого предела по байтам', () => {
    // Иначе файл, который ещё можно открыть, открывался бы с рывком: порог
    // переноса обязан срабатывать раньше, чем файл перестанут брать вовсе.
    expect(MAX_WRAP_LINES).toBeLessThan(MAX_OPEN_BYTES);
  });
});

describe('порог по длине строки', () => {
  it('обычная строка переносится', () => {
    expect(wrapsByLineLength(0)).toBe(true);
    expect(wrapsByLineLength(200)).toBe(true);
    expect(wrapsByLineLength(MAX_WRAP_LINE_CHARS)).toBe(true);
  });

  it('миллион знаков в одной строке — не переносим', () => {
    // Минифицированный JSON, base64, дамп в одну строку. Раскладка такой строки —
    // массив на каждый знак и десятки тысяч рядов: ни прокрутить, ни запомнить.
    expect(wrapsByLineLength(MAX_WRAP_LINE_CHARS + 1)).toBe(false);
    expect(wrapsByLineLength(1_000_000)).toBe(false);
  });

  it('порог ниже, чем файл вообще разрешено открыть', () => {
    // Строка не может быть длиннее файла: если файл открывают, порог обязан сработать.
    expect(MAX_WRAP_LINE_CHARS).toBeLessThan(MAX_OPEN_BYTES);
  });
});
