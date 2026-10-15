import type { GitCommit } from '../../shared/api';
import type { HistoryEntry } from '../../shared/file-history';
import { nameOf } from '../../shared/paths';
import { mergeTimeline, timelineActionLabel, timelineSummary, type TimelineItem } from '../../shared/timeline';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';

export interface HistoryModalDeps {
  rpc: RpcClient;
  /** Вернуть содержимое снимка в файл: пишет документ и сохраняет его. */
  restore(path: string, text: string): Promise<void>;
  /** Коммиты файла из git — вторая половина ленты истории. */
  gitHistory(path: string): Promise<GitCommit[]>;
  /** Показать различие файла с коммитом — действие для записи из git. */
  openCommitDiff(path: string, hash: string): void;
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
 * История файла: локальные снимки и коммиты git ОДНОЙ лентой.
 *
 * Так было не всегда: снимки редактора и история git жили отдельными окнами, и
 * сопоставлять их приходилось на глаз — «а до моей правки что было: снимок час
 * назад или коммит вчера?». Лента ставит записи по времени, поэтому видно порядок
 * (см. `shared/timeline.ts`), а источник записи помечен в строке.
 *
 * Действия у записей разные, и это не мелочь: снимок — это ТЕКСТ, его можно
 * вернуть в файл (через тот же путь, что любая правка документа: возврат попадает
 * в undo и сам становится снимком), а коммит — состояние, с ним сравнивают текущий
 * файл. Поэтому кнопка действия меняет подпись по выбранной записи.
 */
export function createHistoryModal(deps: HistoryModalDeps): HistoryModalView {
  let path = '';
  let snapshots: HistoryEntry[] = [];
  let commits: GitCommit[] = [];
  let items: TimelineItem[] = [];
  /** Выбранная запись и её ПОЛНЫЙ текст (для снимка): предпросмотр может быть обрезан, возврат — нет. */
  let selected: { item: TimelineItem; text: string } | null = null;
  let busy = false;

  const summary = h('span', { class: 'history-summary' });
  const list = h('div', { class: 'history-list' });
  const preview = h('pre', { class: 'history-preview' });

  const actionButton = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Вернуть эту версию');
  actionButton.addEventListener('click', () => void runAction());

  const clearButton = h(
    'button',
    {
      class: 'btn btn-small is-danger',
      type: 'button',
      title: 'Убрать все снимки редактора по этому файлу (история git не трогается)',
      onClick: () => void clearAll(),
    },
    'Очистить снимки',
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
      { class: 'modal history-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'История файла' },
      h('header', { class: 'modal-header' }, h('span', { class: 'modal-title' }, 'История файла'), closeButton),
      h(
        'div',
        { class: 'modal-body' },
        h('div', { class: 'history-toolbar' }, svgIcon('revert', 14), summary),
        h('div', { class: 'history-body' }, list, h('div', { class: 'history-detail' }, preview)),
        h('div', { class: 'history-actions' }, clearButton, actionButton),
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
    if (items.length === 0) {
      list.append(
        h(
          'p',
          { class: 'history-empty' },
          'Записей нет: снимки появятся при следующем сохранении, коммиты — после первого коммита файла.',
        ),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = h(
        'button',
        {
          class: `history-row is-${item.source}${item.id === selected?.item.id ? ' is-active' : ''}`,
          type: 'button',
          title: item.source === 'git' ? `Коммит ${item.id}` : path,
          onClick: () => void select(item),
        },
        // Источник помечен буквой: по ней видно, снимок это или коммит, и что с ним можно сделать.
        h(
          'span',
          {
            class: `history-row-source is-${item.source}`,
            title: item.source === 'git' ? 'Коммит git' : 'Снимок редактора',
          },
          item.source === 'git' ? 'git' : 'снимок',
        ),
        h('span', { class: 'history-row-name' }, item.title),
        h('span', { class: 'history-row-label' }, item.detail),
      );
      fragment.append(row);
    }
    list.append(fragment);
  };

  const renderPreview = (): void => {
    if (!selected) {
      preview.textContent = 'Выберите запись слева.';
      actionButton.disabled = true;
      actionButton.textContent = 'Вернуть эту версию';
      return;
    }
    actionButton.textContent = timelineActionLabel(selected.item);
    actionButton.disabled = false;
    if (selected.item.source === 'git') {
      preview.textContent =
        `Коммит ${selected.item.id}\n${selected.item.title.replace(/^\S+ · /, '')}\n\n` +
        'Это состояние файла в истории git. Различие с текущим текстом откроется отдельным экраном ' +
        'сравнения — вернуть коммит в файл из ленты нельзя (git это умеет своими средствами, ' +
        'например `git checkout <коммит> -- <файл>`).';
      return;
    }
    const truncated = selected.text.length > PREVIEW_CHARS;
    preview.textContent = truncated
      ? `${selected.text.slice(0, PREVIEW_CHARS)}\n… (показана часть версии)`
      : selected.text;
  };

  async function select(item: TimelineItem): Promise<void> {
    selected = { item, text: '' };
    renderList();
    if (item.source === 'git' || !item.entry) {
      renderPreview();
      return;
    }
    preview.textContent = 'Читаю версию…';
    try {
      const { text } = await deps.rpc.request('history.read', { path, id: item.entry.id });
      // Пока читали, могли выбрать другую версию или открыть другой файл.
      if (selected?.item.id !== item.id) return;
      selected = { item, text };
      renderPreview();
    } catch (error) {
      if (selected?.item.id !== item.id) return;
      selected = null;
      renderPreview();
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  const reload = async (): Promise<void> => {
    snapshots = await deps.rpc.request('history.list', { path });
    // История git может быть недоступна (файл не в репозитории) — это не ошибка
    // окна: лента останется со снимками.
    commits = await deps.gitHistory(path).catch(() => []);
    items = mergeTimeline(snapshots, commits);
    if (selected && !items.some((item) => item.id === selected?.item.id)) selected = null;
    summary.textContent = `${nameOf(path)} · ${timelineSummary(items)}`;
    renderList();
    renderPreview();
  };

  /** Действие по выбранной записи: у снимка и коммита оно своё. */
  async function runAction(): Promise<void> {
    if (busy || !selected) return;
    if (selected.item.source === 'git' && selected.item.hash) {
      deps.openCommitDiff(path, selected.item.hash);
      return;
    }
    busy = true;
    actionButton.disabled = true;
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
      deps.notify('Снимки файла очищены');
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
      snapshots = [];
      commits = [];
      items = [];
      selected = null;
      element.hidden = false;
      summary.textContent = nameOf(filePath);
      list.replaceChildren(h('p', { class: 'history-empty' }, 'Читаю историю…'));
      preview.textContent = '';
      actionButton.disabled = true;
      try {
        await reload();
      } catch (error) {
        list.replaceChildren(h('p', { class: 'history-empty' }, 'Не удалось прочитать историю.'));
        deps.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  };
}
