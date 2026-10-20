/**
 * Предпросмотр документа Office (.docx, .xlsx) там, где обычно текст.
 *
 * Это не редактор: документ — zip с XML, и в буфере редактора оказался бы бинарь.
 * Экран ложится поверх области редактора тем же приёмом, что вьюер картинок и
 * предпросмотр разметки. Вкладку заводит приложение (документ-заглушка), поэтому
 * полоса вкладок, дерево и статусбар ведут себя как с обычным файлом.
 *
 * Читает и разбирает main (`workspace.readOffice`): renderer файловой системы не
 * видит, да и распаковка с разбором — работа для main. Прочитанное помним по пути:
 * переключение вкладок не должно гонять через IPC один и тот же документ.
 */

import { officeFormatLabel, officeSummary, type OfficeBlock, type OfficePreview } from '../../shared/office';
import type { RpcClient } from '../core/rpc';
import { basename, clear, h, svgIcon } from './dom';

export interface DocView {
  element: HTMLElement;
  /** Показать документ. Уже прочитанный не читается заново. */
  show(path: string): void;
  hide(): void;
  /** Открыт ли сейчас документ (а не пустой экран). */
  readonly isOpen: boolean;
  /** Что показано — чтобы не перечитывать тот же документ. */
  readonly path: string | null;
  /** Забыть прочитанное: файл закрыли или он изменился. */
  forget(path: string): void;
  /** Перечитать с диска: файл изменился снаружи. */
  refresh(path: string): void;
}

export interface DocViewDeps {
  rpc: RpcClient;
  /** Сообщить о сбое чтения (нет файла, слишком большой, архив повреждён). */
  notify: (message: string) => void;
}

/** Ячейка таблицы: обычный текст, без разметки — чужой документ её не приносит. */
function textCell(tag: 'td' | 'th', value: string): HTMLElement {
  const cell = h(tag, { class: 'doc-cell' }, value);
  // Длинный текст в ячейке не должен распирать таблицу: подсказка покажет его целиком.
  cell.title = value.length > 60 ? value : '';
  return cell;
}

/** Таблица документа: строки без заголовка — у docx заголовка нет вовсе. */
function renderTable(rows: readonly string[][]): HTMLElement {
  const table = h('table', { class: 'doc-table' });
  for (const row of rows) {
    const line = h('tr');
    for (const value of row) line.appendChild(textCell('td', value));
    table.appendChild(line);
  }
  return h('div', { class: 'doc-table-wrap' }, table);
}

/** Блоки документа: заголовки, абзацы, списки и таблицы — в том же порядке, что в файле. */
function renderBlocks(blocks: readonly OfficeBlock[]): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      nodes.push(h('div', { class: `doc-heading is-level-${block.level}` }, block.text));
    } else if (block.kind === 'list') {
      nodes.push(h('div', { class: 'doc-list-item' }, block.text));
    } else if (block.kind === 'table') {
      nodes.push(renderTable(block.rows));
    } else {
      nodes.push(h('p', { class: 'doc-paragraph' }, block.text));
    }
  }
  return nodes;
}

export function createDocView(deps: DocViewDeps): DocView {
  const title = h('span', { class: 'doc-title' });
  const meta = h('span', { class: 'doc-meta' });
  const sheetRow = h('div', { class: 'doc-sheets', hidden: true });
  const body = h('div', { class: 'doc-body' });
  const element = h(
    'div',
    { class: 'doc-view', hidden: true },
    h('div', { class: 'doc-header' }, svgIcon('file', 14), title, meta, h('div', { class: 'doc-header-spacer' })),
    h('div', { class: 'doc-surface' }, sheetRow, body),
  );

  /** Прочитанные документы по пути: переключение вкладок не гоняет IPC заново. */
  const cache = new Map<string, OfficePreview>();
  let open = false;
  let currentPath: string | null = null;
  let activeSheet = 0;

  const note = (text: string): void => {
    clear(body);
    body.appendChild(h('div', { class: 'empty-note' }, h('p', {}, text)));
  };

  /** Нарисовать готовый к показу документ: блоки или листы книги. */
  const paint = (preview: OfficePreview): void => {
    clear(body);
    clear(sheetRow);
    if (preview.kind === 'docx') {
      sheetRow.hidden = true;
      if (preview.blocks.length === 0) {
        note('В документе нет текста — возможно, он состоит из одних картинок.');
        return;
      }
      for (const node of renderBlocks(preview.blocks)) body.appendChild(node);
      return;
    }

    // Листы: один — переключать нечего, кнопки не нужны.
    sheetRow.hidden = preview.sheets.length <= 1;
    for (const [index, sheet] of preview.sheets.entries()) {
      sheetRow.appendChild(
        h(
          'button',
          {
            class: `btn btn-small doc-sheet${index === activeSheet ? ' is-active' : ''}`,
            type: 'button',
            title: `Лист «${sheet.name}»`,
            onClick: () => {
              activeSheet = index;
              paint(preview);
            },
          },
          sheet.name,
        ),
      );
    }

    const sheet = preview.sheets[Math.min(activeSheet, preview.sheets.length - 1)];
    if (sheet === undefined) {
      note('В книге нет листов.');
      return;
    }
    if (sheet.rows.length === 0) {
      note(`Лист «${sheet.name}» пуст.`);
      return;
    }
    body.appendChild(renderTable(sheet.rows));
  };

  const render = (path: string, preview: OfficePreview): void => {
    currentPath = path;
    open = true;
    element.hidden = false;
    title.textContent = basename(path);
    title.title = path;
    meta.textContent = officeSummary(preview);
    paint(preview);
  };

  const fail = (path: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    deps.notify(`Не удалось открыть документ: ${basename(path)} — ${message}`);
    currentPath = path;
    open = true;
    element.hidden = false;
    title.textContent = basename(path);
    title.title = path;
    meta.textContent = officeFormatLabel(path);
    sheetRow.hidden = true;
    // Пустоты не показываем: иначе непонятно, сломалось или документ правда пуст.
    note('Документ не прочитан. Откройте его внешней программой — причина в уведомлении.');
  };

  const load = (path: string): void => {
    void deps.rpc
      .request('workspace.readOffice', { path })
      .then((preview) => {
        cache.set(path, preview);
        // Пока читали, могли переключиться на другую вкладку — тогда не подменяем.
        if (currentPath === path) render(path, preview);
      })
      .catch((error: unknown) => {
        cache.delete(path);
        if (currentPath === path) fail(path, error);
      });
  };

  return {
    element,
    get isOpen(): boolean {
      return open;
    },
    get path(): string | null {
      return currentPath;
    },
    show(path: string): void {
      currentPath = path;
      open = true;
      element.hidden = false;
      activeSheet = 0;
      const cached = cache.get(path);
      if (cached !== undefined) {
        render(path, cached);
        return;
      }
      title.textContent = basename(path);
      title.title = path;
      meta.textContent = officeFormatLabel(path);
      sheetRow.hidden = true;
      note('Читаю документ…');
      load(path);
    },
    hide(): void {
      element.hidden = true;
      open = false;
    },
    forget(path: string): void {
      cache.delete(path);
      if (currentPath === path) currentPath = null;
    },
    refresh(path: string): void {
      cache.delete(path);
      if (currentPath === path) load(path);
    },
  };
}
