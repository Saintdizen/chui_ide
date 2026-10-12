import { describe, expect, it } from 'vitest';
import {
  codeActionKindLabel,
  sortCodeActions,
  toCodeActions,
  toLspDiagnostics,
  type CodeActionItem,
} from '../src/shared/lsp-code-actions';
import type { LspDiagnostic } from '../src/shared/api';

/** Путь из ссылки — как это делает main: отрезаем `file://`. */
const toPath = (uri: string) => uri.replace(/^file:\/\//, '');

describe('разбор действий языка', () => {
  it('правки действия сворачиваются в FileEdit с путём', () => {
    const actions = toCodeActions(
      [
        {
          title: 'Заменить на `int`',
          kind: 'quickfix',
          edit: {
            changes: {
              'file:///p/a.py': [
                { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'int' },
              ],
            },
          },
        },
      ],
      toPath,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.edits).toEqual([
      { path: '/p/a.py', edits: [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 4, newText: 'int' }] },
    ]);
  });

  it('действие с командой разбирается как команда, а не правки', () => {
    const actions = toCodeActions(
      [{ title: 'Упорядочить импорты', command: { command: 'ruff.applyOrganizeImports', arguments: [] } }],
      toPath,
    );
    expect(actions[0]!.edits).toBeNull();
    expect(actions[0]!.command).toEqual({ command: 'ruff.applyOrganizeImports', arguments: [] });
  });

  it('быстрое исправление считается предпочтительным и идёт первым', () => {
    const actions = toCodeActions(
      [
        { title: 'Б: рефакторинг', kind: 'refactor' },
        { title: 'А: обычное', kind: 'source' },
        { title: 'В: исправление', kind: 'quickfix' },
      ],
      toPath,
    );
    expect(actions.map((item) => item.title)).toEqual(['В: исправление', 'А: обычное', 'Б: рефакторинг']);
    expect(actions[0]!.preferred).toBe(true);
  });

  it('флажок isPreferred тоже ставит действие вперёд', () => {
    const actions = toCodeActions(
      [
        { title: 'Обычное', kind: 'source' },
        { title: 'Избранное', kind: 'source', isPreferred: true },
      ],
      toPath,
    );
    expect(actions[0]!.title).toBe('Избранное');
  });

  it('действия без заголовка и мусор пропускаются', () => {
    expect(toCodeActions([null, 'строка', { kind: 'quickfix' }, { title: '  ' }], toPath)).toEqual([]);
    expect(toCodeActions(null, toPath)).toEqual([]);
    expect(toCodeActions({ title: 'не список' }, toPath)).toEqual([]);
  });

  it('сообщения диагностик действия едут в подсказку', () => {
    const actions = toCodeActions(
      [{ title: 'Исправить', kind: 'quickfix', diagnostics: [{ message: 'неизвестное имя' }, { message: '' }] }],
      toPath,
    );
    expect(actions[0]!.diagnostics).toEqual(['неизвестное имя']);
  });
});

describe('сортировка действий', () => {
  const item = (title: string, preferred: boolean): CodeActionItem => ({
    title,
    kind: '',
    preferred,
    edits: null,
    command: null,
    diagnostics: [],
  });

  it('предпочтительные вперёд, внутри группы — по алфавиту', () => {
    const sorted = sortCodeActions([item('б', false), item('а', false), item('я', true)]);
    expect(sorted.map((entry) => entry.title)).toEqual(['я', 'а', 'б']);
  });
});

describe('подпись вида действия', () => {
  it('составной вид читается по первому отрезку', () => {
    expect(codeActionKindLabel('quickfix')).toBe('быстрое исправление');
    expect(codeActionKindLabel('refactor.extract.function')).toBe('рефакторинг');
    expect(codeActionKindLabel('source.organizeImports')).toBe('источник');
    expect(codeActionKindLabel('')).toBe('');
    expect(codeActionKindLabel('нечто')).toBe('нечто');
  });
});

describe('пометки в форме LSP для запроса', () => {
  it('позиции становятся 0-based, серьёзность — числом', () => {
    const diagnostics: LspDiagnostic[] = [
      { line: 3, column: 5, endLine: 3, endColumn: 9, severity: 'error', message: 'беда', source: 'ts' },
      { line: 8, column: 1, endLine: 8, endColumn: 2, severity: 'warning', message: 'предупреждение' },
      { line: 9, column: 1, endLine: 9, endColumn: 2, severity: 'info', message: 'замечание' },
    ];
    expect(toLspDiagnostics(diagnostics)).toEqual([
      {
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
        severity: 1,
        source: 'ts',
        message: 'беда',
      },
      {
        range: { start: { line: 7, character: 0 }, end: { line: 7, character: 1 } },
        severity: 2,
        message: 'предупреждение',
      },
      {
        range: { start: { line: 8, character: 0 }, end: { line: 8, character: 1 } },
        severity: 3,
        message: 'замечание',
      },
    ]);
  });
});
