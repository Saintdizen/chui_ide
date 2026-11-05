// biome-ignore-all lint/suspicious/noExplicitAny: узлы мини-DOM приходят из
// заглушки DOM — тип у них шире настоящего намеренно, вне этого файла не нужен.
import { beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '../src/renderer/editor/view/editor-view';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { layoutLine } from '../src/renderer/editor/view/line-layout';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Отрисовка редактора (`editor/view/editor-view.ts`).
 *
 * Файл в 2.1k строк был покрыт на 39%: арифметика окна проверена в `viewport.ts`, а
 * сам вид — нет. Вид строит DOM (слои строк, номеров, кареток), поэтому тест
 * смотрит на узлы и их стили, а не на холст.
 *
 * Метрики шрифта передаются явно: вид не меряет шрифт сам, так что тест не зависит
 * от того, какие шрифты есть в системе.
 */

/**
 * Метрики задаются параметром: вид не меряет шрифт сам, поэтому тест не зависит от
 * доступных в системе шрифтов и от настоящего холста.
 */
const METRICS = {
  charWidth: 8,
  lineHeight: 20,
  tabSize: 4,
  // `widthOf` отдаёт ПИКСЕЛИ (ширину знака), а не число клеток: так его считает
  // `GlyphMetrics`. Раньше здесь стояло «1/2», и строка из 400 знаков выходила
  // шириной 400 px — перенос не срабатывал вовсе, хотя выглядел рабочим.
  widthOf: (codePoint: number) => (codePoint > 0x2e80 ? 16 : 8),
};

function makeView(text: string, options: { gutter?: boolean } = {}) {
  const host = document.createElement('div') as unknown as HTMLElement;
  const buffer = new TextBuffer(text);
  const view = new EditorView(host, buffer, { metrics: METRICS, gutter: options.gutter ?? true });
  const root = (host as unknown as { querySelector(s: string): any }).querySelector('.own-editor');
  const lines = () => root.querySelectorAll('.own-editor-line') as unknown as HTMLElement[];
  return { view, buffer, host, root, lines };
}

describe('отрисовка редактора', () => {
  describe('свёртка: уровень и возврат на вкладку', () => {
    /**
     * Найдено разбором: `collapseToLevel` и `restoreCollapsed` в модели были
     * написаны и не вызывались НИОТКУДА — мёртвый код. «Свернуть уровень N» не
     * существовало, а свёрнутое не переживало возврат на вкладку.
     */
    const ranges = [
      { startLine: 0, endLine: 5 },
      { startLine: 1, endLine: 3 },
    ];

    it('свернуть до уровня 1 — складывает внешний блок', () => {
      const { view } = makeView('a\nb\nc\nd\ne\nf');
      view.setFoldRanges(ranges);
      view.foldToLevel(1);
      expect(view.collapsedFolds()).toEqual([0]);
    });

    it('свёрнутое состояние читается и возвращается', () => {
      // Ровно то, что делает хозяин: запомнил при уходе, применил при возврате.
      const { view } = makeView('a\nb\nc\nd\ne\nf');
      view.setFoldRanges(ranges);
      view.foldAll();
      const saved = view.collapsedFolds();
      view.unfoldAll();
      expect(view.collapsedFolds()).toEqual([]);
      view.restoreCollapsedFolds(saved);
      expect(view.collapsedFolds()).toEqual([0, 1]);
    });

    it('возврат без диапазонов ничего не воскрешает', () => {
      // Порядок и был причиной, почему восстановление было пустым: до
      // `setFoldRanges` модель не знает блоков.
      const { view } = makeView('a\nb\nc\nd\ne\nf');
      view.restoreCollapsedFolds([0, 1]);
      expect(view.collapsedFolds()).toEqual([]);
    });
  });

  describe('перенос строк в большом файле', () => {
    /**
     * Найдено разбором: при включённом переносе `ensureRows` раскладывает на знаки
     * КАЖДУЮ строку файла — массив на каждый знак, и все разом. На ста тысячах
     * строк это миллионы чисел и пауза до первого кадра: окно замирает на открытии.
     * Выше порога (`MAX_WRAP_LINES`) перенос выключается сам.
     */
    it('маленький файл получает перенос', () => {
      const { view } = makeView('aaa\nbbb');
      view.setWordWrap(true);
      expect(view.wordWrap).toBe(true);
    });

    it('большой файл переноса не получает, даже если его включили', () => {
      const { view } = makeView('a\n'.repeat(50_001));
      view.setWordWrap(true);
      expect(view.wordWrap).toBe(false);
    });

    it('открыли большой файл — включённый перенос не раскладывает его', () => {
      // Переключение вкладки идёт через setBuffer, и там же решается перенос:
      // иначе настройка, включённая на маленьком файле, повесила бы окно на большом.
      const { view, buffer } = makeView('aaa\nbbb');
      view.setWordWrap(true);
      expect(view.wordWrap).toBe(true);
      buffer.replace(0, buffer.length, 'a\n'.repeat(50_001));
      view.setBuffer(buffer);
      expect(view.wordWrap).toBe(false);
    });

    it('вернулись на маленький файл — перенос снова работает', () => {
      // Намерение человека не стёрто: оно живёт в wrapWanted.
      const { view } = makeView('a\n'.repeat(50_001));
      view.setWordWrap(true);
      expect(view.wordWrap).toBe(false);
      const small = new TextBuffer('aaa\nbbb');
      view.setBuffer(small);
      expect(view.wordWrap).toBe(true);
    });
  });

  beforeEach(() => {
    installMiniDom();
  });

  describe('мягкая линейка переноса', () => {
    /**
     * TASKS 49. Перенос строк был и разрезал длинную строку на ряды, но продолжение
     * было не отличить от новой строки того же блока. Теперь у рядов-продолжений есть
     * «мягкая» линейка, а направляющие отступов на них не повторяются.
     *
     * Метрики в тесте: знак 8 px, поле прокрутки в мини-DOM — 800 px (`clientWidth`),
     * значит при отступе 4 линейка встаёт на 32 px.
     */
    const LONG = `    ${'x'.repeat(400)}\n    next`;
    const wrappedRows = (lines: () => HTMLElement[]) =>
      lines().filter((line) => line.classList.contains('own-editor-line-wrapped'));

    it('длинная строка с отступом режется на ряды, продолжение помечено', () => {
      const { view, lines } = makeView(LONG);
      view.setWordWrap(true);
      expect(wrappedRows(lines).length).toBeGreaterThan(0);
    });

    it('линейка стоит в колонке отступа, в пикселях строки', () => {
      const { view, lines } = makeView(LONG);
      view.setWordWrap(true);
      const row = wrappedRows(lines)[0] as unknown as {
        querySelector(s: string): { style: { left: string } } | null;
      };
      const guide = row.querySelector('.own-editor-wrap-guide');
      expect(guide).not.toBeNull();
      expect(guide?.style.left).toBe('32px');
    });

    it('на рядах-продолжениях направляющие отступов не повторяются', () => {
      // Отступ один на строку: если штрихи продолжать, перенесённый кусок читается
      // как отдельная строка внутри блока.
      const { view, lines } = makeView(LONG);
      view.setWordWrap(true);
      for (const row of wrappedRows(lines)) {
        expect(row.querySelectorAll('.own-editor-indent-guide').length).toBe(0);
      }
    });

    it('без переноса линейки нет', () => {
      const { view, root } = makeView(LONG);
      expect(view.wordWrap).toBe(false);
      expect(root.querySelectorAll('.own-editor-wrap-guide').length).toBe(0);
    });
  });

  it('вид собирается и показывает строки буфера', () => {
    const { lines } = makeView('one\ntwo\nthree');

    expect(lines().length).toBeGreaterThan(0);
    const shown = lines().map((line) => line.textContent ?? '');
    expect(shown.join('')).toContain('one');
    expect(shown.join('')).toContain('three');
  });

  it('строки идут подряд в своём слое, слой сдвигается к первой видимой', () => {
    // Ряды не позиционируются по одному: весь слой сдвигается на первую видимую
    // строку — так прокрутка не переставляет сотни узлов.
    const { lines, root } = makeView('первая\nвторая\nтретья');

    const texts = lines().map((line) => line.textContent ?? '');
    expect(texts).toEqual(['первая', 'вторая', 'третья']);
    const layer = root.querySelector('.own-editor-lines') as unknown as {
      style: { cssText?: string; transform?: string };
    };
    expect(layer).not.toBeNull();
  });

  it('пустой буфер не роняет вид', () => {
    expect(() => makeView('')).not.toThrow();
  });

  it('верхнюю строку видно и можно поставить обратно — на этом стоит прокрутка в сессии', () => {
    // Сессия помнит строку, а не пиксели: пиксели зависят от шрифта и переноса.
    const text = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join('\n');
    const { view } = makeView(text);
    view.scrollToLine(120);
    expect(view.firstVisibleLine()).toBe(120);
  });

  it('прокрутка за конец файла притихает к последней строке', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const { view } = makeView(text);
    view.scrollToLine(9999);
    expect(view.firstVisibleLine()).toBeLessThanOrEqual(40);
    view.scrollToLine(-5);
    expect(view.firstVisibleLine()).toBe(1);
  });

  it('широкий знак занимает две клетки', () => {
    // Если считать иероглиф за одну клетку, каретка и выделение разъедутся с текстом.
    // `layoutLine` отдаёт смещения в ПИКСЕЛЯХ, а `widthOf` — ширину знака в пикселях
    // (`cellsOf × charWidth`). Два обычных знака равны одному широкому: 16 px.
    const narrow = layoutLine('aa', METRICS, []);
    const wide = layoutLine('漢', METRICS, []);

    expect(narrow[2]! - narrow[0]!).toBe(16);
    expect(wide[1]! - wide[0]!).toBe(16);
  });

  it('без жёлоба вид всё равно собирается', () => {
    const { root } = makeView('one', { gutter: false });

    expect(root).toBeDefined();
  });
});

