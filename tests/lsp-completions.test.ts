import { describe, expect, it } from 'vitest';
import { toCompletions } from '../src/shared/lsp-completions';

describe('разбор подсказок LSP', () => {
  it('принимает и список, и обёртку CompletionList', () => {
    const items = [{ label: 'foo' }];
    expect(toCompletions(items)).toEqual([{ label: 'foo', insert: 'foo', detail: '' }]);
    expect(toCompletions({ items })).toEqual([{ label: 'foo', insert: 'foo', detail: '' }]);
    expect(toCompletions({ isIncomplete: true, items })).toHaveLength(1);
  });

  it('подпись и текст вставки совпадают, если сервер не задал своё', () => {
    expect(toCompletions([{ label: 'name' }])[0]).toMatchObject({ label: 'name', insert: 'name' });
  });

  it('insertText важнее подписи, а textEdit.newText — важнее обоих', () => {
    expect(toCompletions([{ label: 'print', insertText: 'print()' }])[0]).toMatchObject({
      label: 'print',
      insert: 'print()',
    });
    expect(
      toCompletions([{ label: 'print', insertText: 'print()', textEdit: { newText: 'print($0)' } }])[0],
    ).toMatchObject({ insert: 'print($0)' });
  });

  it('вид символа переводится в пояснение; свой detail главнее', () => {
    expect(toCompletions([{ label: 'foo', kind: 3 }])[0]!.detail).toBe('функция');
    expect(toCompletions([{ label: 'foo', kind: 6 }])[0]!.detail).toBe('переменная');
    expect(toCompletions([{ label: 'foo', kind: 3, detail: '() -> str' }])[0]!.detail).toBe('() -> str');
    // Незнакомый номер вида — пояснения нет, но подсказка остаётся.
    expect(toCompletions([{ label: 'foo', kind: 999 }])[0]!.detail).toBe('');
  });

  it('additionalTextEdits (авто-импорт) переводятся в 1-based правки', () => {
    const entry = toCompletions([
      {
        label: 'Path',
        additionalTextEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'from pathlib import Path\n',
          },
        ],
      },
    ])[0]!;
    expect(entry.additionalEdits).toEqual([
      { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, newText: 'from pathlib import Path\n' },
    ]);
  });

  it('битые additionalTextEdits отбрасываются, пусто — поля нет', () => {
    expect(toCompletions([{ label: 'a', additionalTextEdits: [{}] }])[0]!.additionalEdits).toBeUndefined();
    expect(toCompletions([{ label: 'a' }])[0]!.additionalEdits).toBeUndefined();
  });

  it('insertTextFormat 2 даёт разметку сниппета', () => {
    const entry = toCompletions([{ label: 'for', insertText: 'for ${1:x} in ${2:xs}:', insertTextFormat: 2 }])[0]!;
    expect(entry.snippet).toBe('for ${1:x} in ${2:xs}:');
    expect(entry.insert).toBe('for ${1:x} in ${2:xs}:');
    expect(toCompletions([{ label: 'for', insertText: 'for' }])[0]!.snippet).toBeUndefined();
  });

  it('повторные подписи убираются, битые элементы пропускаются', () => {
    const items = [
      { label: 'a' },
      { label: 'a', detail: 'дубль' },
      { label: 'b' },
      { notAnItem: true },
      { label: 42 },
      null,
    ];
    expect(toCompletions(items).map((entry) => entry.label)).toEqual(['a', 'b']);
  });

  it('пустой и неожиданный ответ — пустой список', () => {
    expect(toCompletions(null)).toEqual([]);
    expect(toCompletions(undefined)).toEqual([]);
    expect(toCompletions({})).toEqual([]);
    expect(toCompletions('строка')).toEqual([]);
  });
});
