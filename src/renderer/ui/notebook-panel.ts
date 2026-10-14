import type { Notebook, NotebookCell } from '../../shared/notebook';
import { isNotebookPath, notebookSummary, parseNotebook } from '../../shared/notebook';
import { type NotebookChange, diffNotebooks } from '../../shared/notebook-diff';
import { createMarkdownRenderer } from './chat-markdown';
import { clear, h } from './dom';

export interface NotebookPanelDeps {
  /** Путь активного файла: панель показывает ячейки именно его. */
  activePath(): string | null;
  /** Текст файла (в редакторе — с несохранёнными правками). `null` — файла нет. */
  readText(path: string): string | null;
  /** Версия файла в HEAD (`git.headText`); `null` — вне репозитория. Для сравнения. */
  readHead(path: string): Promise<string | null>;
  /** Короткий путь для подписи. */
  relativePath(path: string): string;
  /** Панель на виду — обновлять её, пока скрыта, незачем. */
  isVisible(): boolean;
}

export interface NotebookPanelView {
  element: HTMLElement;
  /** Перерисовать по активному файлу (вызывается при показе вкладки). */
  refresh(): void;
}

/**
 * Ячейки ноутбука — вкладка нижней панели.
 *
 * `.ipynb` — это JSON, и в редакторе он открыт как текст (править его и надо текстом).
 * Но читать ноутбук по строкам JSON невозможно, поэтому здесь он же показан ЯЧЕЙКАМИ:
 * markdown отрисован, код — моноширинным блоком с номером исполнения, а рядом — что
 * вывела ячейка. Это представление только для чтения: правка идёт в редакторе.
 *
 * Сравнение с версией из HEAD — по ячейкам, а не по строкам: в JSON сдвиг вывода меняет
 * половину файла, и построчное сравнение показало бы не то, что изменилось по существу.
 */