describe('номера строк и обновление', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('жёлоб нумерует строки с единицы', () => {
    const { root } = makeView('a\nb\nc');

    const numbers = (root?.querySelectorAll('.own-editor-gutter-number') ?? []) as unknown as {
      textContent: string;
    }[];

    expect(numbers.map((entry) => entry.textContent)).toEqual(['1', '2', '3']);
  });

  it('без жёлоба номеров нет', () => {
    const { root } = makeView('a\nb', { gutter: false });

    expect((root?.querySelectorAll('.own-editor-gutter-number') ?? []).length).toBe(0);
  });

  it('вставка текста в буфере меняет то, что видно', () => {
    // Вид перерисовывает строки по буферу: без этого редактор показывал бы старое.
    const { buffer, lines, view } = makeView('одна');
    expect(lines().map((line) => line.textContent)).toEqual(['одна']);

    buffer.insert(0, 'начало ');
    // Правка в буфере сама вид не трогает: перерисовку просит контроллер (`refresh`).
    view.refresh(0);
    const redrawn = lines().map((line) => line.textContent);

    expect(redrawn.join('')).toContain('начало одна');
  });

  it('длинный файл рисует не все строки сразу', () => {
    // Мини-DOM отдаёт высоту окна, а редактор виртуализирован: строки за пределами
    // окна не создаются. Это и есть причина, по которой он держит тысячи строк.
    const many = Array.from({ length: 5000 }, (_, index) => `строка ${index + 1}`).join('\n');
    const { lines } = makeView(many);

    expect(lines().length).toBeGreaterThan(0);
    expect(lines().length).toBeLessThan(500);
  });
});

