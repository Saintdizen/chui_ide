import { expect, it } from 'vitest';
import { toFormatEdits } from '../src/shared/lsp-formatting';

it('правки ответа сохраняют диапазоны', () => {
  const edits = toFormatEdits([
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'abc' },
  ]);
  expect(edits).toHaveLength(1);
  expect(edits[0]?.newText).toBe('abc');
});
