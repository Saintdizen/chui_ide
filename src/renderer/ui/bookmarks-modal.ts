import { bookmarkLabel, countBookmarks, type BookmarkRecord } from '../../shared/bookmarks';
import { nameOf } from '../../shared/paths';
import type { BookmarkModel } from '../core/bookmarks';
import { clear, h, svgIcon } from './dom';

export interface BookmarksModalDeps {
  bookmarks: BookmarkModel;
  /** Корень проекта: по нему путь в списке показывается коротким. */
  root: () => string | null;
  /** Перейти к закладке: открыть файл и встать на строку. */
  reveal: (path: string, line: number) => void;
}

export interface BookmarksModalView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/**
 * Список закладок проекта: файл, а под ним — строки. Клик по строке ведёт к месту,
 * крестик снимает закладку, «Убрать все» чистит список целиком.
 *
 * Источник истины — модель (`core/bookmarks.ts`): окно только показывает её и просит
 * изменить. Пока окно открыто, оно перерисовывается по её событию: закладку можно
 * снять и отсюда, и значком в редакторе — список должен совпадать с обоими.
 */
export function createBookmarksModal(deps: BookmarksModalDeps): BookmarksModalView {
  const summary = h('span', { class: 'bookmarks-summary' });
  const list = h('div', { class: 'bookmarks-list' });

  const close = (): void => {
    element.hidden = true;
  };

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 15),
  );

  const clearButton = h(
    'button',
    {
      class: 'btn btn-small is-danger',
      type: 'button',
      title: 'Снять все закладки проекта',
      onClick: () => clearAll(),
    },
    'Убрать все',
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal bookmarks-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Закладки' },
      h('header', { class: 'modal-header' }, h('span', { class: 'modal-title' }, 'Закладки'), closeButton),
      h('div', { class: 'modal-body' }, h('div', { class: 'bookmarks-toolbar' }, summary), list),
      h('div', { class: 'bookmarks-actions' }, clearButton),
    ),
  );

  document.addEventListener('keydown', (event) => {
    if (!element.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  /** Одна строка закладки. */
  const row = (record: BookmarkRecord): HTMLElement => {
    const line = h(
      'button',
      {
        class: 'bookmarks-row',
        type: 'button',
        title: bookmarkLabel(record, deps.root()),
        onClick: () => {
          deps.reveal(record.path, record.line);
          close();
        },
      },
      h('span', { class: 'bookmarks-line' }, `стр. ${record.line}`),
    );
    line.append(
      h(
        'button',
        {
          class: 'icon-btn bookmarks-remove',
          type: 'button',
          title: 'Снять закладку',
          onClick: (event: Event) => {
            // Крестик не должен заодно вести к закладке: клик по строке — переход.
            event.stopPropagation();
            deps.bookmarks.remove(record.path, record.line);
          },
        },
        svgIcon('close', 12),
      ),
    );
    return h('div', { class: 'bookmarks-item' }, line);
  };

  const render = (): void => {
    clear(list);
    const records = deps.bookmarks.all;
    summary.textContent =
      records.length === 0
        ? 'Закладок нет'
        : `Всего: ${countBookmarks(records)} · файлов: ${deps.bookmarks.files().length}`;
    if (records.length === 0) {
      list.append(
        h(
          'p',
          { class: 'bookmarks-empty' },
          'Закладку ставят на строку командой «Закладки: поставить или снять» (Ctrl+Alt+K) ' +
            'или кликом по закладке в поле слева.',
        ),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const path of deps.bookmarks.files()) {
      fragment.append(h('div', { class: 'bookmarks-file', title: path }, nameOf(path)));
      for (const record of records) {
        if (record.path !== path) continue;
        fragment.append(row(record));
      }
    }
    list.append(fragment);
  };

  function clearAll(): void {
    for (const path of deps.bookmarks.files()) deps.bookmarks.clearFile(path);
  }

  // Список открыт — держим его в согласии с моделью: закладку могли снять значком.
  deps.bookmarks.onDidChange(() => {
    if (!element.hidden) render();
  });

  return {
    element,
    close,
    open() {
      element.hidden = false;
      render();
    },
  };
}
