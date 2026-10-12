import { describe, expect, it } from 'vitest';
import { expandSnippet } from '../src/renderer/editor/complete/snippet';

describe('раскрытие сниппета', () => {
  it('подстановка без номера и текста', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const result = expandSnippet('console.log(${1})');
    expect(result.text).toBe('console.log()');
    expect(result.tabstops).toEqual([{ index: 1, start: 12, end: 12 }]);
    expect(result.caret).toBe(12);
  });

  it('подстановка с текстом заменяется этим текстом', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const result = expandSnippet('def ${1:name}(${2}):\n    ${3:pass}');
    expect(result.text).toBe('def name():\n    pass');
    expect(result.tabstops.map((t) => t.index)).toEqual([1, 2, 3]);
    // Первое место — слово «name».
    expect(result.text.slice(result.tabstops[0]!.start, result.tabstops[0]!.end)).toBe('name');
    expect(result.caret).toBe(4);
    expect(result.selectionEnd).toBe(8);
  });

  it('короткая форма $1 без скобок', () => {
    const result = expandSnippet('for $1 in $2:');
    expect(result.text).toBe('for  in :');
    expect(result.tabstops).toEqual([
      { index: 1, start: 4, end: 4 },
      { index: 2, start: 8, end: 8 },
    ]);
  });

  it('$0 — куда встать после подстановок, если мест нет', () => {
    const result = expandSnippet('value = 1$0');
    expect(result.text).toBe('value = 1');
    expect(result.tabstops).toEqual([]);
    expect(result.caret).toBe(9);
  });

  it('без разметки курсор встаёт в конец', () => {
    const result = expandSnippet('const a = 1;');
    expect(result.text).toBe('const a = 1;');
    expect(result.tabstops).toEqual([]);
    expect(result.caret).toBe(12);
    expect(result.selectionEnd).toBe(12);
  });

  it('экранированный доллар — обычный знак', () => {
    const result = expandSnippet('цена 5\\$ и $1');
    expect(result.text).toBe('цена 5$ и ');
    expect(result.tabstops).toEqual([{ index: 1, start: 10, end: 10 }]);
  });

  it('незакрытая подстановка остаётся как есть, а не съедается', () => {
    const result = expandSnippet('a ${1:b');
    expect(result.text).toBe('a ${1:b');
    expect(result.tabstops).toEqual([]);
  });

  it('места выстраиваются по номеру, а не по порядку появления', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: проверяем разметку сниппета как есть
    const result = expandSnippet('${2} ${1}');
    expect(result.tabstops.map((t) => t.index)).toEqual([1, 2]);
    // Курсор — на место с МЕНЬШИМ номером, даже если в тексте оно идёт вторым.
    // После раскрытия остаётся один пробел, значит $1 стоит на смещении 1.
    expect(result.text).toBe(' ');
    expect(result.caret).toBe(1);
  });
});
