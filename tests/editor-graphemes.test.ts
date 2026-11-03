describe('двунаправленный текст (RTL)', () => {
  /**
   * Найдено разбором: `bidi` в src/ не упоминался НИ РАЗУ. Само по себе это не
   * беда — раскладку делает браузер, — но проверить было надо: каретка ходит
   * по графемам, и если RTL-знак с огласовкой порвётся пополам, стрелка будет
   * бегать по его частям, а не по буквам.
   */
  it('арабская буква с огласовкой — один знак', () => {
    // «مَرْحَبًا» — пять букв, у каждой своя харака сверху. Пять графем, не десять.
    expect(graphemeBoundaries('مَرْحَبًا')).toHaveLength(6);
  });

  it('иврит с никудом — тоже один знак на букву', () => {
    // «שָׁלוֹם» — четыре буквы, четыре графемы.
    expect(graphemeBoundaries('שָׁלוֹם')).toHaveLength(5);
  });

  it('арабская буква в латинской строке не ломает соседей', () => {
    // Смешанная строка: латиница, затем арабское слово, затем пунктуация.
    // Границы остаются по знакам — столбцы считает `layoutLine`, а она идёт
    // по этим же границам.
    const text = 'const x = "مرحبا";';
    expect(graphemeBoundaries(text)).toHaveLength([...text].length + 1);
  });

  it('арабская буква с харакой находится как одна', () => {
    // Каретка в середине графемы встаёт на её начало, а не между буквой и знаком.
    expect(graphemeAt('مَرْحَبًا', 1)).toEqual({ start: 0, end: 2 });
  });
});
import { describe, expect, it, vi } from 'vitest';
import {
  graphemeAt,
  graphemeBoundaries,
  hasSegmentation,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  wordAt,
  wordSegments,
} from '../src/renderer/editor/core/graphemes';

const segmentation = hasSegmentation();

