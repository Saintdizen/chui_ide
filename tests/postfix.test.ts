import { describe, expect, it } from 'vitest';
import { expandPostfix, postfixAt, postfixOffers, postfixTemplates } from '../src/renderer/editor/complete/postfix';

/**
 * Postfix-шаблоны: `order.if` → `if order:`.
 *
 * Проверяем три вещи, и каждая ломается по-своему: где шаблон вообще применим (выражение
 * перед точкой, а не мусор), какие шаблоны предлагаются по набранному, и что получится
 * после подстановки — там видно, встало ли выражение в оборот и где окажется курсор.
 */

/** Место под каретки: `|` в тексте — курсор. Смещения считаем от начала документа. */
function at(marked: string, languageId = 'python') {
  const column = marked.indexOf('|');
  const text = marked.replace('|', '');
  return postfixAt(text, column, 0, languageId);
}

describe('где шаблон применим', () => {
  it('выражение с точкой и набранным словом — применим', () => {
    expect(at('order.if|')).toEqual({ from: 0, expression: 'order', prefix: 'if' });
    expect(at('x = self.items[0].fo|')).toEqual({ from: 4, expression: 'self.items[0]', prefix: 'fo' });
  });

  it('без точки, без выражения или без слова — не применим', () => {
    expect(at('order|')).toBeNull();
    expect(at('|order')).toBeNull();
    expect(at('.if|')).toBeNull();
    expect(at('order.|')).toBeNull();
  });

  it('точка с пробелами — не postfix: это два оборота', () => {
    expect(at('order . if|')).toBeNull();
  });

  it('скобки считаются парными: выражение не рвётся посередине вызова', () => {
    expect(at('f(a.b).if|')).toEqual({ from: 0, expression: 'f(a.b)', prefix: 'if' });
    expect(at('items[i].if|')).toEqual({ from: 0, expression: 'items[i]', prefix: 'if' });
  });

  it('у языка без шаблонов подсказки нет', () => {
    expect(at('order.if|', 'go')).toBeNull();
  });
});

describe('что предлагается', () => {
  it('по набранному отбираются только подходящие шаблоны', () => {
    const match = at('order.if|')!;
    expect(postfixOffers(match, 'python').map((template) => template.key)).toEqual(['if']);
  });

  it('пустое набранное списка не открывает: иначе попап на каждой точке', () => {
    expect(postfixOffers({ from: 0, expression: 'order', prefix: '' }, 'python')).toEqual([]);
  });

  it('у каждого языка свои шаблоны, и они не смешиваются', () => {
    expect(postfixTemplates('python').map((t) => t.key)).toContain('notnull');
    expect(postfixTemplates('typescript').map((t) => t.key)).toContain('log');
    expect(postfixTemplates('python').map((t) => t.key)).not.toContain('log');
    expect(postfixTemplates('ruby')).toEqual([]);
  });
});

describe('что встаёт вместо оборота', () => {
  const pythonIf = postfixTemplates('python').find((template) => template.key === 'if')!;

  it('выражение подставляется, курсор — в тело', () => {
    const done = expandPostfix(pythonIf, 'order');
    expect(done.text).toBe('if order:\n    ');
    expect(done.text.slice(0, done.caret)).toBe('if order:\n    ');
  });

  it('разметки в готовом тексте не остаётся', () => {
    for (const template of [...postfixTemplates('python'), ...postfixTemplates('typescript')]) {
      const done = expandPostfix(template, 'value');
      expect(done.text).not.toContain('$EXPR');
      expect(done.text).not.toContain('$0');
      expect(done.text).toContain('value');
    }
  });

  it('у JS шаблоны в скобках и с точкой с запятой', () => {
    const log = postfixTemplates('typescript').find((template) => template.key === 'log')!;
    expect(expandPostfix(log, 'value').text).toBe('console.log(value);');
  });
});
