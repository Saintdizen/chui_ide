import { describe, expect, it } from 'vitest';
import { expandSnippet } from '../src/renderer/editor/complete/snippet';
import { SnippetSession } from '../src/renderer/editor/complete/snippet-session';

/**
 * Обход мест сниппета по `Tab` / `Shift+Tab` (TASKS 45).
 *
 * Раньше `expandSnippet` ставил каретку на первое место и на этом всё заканчивалось:
 * остальные места были только в разборе. Здесь проверяется именно порядок и границы —
 * сами смещения считает `snippet.ts` и его тесты.
 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: разметка сниппета как есть
describe('обход мест сниппета', () => {
  it('Tab идёт по местам по порядку и выделяет текст места', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const expanded = expandSnippet('def ${1:name}(${2:x}):');
    const session = new SnippetSession(expanded, 0);
    // Встали на первое место — его текст выделен, набираемое заменит черновик.
    expect(session.current).toEqual({ start: 4, end: 8 });
    const second = session.next();
    expect(second.done).toBe(false);
    expect(second.stop).toEqual({ start: 9, end: 10 });
    expect(session.current).toEqual({ start: 9, end: 10 });
  });

  it('последнее место выпускает из сниппета: каретка за ним, без выделения', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const session = new SnippetSession(expandSnippet('a ${1:b} ${2:c}'), 0);
    session.next();
    const last = session.next();
    expect(last.done).toBe(true);
    expect(last.stop).toEqual({ start: 5, end: 5 });
    // Дальше места нет — сессия исчерпана.
    expect(session.current).toBe(null);
  });

  it('Shift+Tab возвращает на место, но не уходит левее первого', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const session = new SnippetSession(expandSnippet('${1:a} ${2:b}'), 0);
    session.next();
    expect(session.previous().stop).toEqual({ start: 0, end: 1 });
    // На первом же: уступать клавишу нечему — стоим на месте.
    expect(session.previous().stop).toEqual({ start: 0, end: 1 });
  });

  it('смещения считаются от начала вставки, а не от начала файла', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const session = new SnippetSession(expandSnippet('f(${1:x})'), 100);
    expect(session.current).toEqual({ start: 102, end: 103 });
  });

  it('у сниппета без мест (только $0) обходить нечего', () => {
    const session = new SnippetSession(expandSnippet('value = 1$0'), 0);
    expect(session.isEmpty).toBe(true);
    expect(session.next().done).toBe(true);
  });

  it('правка внутри заготовки её не рвёт, в стороне — рвёт', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const session = new SnippetSession(expandSnippet('${1:a} ${2:b}'), 10);
    // Набранное на месте — заготовка та же.
    expect(session.coversChange(10)).toBe(true);
    expect(session.coversChange(13)).toBe(true);
    // Правка за концом заготовки сдвигает всё после неё — места больше не верны.
    expect(session.coversChange(50)).toBe(false);
  });
});
