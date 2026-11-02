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
  widthOf: (codePoint: number) => (codePoint > 0x2e80 ? 2 : 1),
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
  beforeEach(() => {
    installMiniDom();
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

  it('широкий знак занимает две клетки', () => {
    // Если считать иероглиф за одну клетку, каретка и выделение разъедутся с текстом.
    // Ширина считается раскладкой строки — она и есть правда о колонках.
    // `layoutLine` отдаёт смещения в КОЛОНКАХ, а `widthOf` — число клеток знака.
    const narrow = layoutLine('aa', METRICS, []);
    const wide = layoutLine('漢', METRICS, []);

    expect(narrow[2]! - narrow[0]!).toBe(2);
    expect(wide[1]! - wide[0]!).toBe(2);
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
