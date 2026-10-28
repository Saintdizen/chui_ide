import { describe, expect, it } from 'vitest';
import { toCompletions, toResolvedCompletion } from '../src/shared/lsp-completions';

describe('разбор подсказок LSP', () => {
  it('принимает и список, и обёртку CompletionList', () => {
    const items = [{ label: 'foo' }];
    // Исходный элемент тоже переносится (`source`) — сверяем главные поля.
    expect(toCompletions(items)[0]).toMatchObject({ label: 'foo', insert: 'foo', detail: 'символ' });
    expect(toCompletions({ items })[0]).toMatchObject({ label: 'foo', insert: 'foo', detail: 'символ' });
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
    // Незнакомый номер вида — конкретного пояснения нет, но пустой подписи не бывает:
    // иначе в списке остаётся пустое место, а `fitsExpectation` теряет признак вида.
    expect(toCompletions([{ label: 'foo', kind: 999 }])[0]!.detail).toBe('символ');
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

  it('переносит filterText, sortText, preselect и пометку «устарело»', () => {
    const entry = toCompletions([
      { label: 'UserName', filterText: 'user', sortText: '2', preselect: true, tags: [1] },
    ])[0]!;
    expect(entry.filterText).toBe('user');
    expect(entry.sortText).toBe('2');
    expect(entry.preselect).toBe(true);
    expect(entry.deprecated).toBe(true);
    // Старая форма пометки — флаг `deprecated`.
    expect(toCompletions([{ label: 'old', deprecated: true }])[0]!.deprecated).toBe(true);
  });

  it('порядок задаёт сервер по sortText, без него — по подписи', () => {
    const labels = toCompletions([{ label: 'b', sortText: '1' }, { label: 'a', sortText: '2' }, { label: 'c' }]).map(
      (entry) => entry.label,
    );
    expect(labels).toEqual(['b', 'a', 'c']);
  });

  it('исходный элемент сохраняется для resolve', () => {
    const raw = { label: 'print', data: { id: 'print' } };
    expect(toCompletions([raw])[0]!.source).toBe(raw);
  });

  it('пустой и неожиданный ответ — пустой список', () => {
    expect(toCompletions(null)).toEqual([]);
    expect(toCompletions(undefined)).toEqual([]);
    expect(toCompletions({})).toEqual([]);
    expect(toCompletions('строка')).toEqual([]);
  });
});

describe('доведение подсказки (completionItem/resolve)', () => {
  it('берёт detail и описание-строку', () => {
    expect(toResolvedCompletion({ detail: 'print(*args)', documentation: 'печатает' })).toEqual({
      detail: 'print(*args)',
      documentation: 'печатает',
    });
  });

  it('описание из MarkupContent и массива сводится к тексту', () => {
    expect(toResolvedCompletion({ documentation: { kind: 'markdown', value: 'Жирный' } })).toEqual({
      documentation: 'Жирный',
    });
    expect(toResolvedCompletion({ documentation: ['раз', { value: 'два' }] })).toEqual({
      documentation: 'раз\n\nдва',
    });
  });

  it('пустые поля и мусор дают null: строку списка не трогаем', () => {
    expect(toResolvedCompletion({})).toBeNull();
    expect(toResolvedCompletion({ detail: '   ' })).toBeNull();
    expect(toResolvedCompletion(null)).toBeNull();
    expect(toResolvedCompletion('строка')).toBeNull();
  });
});
