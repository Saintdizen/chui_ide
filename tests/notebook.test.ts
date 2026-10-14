import { describe, expect, it } from 'vitest';
import { isNotebookPath, notebookSummary, parseNotebook } from '../src/shared/notebook';
import { diffNotebooks, lineDiff } from '../src/shared/notebook-diff';

/** Собрать ноутбук-строку: удобно и читаемо для тестов. */
function notebook(cells: unknown[]): string {
  return JSON.stringify({ cells, metadata: { kernelspec: { language: 'python' } }, nbformat: 4, nbformat_minor: 5 });
}

const markdown = (text: string): unknown => ({ cell_type: 'markdown', metadata: {}, source: [text] });
const code = (text: string, outputs: unknown[] = [], count = 1): unknown => ({
  cell_type: 'code',
  execution_count: count,
  metadata: {},
  outputs,
  source: [text],
});

describe('isNotebookPath', () => {
  it('узнаёт расширение .ipynb без учёта регистра', () => {
    expect(isNotebookPath('analysis.ipynb')).toBe(true);
    expect(isNotebookPath('A.IPYNB')).toBe(true);
    expect(isNotebookPath('main.py')).toBe(false);
  });
});

describe('parseNotebook: разбор ячеек', () => {
  it('читает markdown и код, склеивая source из массива строк', () => {
    const parsed = parseNotebook(notebook([markdown('# Заголовок\n'), code('print(1)\n')]));
    expect(parsed.error).toBeNull();
    expect(parsed.cells.map((cell) => `${cell.kind}:${cell.source}`)).toEqual([
      'markdown:# Заголовок\n',
      'code:print(1)\n',
    ]);
  });

  it('source строкой и массивом читается одинаково', () => {
    const parsed = parseNotebook(notebook([{ cell_type: 'markdown', source: 'текст' }]));
    expect(parsed.cells[0]!.source).toBe('текст');
  });

  it('номер исполнения и выводы кода сохраняются', () => {
    const outputs = [
      { output_type: 'stream', name: 'stdout', text: ['привет\n'] },
      { output_type: 'error', ename: 'ValueError', evalue: 'нет' },
    ];
    const parsed = parseNotebook(notebook([code('x', outputs, 7)]));
    const cell = parsed.cells[0]!;
    expect(cell.executionCount).toBe(7);
    expect(cell.outputs).toEqual([
      { kind: 'text', text: 'привет\n' },
      { kind: 'error', text: 'ValueError: нет' },
    ]);
  });

  it('картинка в выводе помечается, а не тащится в память', () => {
    const outputs = [{ output_type: 'display_data', data: { 'image/png': 'AAAA' } }];
    const parsed = parseNotebook(notebook([code('plt.show()', outputs)]));
    expect(parsed.cells[0]!.outputs).toEqual([{ kind: 'image/png', text: '(изображение)' }]);
  });

  it('язык ядра читается из метаданных', () => {
    expect(parseNotebook(notebook([])).language).toBe('python');
  });

  it('битый JSON — понятная ошибка, а не исключение', () => {
    const parsed = parseNotebook('{ не json');
    expect(parsed.error).toBeTruthy();
    expect(parsed.cells).toEqual([]);
  });

  it('JSON без ячеек — это не ноутбук', () => {
    expect(parseNotebook('{"a": 1}').error).toBeTruthy();
  });

  it('незнакомые виды ячеек пропускаются', () => {
    const parsed = parseNotebook(notebook([{ cell_type: 'нечто', source: 'x' }, markdown('ok')]));
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0]!.source).toBe('ok');
  });
});

describe('notebookSummary', () => {
  it('считает состав по видам', () => {
    const parsed = parseNotebook(notebook([markdown('a'), markdown('b'), code('x'), code('y'), code('z')]));
    expect(notebookSummary(parsed)).toBe('5 ячеек: 2 markdown, 3 кода');
  });

  it('склоняет число ячеек', () => {
    expect(notebookSummary(parseNotebook(notebook([code('x')])))).toBe('1 ячейка: 1 кода');
  });
});

describe('lineDiff: построчное различие', () => {
  it('находит замену строки', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'equal', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'equal', text: 'c' },
    ]);
  });

  it('добавление и удаление строк', () => {
    expect(lineDiff('a\nc', 'a\nb\nc')).toEqual([
      { kind: 'equal', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'equal', text: 'c' },
    ]);
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'equal', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'equal', text: 'c' },
    ]);
  });
});

describe('diffNotebooks: сравнение по ячейкам', () => {
  const before = parseNotebook(notebook([markdown('# Тема\n'), code('x = 1\n'), code('print(x)\n')]));

  it('неизменный ноутбук — только equal', () => {
    const diff = diffNotebooks(before, before);
    expect(diff.changes.every((change) => change.kind === 'equal')).toBe(true);
    expect(diff.added + diff.removed + diff.changed).toBe(0);
  });

  it('переписанная ячейка — «изменено» с построчным различием', () => {
    const after = parseNotebook(notebook([markdown('# Тема\n'), code('x = 2\n'), code('print(x)\n')]));
    const diff = diffNotebooks(before, after);
    expect(diff.changed).toBe(1);
    const changed = diff.changes.find((change) => change.kind === 'changed')!;
    expect(changed.before).toBe('x = 1\n');
    expect(changed.after).toBe('x = 2\n');
    expect(changed.lines).toContainEqual({ kind: 'removed', text: 'x = 1' });
    expect(changed.lines).toContainEqual({ kind: 'added', text: 'x = 2' });
  });

  it('добавленная и удалённая ячейки', () => {
    const after = parseNotebook(notebook([markdown('# Тема\n'), code('print(x)\n'), code('y = 3\n')]));
    const diff = diffNotebooks(before, after);
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.changes.find((change) => change.kind === 'removed')!.before).toBe('x = 1\n');
    expect(diff.changes.find((change) => change.kind === 'added')!.after).toBe('y = 3\n');
  });

  it('выводы не участвуют в сравнении', () => {
    const outputs = [{ output_type: 'stream', text: ['1\n'] }];
    const withOutput = parseNotebook(notebook([code('print(1)\n', outputs)]));
    const without = parseNotebook(notebook([code('print(1)\n')]));
    expect(diffNotebooks(withOutput, without).changed).toBe(0);
  });

  it('порядок ячеек важен: перестановка видна как удаление и вставка', () => {
    const a = parseNotebook(notebook([code('a\n'), code('b\n')]));
    const b = parseNotebook(notebook([code('b\n'), code('a\n')]));
    const diff = diffNotebooks(a, b);
    expect(diff.changed + diff.added + diff.removed).toBeGreaterThan(0);
  });
});
