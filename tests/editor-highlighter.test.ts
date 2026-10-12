import { describe, expect, it } from 'vitest';
import type { Grammar } from '../src/renderer/editor/highlight/grammar';
import { LineHighlighter } from '../src/renderer/editor/highlight/highlighter';
import { grammarFor } from '../src/renderer/editor/highlight/registry';
import { COMMENT, IDENTIFIER, KEYWORD, type Token } from '../src/renderer/editor/highlight/tokens';

/**
 * Стенд: грамматика со счётчиком вызовов и массив строк, который можно править.
 * Счётчик — главное здесь: по нему видно, СКОЛЬКО строк переразобрано. Именно это и
 * проверяют тесты ниже — не «токены верны», а «работа сделана ровно та, что нужна».
 */
function harness(grammar: Grammar, lines: string[]) {
  let calls = 0;
  const counting: Grammar = {
    id: grammar.id,
    line: (text, state) => {
      calls += 1;
      return grammar.line(text, state);
    },
  };
  const highlighter = new LineHighlighter(counting, (line) => lines[line] ?? '');
  return {
    highlighter,
    lines,
    calls: () => calls,
    clearCalls: () => {
      calls = 0;
    },
  };
}

/** Тип токена, покрывающего смещение. */
function typeAt(tokens: readonly Token[], offset: number): string | null {
  for (const token of tokens) {
    if (offset >= token.start && offset < token.end) return token.type;
  }
  return null;
}

const TYPESCRIPT = grammarFor('typescript')!;
const lines = (count: number, text = 'const a = 1;') => Array.from({ length: count }, () => text);

describe('LineHighlighter', () => {
  it('без языка токенов нет, и это не ошибка', () => {
    const highlighter = new LineHighlighter(null, () => 'const a = 1;');
    expect(highlighter.active).toBe(false);
    expect(highlighter.language).toBeNull();
    expect(highlighter.tokensFor(0)).toHaveLength(0);
  });

  it('разбирает только те строки, которые спросили', () => {
    const { highlighter, calls } = harness(TYPESCRIPT, lines(50));
    highlighter.tokensFor(5);
    // Строки 0..5 — шесть вызовов; остальные сорок четыре не тронуты.
    expect(calls()).toBe(6);
    highlighter.tokensFor(10);
    expect(calls()).toBe(11);
  });

  it('правка в середине не трогает строки выше и сходится сразу', () => {
    const setup = harness(TYPESCRIPT, lines(30));
    setup.highlighter.tokensFor(29);
    expect(setup.calls()).toBe(30);

    setup.clearCalls();
    setup.lines[15] = 'const b = 2;';
    setup.highlighter.invalidate(15);
    setup.highlighter.tokensFor(29);

    // Состояние после правки то же (обычный код) — значит, ниже всё как было,
    // и переразбирается ровно одна строка.
    expect(setup.calls()).toBe(1);
  });

  it('правка, открывшая блочный комментарий, переразбирается до его закрытия', () => {
    const setup = harness(TYPESCRIPT, lines(30));
    setup.highlighter.tokensFor(29);
    setup.clearCalls();

    setup.lines[0] = '/* начало';
    setup.lines[1] = 'середина';
    setup.lines[2] = 'конец */ const a = 1;';
    setup.highlighter.invalidate(0);
    setup.highlighter.tokensFor(29);

    // Переразобраны строки 0, 1 и 2 — на третьей состояние вернулось к обычному, и
    // дальше подсветка доверяет прежним токенам. Не тридцать строк, а три.
    expect(setup.calls()).toBe(3);
    // И токены при этом верные: внутри комментария — комментарий, ниже — код.
    expect(typeAt(setup.highlighter.tokensFor(0), 0)).toBe(COMMENT);
    expect(typeAt(setup.highlighter.tokensFor(1), 0)).toBe(COMMENT);
    expect(typeAt(setup.highlighter.tokensFor(3), 0)).toBe(KEYWORD);
  });

  it('незакрытый комментарий не даёт сойтись: переразбор идёт вниз', () => {
    const setup = harness(TYPESCRIPT, lines(10));
    setup.highlighter.tokensFor(9);
    setup.clearCalls();

    setup.lines[0] = '/*';
    setup.highlighter.invalidate(0);
    const tokens = setup.highlighter.tokensFor(9);

    // Состояние не сошлось ни на одной строке — разобраны все десять, и всё в комментарии.
    expect(setup.calls()).toBe(10);
    expect(typeAt(tokens, 0)).toBe(COMMENT);
    expect(typeAt(setup.highlighter.tokensFor(9), 0)).toBe(COMMENT);
  });

  it('правка, изменившая число строк, выбрасывает догадки о строках ниже', () => {
    const setup = harness(TYPESCRIPT, lines(30));
    setup.highlighter.tokensFor(29);
    setup.clearCalls();

    // Вставили перевод строки в начале: все строки сдвинулись, старые токены —
    // о другом тексте. Сходиться состоянию не с чем, поэтому разбор идёт до нужной строки.
    setup.lines.unshift('// новая строка');
    setup.highlighter.invalidate(0, true);
    setup.highlighter.tokensFor(5);

    expect(setup.calls()).toBe(6);
    // Токены соответствуют новому тексту: первая строка — комментарий.
    expect(typeAt(setup.highlighter.tokensFor(0), 0)).toBe(COMMENT);
  });

  it('смена языка меняет разбор строки', () => {
    const setup = harness(TYPESCRIPT, ['const a = 1;']);
    expect(typeAt(setup.highlighter.tokensFor(0), 0)).toBe(KEYWORD);

    setup.highlighter.setGrammar(grammarFor('python'));
    expect(setup.highlighter.language).toBe('python');
    // В Python «const» — не ключевое слово, а обычное имя.
    expect(typeAt(setup.highlighter.tokensFor(0), 0)).toBe(IDENTIFIER);
  });

  it('сброс забывает всё: следующая строка разбирается с начала', () => {
    const setup = harness(TYPESCRIPT, lines(10));
    setup.highlighter.tokensFor(9);
    setup.clearCalls();

    setup.highlighter.reset();
    setup.highlighter.tokensFor(2);
    expect(setup.calls()).toBe(3);
  });
});
