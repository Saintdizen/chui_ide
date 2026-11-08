import { describe, expect, it } from 'vitest';
import { changeRuns, changedLines, createChangedLinesCache } from '../src/shared/changed-lines';

/**
 * Строки с несохранёнными правками для тепловой карты мини-карты. Это не
 * точный diff: нужно «где есть правка», и быстро — считается на каждый символ.
 */
describe('changedLines', () => {
  it('без изменений — пусто', () => {
    expect(changedLines('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('правка в одной строке', () => {
    expect(changedLines('a\nb\nc', 'a\nB\nc')).toEqual([2]);
  });

  it('вставка не метит всё после неё', () => {
    // Без среза общего суффикса вставка в одну строку сдвинула бы все номера
    // и карта стала бы сплошной — правда, но бесполезная.
    const saved = 'a\nb\nc\nd';
    expect(changedLines(saved, 'a\nb\nNEW\nc\nd')).toEqual([3]);
  });

  it('удаление строки в конце', () => {
    expect(changedLines('a\nb\nc', 'a\nb')).toEqual([]);
  });

  it('правки по краям: середина помечена тоже — и это честно', () => {
    // Срез только по общим краям: между правками строки могли сдвинуться, и
    // обещать «b и c не тронуты» без полного diff значило бы соврать. На карте
    // это пятно той же ширины, что и сама правка, — цена мала.
    expect(changedLines('a\nb\nc\nd', 'A\nb\nc\nD')).toEqual([1, 2, 3, 4]);
  });

  it('пустой файл стал непустым', () => {
    expect(changedLines('', 'a\nb')).toEqual([1, 2]);
  });
});

describe('changeRuns', () => {
  it('соседние строки сливаются в полосу', () => {
    expect(changeRuns([1, 2, 3, 7])).toEqual([
      { from: 1, to: 3 },
      { from: 7, to: 7 },
    ]);
  });

  it('пусто — пусто', () => {
    expect(changeRuns([])).toEqual([]);
  });
});

describe('createChangedLinesCache', () => {
  it('та же версия — тот же ответ без пересчёта', () => {
    const cache = createChangedLinesCache();
    const saved = 'a\nb';
    const first = cache.lines('a\nB', saved, 2);
    const second = cache.lines('a\nB', saved, 2);
    expect(second).toBe(first);
  });

  it('новая версия — новый список', () => {
    const cache = createChangedLinesCache();
    const saved = 'a\nb';
    cache.lines('a\nB', saved, 2);
    expect(cache.lines('a\nC', saved, 3)).toEqual([2]);
  });
});
