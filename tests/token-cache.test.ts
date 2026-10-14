import { describe, expect, it } from 'vitest';
import type { Grammar } from '../src/renderer/editor/highlight/grammar';
import { LineHighlighter } from '../src/renderer/editor/highlight/highlighter';
import { grammarFor } from '../src/renderer/editor/highlight/registry';
import { TokenCache } from '../src/renderer/editor/highlight/token-cache';

/** Грамматика со счётчиком: по нему видно, сколько раз строка реально разобрана. */
function counting(grammar: Grammar): { grammar: Grammar; calls: () => number } {
  let calls = 0;
  const wrapped: Grammar = {
    id: grammar.id,
    line: (text, state) => {
      calls += 1;
      return grammar.line(text, state);
    },
  };
  return { grammar: wrapped, calls: () => calls };
}

const TS = grammarFor('typescript')!;

describe('TokenCache', () => {
  it('одна и та же строка разбирается один раз', () => {
    const counter = counting(TS);
    const cache = new TokenCache();
    const first = cache.line(counter.grammar, 'const a = 1;', 0);
    const second = cache.line(counter.grammar, 'const a = 1;', 0);
    expect(counter.calls()).toBe(1);
    // Попадание отдаёт тот же результат, а не копию.
    expect(second).toBe(first);
  });

  it('разное состояние — разный разбор', () => {
    const counter = counting(TS);
    const cache = new TokenCache();
    cache.line(counter.grammar, 'середина', 0);
    cache.line(counter.grammar, 'середина', 1);
    expect(counter.calls()).toBe(2);
  });

  it('разный язык — разный ключ', () => {
    const counter = counting(TS);
    const cache = new TokenCache();
    cache.line(counter.grammar, 'x', 0);
    // Тот же текст и состояние, но id грамматики другой: разбор свой.
    const other: Grammar = { id: 'python', line: (text, state) => TS.line(text, state) };
    cache.line(other, 'x', 0);
    expect(counter.calls()).toBe(1);
  });

  it('память ограничена: вытесняется самый старый', () => {
    const counter = counting(TS);
    const cache = new TokenCache(2);
    cache.line(counter.grammar, '1', 0);
    cache.line(counter.grammar, '2', 0);
    cache.line(counter.grammar, '3', 0);
    expect(cache.size).toBe(2);
    cache.line(counter.grammar, '1', 0);
    // '1' вытеснена — разбор заново (четвёртый вызов).
    expect(counter.calls()).toBe(4);
  });

  it('попадание освежает запись: вытесняется не она', () => {
    const counter = counting(TS);
    const cache = new TokenCache(2);
    cache.line(counter.grammar, '1', 0);
    cache.line(counter.grammar, '2', 0);
    cache.line(counter.grammar, '1', 0); // освежили '1'
    cache.line(counter.grammar, '3', 0); // вытеснилась '2', а не '1'
    cache.line(counter.grammar, '1', 0); // из кэша
    expect(counter.calls()).toBe(3);
  });

  it('clear забывает всё', () => {
    const counter = counting(TS);
    const cache = new TokenCache();
    cache.line(counter.grammar, 'x', 0);
    cache.clear();
    expect(cache.size).toBe(0);
    cache.line(counter.grammar, 'x', 0);
    expect(counter.calls()).toBe(2);
  });
});

describe('LineHighlighter с общим кэшем', () => {
  it('второй разборщик тех же строк не разбирает их заново', () => {
    const counter = counting(TS);
    const cache = new TokenCache();
    const lines = ['const a = 1;', 'let b = 2;', 'function f() { return 1; }'];

    const first = new LineHighlighter(counter.grammar, (line) => lines[line] ?? '', cache);
    const firstTokens = lines.map((_, index) => first.tokensFor(index));
    const afterFirst = counter.calls();

    // Новый разборщик (как копия кода или сравнение на новой отрисовке) — те же строки
    // уже в общем кэше, значит ни одного нового разбора.
    const second = new LineHighlighter(counter.grammar, (line) => lines[line] ?? '', cache);
    const secondTokens = lines.map((_, index) => second.tokensFor(index));

    expect(counter.calls()).toBe(afterFirst);
    expect(secondTokens.map((tokens) => tokens.length)).toEqual(firstTokens.map((tokens) => tokens.length));
  });

  it('без кэша поведение прежнее: свой префикс, свой разбор', () => {
    const counter = counting(TS);
    const lines = ['const a = 1;', 'let b = 2;'];
    const highlighter = new LineHighlighter(counter.grammar, (line) => lines[line] ?? '');
    highlighter.tokensFor(1);
    // Две строки — два разбора: общего кэша нет.
    expect(counter.calls()).toBe(2);
  });
});
