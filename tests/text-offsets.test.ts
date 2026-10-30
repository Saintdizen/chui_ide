import { describe, expect, it } from 'vitest';
import { offsetsAt } from '../src/shared/text-offsets';

describe('offsetsAt: места от сервера → смещения в тексте', () => {
  const text = 'one\ntwo\nthree';

  it('строка и столбец с единицы превращаются в смещение', () => {
    // `two` — второя строка, символы 1..4: смещение 4 — 5.
    expect(offsetsAt(text, [{ line: 2, column: 1, endColumn: 4 }])).toEqual([{ start: 4, end: 7 }]);
  });

  it('несколько мест на одной и разных строках', () => {
    const ranges = offsetsAt(text, [
      { line: 1, column: 1, endColumn: 4 },
      { line: 3, column: 1, endColumn: 6 },
    ]);
    expect(ranges).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 13 },
    ]);
  });

  it('строку за концом документа отбрасывает: там нечего подсвечивать', () => {
    // Ответ сервера и наш текст расходятся, если файл только что правили: такой
    // диапазон указывает в пустоту. Молча пропустить честнее, чем нарисовать
    // подсветку не там.
    expect(offsetsAt('abc', [{ line: 99, column: 1, endColumn: 2 }])).toEqual([]);
  });

  it('колонку за концом строки прижимает к её концу', () => {
    // А вот внутри существующей строки — прижимаем: это обычно устаревший на
    // пару символов ответ, и лучше подсветить, чем потерять совсем.
    expect(offsetsAt('ab\ncd', [{ line: 1, column: 1, endColumn: 99 }])).toEqual([{ start: 0, end: 2 }]);
  });

  it('пустой список даёт пустой результат', () => {
    expect(offsetsAt(text, [])).toEqual([]);
  });
});