describe('устойчивость вида', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('правка в буфере не роняет вид', () => {
    // Каретку ведёт контроллер, а вид обязан пережить любую правку: удаление всего
    // текста — самый частый способ получить за концом документа.
    const { buffer, view } = makeView('первая\nвторая');

    buffer.delete(0, buffer.text.length);
    expect(() => view.refresh(0)).not.toThrow();
  });

  it('многострочный файл перерисовывается после вставки строки', () => {
    const { buffer, view, lines } = makeView('a\nb');

    buffer.insert(0, 'новая\n');
    view.refresh(0);

    expect(
      lines()
        .map((line) => line.textContent)
        .join(''),
    ).toContain('новая');
  });
});

/**
 * Закреплённые заголовки блоков (sticky scroll). Слой живёт поверх поля прокрутки и
 * повторяет заголовки вмещающих блоков: прокрутил внутрь функции — её начало видно
 * сверху. Проверяется прямо по DOM слоя.
 */
describe('закреплённые заголовки (sticky scroll)', () => {
  beforeEach(() => {
    installMiniDom();
  });

  /** Строки исходника в «функции» с вложенным блоком: два диапазона свёртки. */
  /**
   * Строки исходника: функция с вложенным блоком, а перед ней восемьдесят заполнителей.
   * Заполнители — чтобы строка 81 не влезала в экран (600px / 20 = 30 строк): иначе
   * прокрутка не сдвинется и верхом окажется начало файла.
   */
  const PAD = Array.from({ length: 80 }, (_, i) => `const pad${i} = ${i};`);
  const SOURCE = [
    ...PAD,
    'function f() {',
    '  if (x) {',
    '    a();',
    '    b();',
    '  }',
    '}',
    ...Array.from({ length: 60 }, (_, i) => `const tail${i} = ${i};`),
  ].join('\n');
  /** Номера строк тела функции при таком префиксе: заголовок — 81. */
  const FN = PAD.length + 1;

  function stickyRows(root: any): string[] {
    const rows = (root?.querySelectorAll('.own-editor-sticky-row') ?? []) as unknown as {
      textContent: string;
    }[];
    return rows.map((row) => row.textContent);
  }

  /**
   * Прокрутить так, чтобы строка (с 1) оказалась вверху экрана. `revealOffset` ставит
   * строку лишь в видимую часть (при прокрутке сверху — к нижнему краю), поэтому после
   * него ставим прокрутку напрямую: вид пересчитывает окно в `refresh`. Плавность гасим:
   * без неё прыжок идёт кадрами, и проверка ловила бы вид посреди анимации.
   */
  function scrollToLine(view: EditorView, buffer: TextBuffer, line: number): void {
    view.setSmoothScroll(false);
    view.revealOffset(buffer.lineStart(line));
    const viewport = (view as unknown as { viewport: { scrollTop: number } }).viewport;
    viewport.scrollTop = (line - 1) * METRICS.lineHeight;
    view.refresh(0);
  }

  it('в начале файла слой пуст', () => {
    const { view, buffer, root } = makeView(SOURCE);
    view.setFoldRanges([
      { startLine: FN, endLine: FN + 5 },
      { startLine: FN + 1, endLine: FN + 4 },
    ]);
    scrollToLine(view, buffer, 1);

    // Верх — строка 1, вне блоков: прикалывать нечего.
    expect(stickyRows(root)).toEqual([]);
  });

  it('внутри функции приколот её заголовок', () => {
    const { view, buffer, root } = makeView(SOURCE);
    view.setFoldRanges([{ startLine: FN, endLine: FN + 5 }]);
    scrollToLine(view, buffer, FN + 2);

    expect(stickyRows(root)).toEqual(['function f() {']);
  });

  it('внутри вложенного блока — цепочка сверху вниз', () => {
    const { view, buffer, root } = makeView(SOURCE);
    view.setFoldRanges([
      { startLine: FN, endLine: FN + 5 },
      { startLine: FN + 1, endLine: FN + 4 },
    ]);
    scrollToLine(view, buffer, FN + 3);

    // Порядок — от внешнего к внутреннему: так читается «где я».
    expect(stickyRows(root)).toEqual(['function f() {', '  if (x) {']);
  });

  it('внутри свёрнутого блока слой пуст', () => {
    const { view, buffer, root } = makeView(SOURCE);
    view.setFoldRanges([{ startLine: FN, endLine: FN + 5 }]);
    // Верх — внутри свёрнутой функции: её строки не видны, прикалывать нечего.
    scrollToLine(view, buffer, FN + 3);
    view.toggleFold(FN);

    expect(stickyRows(root)).toEqual([]);
  });
});

