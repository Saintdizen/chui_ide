import { expect, it } from 'vitest';
import { toInlineSnippets } from '../src/shared/lsp-inline';

it('строки и { value } берёт одинаково', () => {
  expect(toInlineSnippets({ items: [{ insertText: 'a' }, { insertText: { value: 'b' } }] })).toEqual(['a', 'b']);
});

it('массив верхнего уровня тоже ответ', () => {
  expect(toInlineSnippets([{ insertText: 'x' }])).toEqual(['x']);
});

it('пустое и пустое-по-смыслу отбрасывает', () => {
  expect(toInlineSnippets(null)).toEqual([]);
  expect(toInlineSnippets({ items: [{ insertText: '' }, {}, { insertText: 'ok' }] })).toEqual(['ok']);
});