describe('Graphemes', () => {
  it('обычные символы — по одному на букву', () => {
    expect(graphemeBoundaries('abc')).toEqual([0, 1, 2, 3]);
    expect(previousGraphemeBoundary('abc', 2)).toBe(1);
    expect(nextGraphemeBoundary('abc', 2)).toBe(3);
  });

  it('суррогатная пара — один символ, а не два', () => {
    // «😀» — две единицы UTF-16.
    expect('😀'.length).toBe(2);
    expect(graphemeBoundaries('a😀b')).toEqual([0, 1, 3, 4]);
    expect(graphemeAt('a😀b', 1)).toEqual({ start: 1, end: 3 });
    expect(nextGraphemeBoundary('a😀b', 1)).toBe(3);
    expect(previousGraphemeBoundary('a😀b', 3)).toBe(1);
  });

  it.runIf(segmentation)('составной эмодзи с соединителями — один символ', () => {
    const family = '👨\u200d👩\u200d👧';
    expect(family.length).toBeGreaterThan(2);
    expect(graphemeBoundaries(`x${family}y`)).toEqual([0, 1, 1 + family.length, 2 + family.length]);
    expect(nextGraphemeBoundary(`x${family}y`, 1)).toBe(1 + family.length);
  });

  it.runIf(segmentation)('буква с комбинирующим знаком — один символ', () => {
    const composed = 'e\u0301';
    expect(composed.length).toBe(2);
    expect(graphemeBoundaries(composed)).toEqual([0, 2]);
    expect(previousGraphemeBoundary(composed, 2)).toBe(0);
  });

  it.runIf(segmentation)('флаг страны — один символ', () => {
    const flag = '🇷🇺';
    expect(flag.length).toBe(4);
    expect(graphemeBoundaries(flag)).toEqual([0, 4]);
  });

  it.runIf(segmentation)('эмодзи с тоном кожи — один символ', () => {
    const thumb = '👍🏽';
    expect(graphemeBoundaries(`a${thumb}`)).toEqual([0, 1, 1 + thumb.length]);
  });

  it('границы на концах текста не выходят за пределы', () => {
    expect(previousGraphemeBoundary('abc', 0)).toBe(0);
    expect(nextGraphemeBoundary('abc', 3)).toBe(3);
    expect(previousGraphemeBoundary('', 0)).toBe(0);
    expect(nextGraphemeBoundary('', 0)).toBe(0);
    // Смещение за пределами текста прижимается к концу.
    expect(nextGraphemeBoundary('abc', 99)).toBe(3);
  });

  it('слова и промежутки между ними', () => {
    const segments = wordSegments('привет, мир test2');
    const words = segments.filter((part) => part.isWordLike).map((part) => part.start);
    expect(words).toEqual([0, 8, 12]);
    expect(segments[0]).toMatchObject({ start: 0, end: 6, isWordLike: true });
  });

  it('слово под курсором и вне слова', () => {
    const text = 'hello world';
    expect(wordAt(text, 1)).toMatchObject({ start: 0, end: 5 });
    expect(wordAt(text, 7)).toMatchObject({ start: 6, end: 11 });
    // Пробел — не слово.
    expect(wordAt(text, 5)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });

  it.runIf(segmentation)('кириллица распознаётся словом', () => {
    expect(wordAt('функция вызова', 2)).toMatchObject({ start: 0, end: 7 });
  });

  /**
   * Составные знаки. Здесь ошибка стоит дорого: если разрезать кластер посередине,
   * Delete съест половину символа, и текст редактор потеряет.
   */
  it.runIf(segmentation)('буква с ударением — один кластер, а не два', () => {
    // «й» как «и» + комбинируемая бревис: два кодовых пункта, один видимый знак.
    const text = 'и\u0306';

    expect(graphemeBoundaries(text)).toEqual([0, 2]);
    expect(graphemeAt(text, 1)).toEqual({ start: 0, end: 2 });
    expect(nextGraphemeBoundary(text, 0)).toBe(2);
    expect(previousGraphemeBoundary(text, 2)).toBe(0);
  });

  it.runIf(segmentation)('эмодзи с модификатором тона — один кластер', () => {
    const text = '👍\u{1F3FD}';

    expect(graphemeBoundaries(text)).toEqual([0, text.length]);
  });

  it.runIf(segmentation)('семейство эмодзи со склейкой — один кластер', () => {
    // Семья собирается из нескольких эмодзи, соединённых ZWJ: для человека это
    // один знак, и разрезать его нельзя.
    const text = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

    expect(graphemeBoundaries(text)).toEqual([0, text.length]);
  });

  it.runIf(segmentation)('флаг из двух региональных знаков — один кластер', () => {
    const text = '\u{1F1F7}\u{1F1FA}';

    expect(graphemeBoundaries(text)).toEqual([0, text.length]);
  });

  it.runIf(segmentation)('границы идут по возрастанию и заканчиваются длиной', () => {
    // На этом свойстве держатся и каретка, и выделение: по ним считается шаг.
    const boundaries = graphemeBoundaries('a\u0301bc👍\u{1F3FD}');

    for (let index = 1; index < boundaries.length; index += 1) {
      expect(boundaries[index]!).toBeGreaterThan(boundaries[index - 1]!);
    }
    expect(boundaries.at(-1)).toBe('a\u0301bc👍\u{1F3FD}'.length);
    expect(boundaries[0]).toBe(0);
  });

  it('пустой текст даёт единственную границу', () => {
    // Нулевая длина — не ошибка: каретке нужно хотя бы одно место.
    expect(graphemeBoundaries('')).toEqual([0]);
  });

  it('смещение за концом текста не выходит за пределы', () => {
    const text = 'abc';

    expect(nextGraphemeBoundary(text, 99)).toBe(text.length);
    // Уход влево с конца встаёт на НАЧАЛО последнего знака, а не на конец текста:
    // Backspace удаляет знак, а не переносит каретку в никуда.
    expect(previousGraphemeBoundary(text, 99)).toBe(text.length - 1);
    expect(previousGraphemeBoundary(text, -5)).toBe(0);
  });

  /**
   * Запасное разбиение, когда платформенного `Intl.Segmenter` нет (старый движок).
   * Проверяется отдельным модулем с подменой глобального `Intl`: иначе эти строки
   * не исполнились бы ни разу, а именно они спасают редактор на старых движках.
   */
  it('без Intl.Segmenter слова режутся запасным разбиением', async () => {
    const saved = (globalThis as { Intl?: unknown }).Intl;
    (globalThis as { Intl?: unknown }).Intl = { Segmenter: undefined };
    try {
      // Отдельная копия модуля: у обычной уже вычислен движок сегментации.
      // Свежая копия модуля: у обычной движок сегментации уже вычислен при импорте.
      vi.resetModules();
      const fresh = await import('../src/renderer/editor/core/graphemes');
      const segments = fresh.wordSegments('const value = 42 /* x */');

      expect(
        segments
          .filter((item) => item.isWordLike)
          .map((item) => 'const value = 42 /* x */'.slice(item.start, item.end)),
      ).toEqual(['const', 'value', '42', 'x']);
      // Подчёркивание — часть слова: `user_name` не должен резаться на два.
      expect(fresh.wordAt('user_name', 2)).toMatchObject({ start: 0, end: 9 });
    } finally {
      (globalThis as { Intl?: unknown }).Intl = saved;
    }
  });

  it('без Intl.Segmenter знаки режутся по кодовым точкам', async () => {
    const saved = (globalThis as { Intl?: unknown }).Intl;
    (globalThis as { Intl?: unknown }).Intl = { Segmenter: undefined };
    try {
      vi.resetModules();
      const fresh = await import('../src/renderer/editor/core/graphemes');

      // Суррогатная пара остаётся одним знаком и в запасном разбиении.
      expect(fresh.graphemeBoundaries('a👍b')).toEqual([0, 1, 3, 4]);
      expect(fresh.graphemeAt('a👍b', 2)).toEqual({ start: 1, end: 3 });
    } finally {
      (globalThis as { Intl?: unknown }).Intl = saved;
    }
  });
});
