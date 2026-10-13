import { historyEntryLabel, type HistoryEntry } from '../../shared/file-history';
import { nameOf } from '../../shared/paths';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';

export interface HistoryModalDeps {
  rpc: RpcClient;
  /** Вернуть содержимое снимка в файл: пишет документ и сохраняет его. */
  restore(path: string, text: string): Promise<void>;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface HistoryModalView {
  element: HTMLElement;
  open(path: string): Promise<void>;
  close(): void;
}

/** Сколько символов снимка показываем в предпросмотре: окно — не редактор. */
const PREVIEW_CHARS = 6000;

/**
 * Локальная история файла: снимки содержимого, снятые при сохранении (и при удалении).
 *
 * Список слева — версии, новые в начале; справа — предпросмотр выбранной и кнопка
 * возврата. Возврат идёт через тот же путь, что и любая правка документа (см. app.ts):
 * он кладёт текст в открытый документ и сохраняет его, поэтому возврат попадает в
 * undo редактора и сам становится снимком — вернуться назад можно снова.
 */
export function createHistoryModal(deps: HistoryModalDeps): HistoryModalView {
  let path = '';
  let entries: HistoryEntry[] = [];
  /** Выбранный снимок и его ПОЛНЫЙ текст: предпросмотр может быть обрезан, возврат — нет. */
  let selected: { entry: HistoryEntry; text: string } | null = null;
  let busy = false;

  const summary = h('span', { class: 'history-summary' });
  const list = h('div', { class: 'history-list' });
  const preview = h('pre', { class: 'history-preview' });

  const restoreButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', disabled: true, onClick: () => void restore() },
    'Вернуть эту версию',
  );
  const clearButton = h(
    'button',
    {
      class: 'btn btn-small is-danger',
      type: 'button',
      title: 'Убрать все снимки этого файла',
      onClick: () => void clearAll(),
    },
    'Очистить историю',
  );

  const close = (): void => {
    element.hidden = true;
  };

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 15),
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal history-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Локальная история' },
      h('header', { class: 'modal-header' }, h('span', { class: 'modal-title' }, 'Локальная история'), closeButton),
      h(
        'div',
        { class: 'modal-body' },
        h('div', { class: 'history-toolbar' }, svgIcon('revert', 14), summary),
        h('div', { class: 'history-body' }, list, h('div', { class: 'history-detail' }, preview)),
        h('div', { class: 'history-actions' }, clearButton, restoreButton),
      ),
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

  const renderList = (): void => {
    clear(list);
    if (entries.length === 0) {
      list.append(h('p', { class: 'history-empty' }, 'Снимков пока нет. Они появятся при следующем сохранении файла.'));
      return;
    }
    const now = Date.now();
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const row = h(
        'button',
        {
          class: `history-row${entry.id === selected?.entry.id ? ' is-active' : ''}`,
          type: 'button',
          title: entry.path,
          onClick: () => void select(entry),
        },
        h('span', { class: 'history-row-name' }, entry.name),
        h('span', { class: 'history-row-label' }, historyEntryLabel(entry, now)),
      );
      fragment.append(row);
    }
    list.append(fragment);
  };

  const renderPreview = (): void => {
    if (!selected) {
      preview.textContent = 'Выберите версию слева.';
      restoreButton.disabled = true;
      return;
    }
    const truncated = selected.text.length > PREVIEW_CHARS;
    preview.textContent = truncated
      ? `${selected.text.slice(0, PREVIEW_CHARS)}\n… (показана часть версии)`
      : selected.text;
    restoreButton.disabled = false;
  };

  async function select(entry: HistoryEntry): Promise<void> {
    selected = { entry, text: '' };
    renderList();
    preview.textContent = 'Читаю версию…';
    try {
      const { text } = await deps.rpc.request('history.read', { path, id: entry.id });
      // Пока читали, могли выбрать другую версию или открыть другой файл.
      if (selected?.entry.id !== entry.id) return;
      selected = { entry, text };
      renderPreview();
    } catch (error) {
      if (selected?.entry.id !== entry.id) return;
      selected = null;
      renderPreview();
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  const reload = async (): Promise<void> => {
    entries = await deps.rpc.request('history.list', { path });
    if (selected && !entries.some((entry) => entry.id === selected?.entry.id)) selected = null;
    renderList();
    renderPreview();
  };

  async function restore(): Promise<void> {
    if (busy || !selected) return;
    busy = true;
    restoreButton.disabled = true;
    try {
      await deps.restore(path, selected.text);
      deps.notify('Вернул выбранную версию');
      selected = null;
      await reload();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
      renderPreview();
    } finally {
      busy = false;
    }
  }

  async function clearAll(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await deps.rpc.request('history.clear', { path });
      selected = null;
      await reload();
      deps.notify('История файла очищена');
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  return {
    element,
    close,
    async open(filePath) {
      // Путь мог прийти откуда угодно (меню дерева, команда) — берём строку как есть.
      if (typeof filePath !== 'string' || filePath === '') return;
      path = filePath;
      entries = [];
      selected = null;
      element.hidden = false;
      summary.textContent = nameOf(filePath);
      list.replaceChildren(h('p', { class: 'history-empty' }, 'Читаю историю…'));
      preview.textContent = '';
      restoreButton.disabled = true;
      try {
        await reload();
      } catch (error) {
        list.replaceChildren(h('p', { class: 'history-empty' }, 'Не удалось прочитать историю.'));
        deps.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  };
}