describe('огромная строка не тормозит вид', () => {
  /** Строка в `columns` знаков без пробелов: переносится по знаку. */
  const wide = (columns: number): string => 'a'.repeat(columns);

  it('строка длиннее потолка — ОДИН ряд, а не десятки тысяч', () => {
    // Было: порог по числу строк (MAX_WRAP_LINES) есть, а по длине — нет, и файл из
    // сотни строк по мегабайту раскладывал всё это на открытии. Строка-гигант теперь
    // остаётся одним рядом: раскладка на каждый её знак дороже пользы.
    const { view } = makeView(`${wide(300_000)}\nвторая`);
    view.setWordWrap(true);
    // Перенос включён (строк в файле мало) — порог именно про длину строки.
    expect(view.wordWrap).toBe(true);
    expect(view.foldState().rows).toBe(2); // гигант + «вторая», гигант не размотан
  });

  it('перерисовка вида не раскладывает гиганта заново', () => {
    // Было: renderLines звал layoutLine/wrapSegments НАПРЯМУЮ, мимо кэша — каждый
    // кадр прокрутки внутри строки-гиганта раскладывал её с нуля.
    const { view } = makeView(`${wide(300_000)}\nвторая`);
    view.setWordWrap(true);
    const started = Date.now();
    for (let index = 0; index < 20; index += 1) {
      view.setWordWrap(false);
      view.setWordWrap(true); // полная перерисовка слоя строк
    }
    // Без кэша здесь была бы сорокократная раскладка 300 000 знаков — секунды.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('строка в пределах потолка переносится как обычно', () => {
    const { view } = makeView(`${'a'.repeat(500)}\nвторая`);
    view.setWordWrap(true);
    expect(view.foldState().rows).toBeGreaterThan(2); // короткая строка размотана
    expect(() => view.scrollToLine(2)).not.toThrow();
    expect(view.firstVisibleLine()).toBe(2);
  });

  it('огромная строка не теряет конец и не роняет вид', () => {
    const { view } = makeView(`${wide(300_000)}\nвторая`);
    view.setWordWrap(true);
    expect(() => view.scrollToLine(2)).not.toThrow();
    expect(view.firstVisibleLine()).toBe(2);
  });
});
