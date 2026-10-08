import type { DiffEditorHandle } from '../core/editor-service';
import type { GitModel } from '../core/git-model';
import { languageFromPath } from '../core/languages';
import { h, svgIcon } from './dom';

export interface DiffViewDeps {
  /** Фабрика сравнения: Monaco остаётся за editor-service, здесь только тексты. */
  createDiff: (container: HTMLElement) => DiffEditorHandle;
  git: GitModel;
}

export interface DiffView {
  element: HTMLElement;
  /** Показать сравнение файла; `staged` — индекс против HEAD. */
  open(path: string, staged: boolean): Promise<void>;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * Экран сравнения поверх редактора: шапка с названием файла и сам diff.
 *
 * Это не вкладка: вкладки принадлежат открытым документам, а сравнение —
 * временный экран, который закрывается кнопкой или Escape. Так сравнение
 * не мешает модели документов и не требует «виртуальных» файлов.
 */
export function createDiffView(deps: DiffViewDeps): DiffView {
  const title = h('span', { class: 'diff-title' });
  const subtitle = h('span', { class: 'diff-subtitle' });
  const body = h('div', { class: 'diff-body' });

  let handle: DiffEditorHandle | null = null;
  let open = false;

  const close = (): void => {
    open = false;
    element.hidden = true;
    handle?.dispose();
    handle = null;
  };

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 14),
  );
  const header = h('div', { class: 'diff-header' }, svgIcon('file', 14), title, subtitle, closeButton);
  const element = h('div', { class: 'diff-view' }, header, body);
  element.hidden = true;

  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') close();
  });

  return {
    element,
    get isOpen() {
      return open;
    },
    close,
    async open(path, staged) {
      const diff = await deps.git.diff(path, staged);
      title.textContent = path.split('/').pop() ?? path;
      title.title = path;
      subtitle.textContent = staged ? 'индекс против HEAD' : 'рабочее дерево против индекса';
      subtitle.title = staged
        ? 'Показаны правки, которые уйдут в коммит'
        : 'Показаны правки, которых в индексе ещё нет';

      open = true;
      element.hidden = false;
      // Редактор создаём уже видимым: Monaco измеряет контейнер при создании,
      // а у скрытого контейнера ширина нулевая.
      if (!handle) handle = deps.createDiff(body);
      handle.set({ language: languageFromPath(path), original: diff.original, modified: diff.modified });
    },
  };
}