export function createNotebookPanel(deps: NotebookPanelDeps): NotebookPanelView {
  const renderer = createMarkdownRenderer({ insertCode: () => false });

  const title = h('span', { class: 'notebook-title' }, 'Ячейки');
  const pathLabel = h('span', { class: 'notebook-path' });
  const summary = h('span', { class: 'notebook-summary' });
  const compareButton = h(
    'button',
    { class: 'btn btn-small notebook-compare', type: 'button', title: 'Сравнить ячейки с версией из git (HEAD)' },
    'Сравнить с HEAD',
  );
  const head = h(
    'div',
    { class: 'notebook-head' },
    title,
    pathLabel,
    h('div', { class: 'notebook-head-spacer' }),
    summary,
    compareButton,
  );
  const body = h('div', { class: 'notebook-body' });
  const element = h('div', { class: 'notebook' }, head, body);

  /** Показывать ли сравнение: переключается кнопкой и сбрасывается при смене файла. */
  let showingDiff = false;
  /** Против чего сравниваем — путь, для которого получен HEAD. */
  let comparedPath: string | null = null;
  let comparedNotebook: Notebook | null = null;

  const note = (text: string): void => {
    clear(body);
    body.appendChild(h('div', { class: 'empty-note' }, h('p', {}, text)));
  };

  /** Ячейка «как её видит читатель»: markdown отрисован, код — моно с выводами. */
  function renderCell(cell: NotebookCell): HTMLElement {
    const badge = h('span', { class: 'notebook-cell-badge' }, cellLabel(cell));
    const cellBody = h('div', { class: 'notebook-cell-body' });
    if (cell.kind === 'markdown') {
      renderer.renderInto(cellBody, cell.source);
    } else {
      cellBody.appendChild(h('pre', { class: 'notebook-source' }, cell.source.replace(/\n$/, '')));
      for (const output of cell.outputs) {
        cellBody.appendChild(
          h('pre', { class: output.kind === 'error' ? 'notebook-output is-error' : 'notebook-output' }, output.text),
        );
      }
    }
    return h(
      'div',
      { class: `notebook-cell is-${cell.kind}` },
      h('div', { class: 'notebook-cell-head' }, badge),
      cellBody,
    );
  }

  function renderCells(notebook: Notebook): void {
    clear(body);
    if (notebook.cells.length === 0) {
      note('В ноутбуке нет ячеек.');
      return;
    }
    for (const cell of notebook.cells) body.appendChild(renderCell(cell));
  }

  /** Ячейка в сравнении: статус, было и стало, а у изменённой — построчное различие. */
  function renderChange(change: NotebookChange): HTMLElement {
    const row = h('div', { class: `notebook-change is-${change.kind}` });
    row.appendChild(
      h(
        'div',
        { class: 'notebook-change-head' },
        h('span', { class: 'notebook-change-status' }, statusLabel(change.kind)),
        h('span', { class: 'notebook-change-kind' }, cellKindLabel(change.cellKind)),
      ),
    );
    if (change.kind === 'changed') {
      for (const line of change.lines) {
        if (line.kind === 'equal') continue;
        row.appendChild(
          h('pre', { class: `notebook-line is-${line.kind}` }, `${line.kind === 'removed' ? '−' : '+'} ${line.text}`),
        );
      }
    } else {
      const text = (change.kind === 'added' ? change.after : change.before) ?? '';
      row.appendChild(h('pre', { class: 'notebook-source' }, text.replace(/\n$/, '')));
    }
    return row;
  }

  function renderDiff(before: Notebook, after: Notebook): void {
    const diff = diffNotebooks(before, after);
    clear(body);
    if (diff.added + diff.removed + diff.changed === 0) {
      note('Ячейки совпадают с версией из HEAD: отличий нет.');
      return;
    }
    body.appendChild(
      h(
        'div',
        { class: 'notebook-diff-summary' },
        `Изменено: ${diff.changed} · добавлено: ${diff.added} · удалено: ${diff.removed}`,
      ),
    );
    for (const change of diff.changes) {
      if (change.kind !== 'equal') body.appendChild(renderChange(change));
    }
  }

  async function compareWithHead(): Promise<void> {
    const path = deps.activePath();
    if (!path) return;
    compareButton.disabled = true;
    try {
      const headText = await deps.readHead(path).catch(() => null);
      const currentText = deps.readText(path);
      if (headText === null || currentText === null) {
        note('Сравнить не с чем: файл не в репозитории git или версии в HEAD ещё нет.');
        return;
      }
      const after = parseNotebook(currentText);
      const before = parseNotebook(headText);
      if (after.error || before.error) {
        note(after.error ?? before.error ?? 'Не удалось разобрать ноутбук.');
        return;
      }
      showingDiff = true;
      comparedPath = path;
      comparedNotebook = before;
      renderDiff(before, after);
    } finally {
      compareButton.disabled = false;
    }
  }

  const render = (): void => {
    const path = deps.activePath();
    compareButton.hidden = true;
    if (!path) {
      pathLabel.textContent = '';
      summary.textContent = '';
      note('Файл не открыт: панель показывает ячейки активного ноутбука.');
      return;
    }
    pathLabel.textContent = deps.relativePath(path);
    if (!isNotebookPath(path)) {
      summary.textContent = '';
      note('Активный файл — не ноутбук. Откройте файл .ipynb, чтобы увидеть ячейки.');
      return;
    }
    const text = deps.readText(path) ?? '';
    const notebook = parseNotebook(text);
    if (notebook.error) {
      summary.textContent = '';
      note(notebook.error);
      return;
    }
    summary.textContent = notebookSummary(notebook);
    compareButton.hidden = false;

    // Вернулись к тому же файлу — показываем прежнее сравнение, а не сбрасываем его.
    if (showingDiff && comparedPath === path && comparedNotebook) {
      renderDiff(comparedNotebook, notebook);
      return;
    }
    renderCells(notebook);
  };

  compareButton.addEventListener('click', () => void compareWithHead());

  return {
    element,
    refresh: () => {
      // Показ вкладки — новый взгляд на файл: сравнение с прошлого раза не сохраняем.
      showingDiff = false;
      comparedPath = null;
      comparedNotebook = null;
      render();
    },
  };
}

/** Подпись у ячейки: `[7]` для исполненного кода, `[ ]` для неисполненного, `md` для markdown. */
function cellLabel(cell: NotebookCell): string {
  if (cell.kind === 'markdown') return 'md';
  if (cell.kind === 'raw') return 'raw';
  return cell.executionCount === null ? '[ ]' : `[${cell.executionCount}]`;
}

function cellKindLabel(kind: NotebookCell['kind']): string {
  if (kind === 'markdown') return 'markdown';
  if (kind === 'raw') return 'raw';
  return 'код';
}

function statusLabel(kind: NotebookChange['kind']): string {
  if (kind === 'added') return 'Добавлено';
  if (kind === 'removed') return 'Удалено';
  if (kind === 'changed') return 'Изменено';
  return 'Без изменений';
}
