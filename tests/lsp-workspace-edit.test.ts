import { describe, expect, it } from 'vitest';
import { toWorkspaceEdits, toWorkspaceFileEdits } from '../src/shared/lsp-workspace-edit';

/**
 * Разбор ответа `textDocument/rename` (WorkspaceEdit) в форму `FileEdit[]`.
 * Правило, а не запуск: две формы ответа (`changes` и `documentChanges`), и
 * свести их к одному списку — единственное, что тут своего.
 */

const toPath = (uri: string): string => uri.replace('file://', '');

describe('toWorkspaceFileEdits', () => {
  it('разбирает форму changes: карта uri → правки', () => {
    const raw = {
      changes: {
        'file:///proj/src/a.ts': [
          { range: { start: { line: 4, character: 6 }, end: { line: 4, character: 12 } }, newText: 'newName' },
        ],
      },
    };
    expect(toWorkspaceFileEdits(raw, toPath)).toEqual([
      {
        path: '/proj/src/a.ts',
        edits: [{ startLine: 5, startColumn: 7, endLine: 5, endColumn: 13, newText: 'newName' }],
      },
    ]);
  });

  it('разбирает форму documentChanges', () => {
    const raw = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///proj/b.ts', version: 3 },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'x' }],
        },
      ],
    };
    expect(toWorkspaceFileEdits(raw, toPath)).toEqual([
      { path: '/proj/b.ts', edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, newText: 'x' }] },
    ]);
  });

  it('группирует правки по файлам и упорядочивает по позиции', () => {
    const raw = {
      changes: {
        'file:///proj/a.ts': [
          { range: { start: { line: 9, character: 0 }, end: { line: 9, character: 3 } }, newText: 'y' },
          { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: 'x' },
        ],
      },
    };
    const [file] = toWorkspaceFileEdits(raw, toPath)!;
    expect(file!.edits.map((edit) => edit.startLine)).toEqual([2, 10]);
  });

  it('операции над файлами (kind) пропускаются — инструмент их не делает', () => {
    const raw = {
      documentChanges: [
        { kind: 'create', uri: 'file:///proj/new.ts' },
        {
          textDocument: { uri: 'file:///proj/a.ts' },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'z' }],
        },
      ],
    };
    const files = toWorkspaceFileEdits(raw, toPath)!;
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('/proj/a.ts');
  });

  it('правка без начала диапазона пропускается, без конца — считается вставкой', () => {
    const raw = { changes: { 'file:///a.ts': [{ newText: 'x' }, { range: { start: { line: 0 } }, newText: 'y' }] } };
    // Первая — без range вовсе (мало данных), вторая — начало есть, конца нет.
    expect(toWorkspaceFileEdits(raw, toPath)).toEqual([
      { path: '/a.ts', edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, newText: 'y' }] },
    ]);
  });

  it('пустой или чужой ответ — null, а не пустой список', () => {
    expect(toWorkspaceFileEdits(null, toPath)).toBeNull();
    expect(toWorkspaceFileEdits({}, toPath)).toBeNull();
    expect(toWorkspaceFileEdits({ changes: {} }, toPath)).toBeNull();
    expect(toWorkspaceFileEdits({ documentChanges: [] }, toPath)).toBeNull();
  });
});

describe('операции с файлами (documentChanges)', () => {
  it('создать, переименовать, удалить — с опциями', () => {
    const raw = {
      documentChanges: [
        { kind: 'create', uri: 'file:///proj/new.ts', options: { overwrite: true } },
        { kind: 'rename', oldUri: 'file:///proj/a.ts', newUri: 'file:///proj/b.ts' },
        { kind: 'delete', uri: 'file:///proj/old.ts', options: { recursive: true, ignoreIfNotExists: true } },
      ],
    };
    const result = toWorkspaceEdits(raw, toPath)!;

    expect(result.files).toEqual([]);
    expect(result.operations).toEqual([
      { kind: 'create', path: '/proj/new.ts', overwrite: true, ignoreIfExists: false },
      { kind: 'rename', from: '/proj/a.ts', to: '/proj/b.ts', overwrite: false, ignoreIfExists: false },
      { kind: 'delete', path: '/proj/old.ts', recursive: true, ignoreIfNotExists: true },
    ]);
  });

  it('операции и правки идут вперемешку — порядок сохраняется', () => {
    const raw = {
      documentChanges: [
        { kind: 'create', uri: 'file:///proj/new.ts' },
        {
          textDocument: { uri: 'file:///proj/new.ts' },
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }],
        },
      ],
    };
    const result = toWorkspaceEdits(raw, toPath)!;

    expect(result.operations.map((op) => op.kind)).toEqual(['create']);
    expect(result.files.map((file) => file.path)).toEqual(['/proj/new.ts']);
  });

  it('битая операция пропускается, разбор не падает', () => {
    const raw = { documentChanges: [{ kind: 'rename', oldUri: 'file:///proj/a.ts' }, { kind: 'create' }] };

    expect(toWorkspaceEdits(raw, toPath)).toBeNull();
  });

  it('toWorkspaceFileEdits операции не отдаёт — только правки', () => {
    const raw = { documentChanges: [{ kind: 'delete', uri: 'file:///proj/old.ts' }] };

    expect(toWorkspaceFileEdits(raw, toPath)).toBeNull();
    expect(toWorkspaceEdits(raw, toPath)!.operations).toHaveLength(1);
  });
});
