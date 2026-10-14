import { describe, expect, it } from 'vitest';
import { type SelectionSpan, stepSelection, toSelectionSpans } from '../src/shared/lsp-selection-range';

/** Ответ сервера из цепочки «участок → родитель → …»: удобно собирать в тестах. */
function chain(...ranges: [number, number, number, number][]): unknown {
  // Собираем снаружи внутрь: так первый аргумент оказывается самым узким (`raw[0]`),
  // а `parent` каждого ведёт к более широкому — ровно как отвечает сервер.
  let node: unknown = undefined;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const [startLine, startCharacter, endLine, endCharacter] = ranges[index]!;
    node = {
      range: { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } },
      ...(node ? { parent: node } : {}),
    };
  }
  return [node];
}

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number): SelectionSpan => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

describe('toSelectionSpans: разбор цепочки', () => {
  it('разворачивает родителей в список от узкого к широкому и переводит в 1-based', () => {
    // `name` внутри `user.name` внутри строки: 0-based у сервера → 1-based у нас.
    const spans = toSelectionSpans(chain([0, 5, 0, 9], [0, 0, 0, 9], [0, 0, 0, 20]));
    expect(spans).toEqual([span(1, 6, 1, 10), span(1, 1, 1, 10), span(1, 1, 1, 21)]);
  });

  it('многострочный участок сохраняется как есть', () => {
    const spans = toSelectionSpans(chain([1, 2, 3, 4]));
    expect(spans).toEqual([span(2, 3, 4, 5)]);
  });

  it('повтор одной границы подряд не дублируется', () => {
    const spans = toSelectionSpans(chain([0, 0, 0, 5], [0, 0, 0, 5], [0, 0, 0, 9]));
    expect(spans).toEqual([span(1, 1, 1, 6), span(1, 1, 1, 10)]);
  });

  it('пустой участок (нулевой ширины) пропускается', () => {
    const spans = toSelectionSpans(chain([0, 3, 0, 3], [0, 0, 0, 9]));
    expect(spans).toEqual([span(1, 1, 1, 10)]);
  });

  it('перевёрнутый участок пропускается', () => {
    const spans = toSelectionSpans(chain([0, 9, 0, 3]));
    expect(spans).toEqual([]);
  });

  it('мусор вместо ответа — пустой список', () => {
    expect(toSelectionSpans(null)).toEqual([]);
    expect(toSelectionSpans([])).toEqual([]);
    expect(toSelectionSpans([{ range: null }])).toEqual([]);
    expect(toSelectionSpans('нет')).toEqual([]);
  });
});

describe('stepSelection: шире и уже', () => {
  const word = span(1, 6, 1, 10);
  const member = span(1, 1, 1, 10);
  const statement = span(1, 1, 1, 21);
  const spans = [word, member, statement];

  it('с каретки первое «шире» даёт самый узкий участок', () => {
    expect(stepSelection(spans, null, 'expand')).toEqual(word);
  });

  it('дальше «шире» идёт по родителям по одному', () => {
    expect(stepSelection(spans, word, 'expand')).toEqual(member);
    expect(stepSelection(spans, member, 'expand')).toEqual(statement);
  });

  it('шире самого широкого — некуда', () => {
    expect(stepSelection(spans, statement, 'expand')).toBeNull();
  });

  it('«уже» возвращается на шаг к потомку', () => {
    expect(stepSelection(spans, statement, 'shrink')).toEqual(member);
    expect(stepSelection(spans, member, 'shrink')).toEqual(word);
  });

  it('уже самого узкого — нечего (вызывающий свернёт к каретке)', () => {
    expect(stepSelection(spans, word, 'shrink')).toBeNull();
  });

  it('с каретки «уже» ничего не делает', () => {
    expect(stepSelection(spans, null, 'shrink')).toBeNull();
  });

  it('выделение не из цепочки: наружу — ближайший объемлющий участок', () => {
    // Пользователь выделил вручную часть слова — ближайший объемлющий узел это `word`.
    const manual = span(1, 7, 1, 8);
    expect(stepSelection(spans, manual, 'expand')).toEqual(word);
  });

  it('выделение не из цепочки: внутрь — самый глубокий вложенный участок', () => {
    const wide = span(1, 1, 1, 40);
    expect(stepSelection(spans, wide, 'shrink')).toEqual(statement);
  });

  it('пустая цепочка — шагать некуда', () => {
    expect(stepSelection([], null, 'expand')).toBeNull();
    expect(stepSelection([], statement, 'shrink')).toBeNull();
  });

  it('участок не больше текущего наружу не отдаётся', () => {
    // В цепочке только тот же участок: шире него ничего нет.
    expect(stepSelection([statement], statement, 'expand')).toBeNull();
  });
});
