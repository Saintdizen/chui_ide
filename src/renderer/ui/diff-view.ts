import type { GitDiff, GitDiffHunk } from '../../shared/api';
import type { DiffEditorHandle } from '../core/editor-service';
import type { GitModel } from '../core/git-model';
import { languageFromPath } from '../core/languages';
import { h, svgIcon } from './dom';

export interface DiffViewDeps {
  /** Фабрика сравнения: Monaco остаётся за editor-service, здесь только тексты. */
  createDiff: (container: HTMLElement) => DiffEditorHandle;
  git: GitModel;
  /** Сообщить о сбое операции с блоком (например, патч не приложился). */
  notify?: (message: string) => void;
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
 *
 * У каждого блока изменений есть кнопка «проиндексировать блок» (в режиме
 * индекса — «убрать из индекса»): так в индекс уходит отдельная правка, а не
 * файл целиком. Границы блоков приходят от main вместе с текстами — из того же
 * diff, что прикладывает `git apply`, поэтому номера блоков совпадают.
 */
export function createDiffView(deps: DiffViewDeps): DiffView {
  const title = h('span', { class: 'diff-title' });
  const subtitle = h('span', { class: 'diff-subtitle' });
  const body = h('div', { class: 'diff-body' });

  let handle: DiffEditorHandle | null = null;
  let open = false;
  /** Что показано сейчас: после правки перерисовываем тот же diff. */
  let current: { path: string; staged: boolean } | null = null;
  /** Идёт операция с блоком: повторное нажатие не должно запускать её снова. */
  let busy = false;

  const close = (): void => {
    open = false;
    element.hidden = true;
    handle?.dispose();
    handle = null;
    current = null;
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

  /** Проиндексировать блок или убрать его из индекса, затем перерисовать сравнение. */
  const applyHunk = async (index: number): Promise<void> => {
    if (!current || busy) return;
    busy = true;
    const { path, staged } = current;
    try {
      if (staged) await deps.git.unstageHunk(path, index);
      else await deps.git.stageHunk(path, index);
    } catch (error) {
      deps.notify?.(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
    // Правки в индексе изменились — сравнение и блоки нужно построить заново.
    if (current) await render(current.path, current.staged);
  };

  /** Нарисовать блоки: у каждого кнопка, ведущая в `applyHunk` по его номеру. */
  const drawHunks = (hunks: readonly GitDiffHunk[]): void => {
    if (!handle) return;
    const label = current?.staged ? 'Убрать из индекса' : 'Проиндексировать блок';
    handle.setHunkActions(
      hunks.map((hunk, index) => ({ index, line: hunk.newStart, label })),
      (index) => void applyHunk(index),
    );
  };

  const render = async (path: string, staged: boolean): Promise<void> => {
    let diff: GitDiff;
    try {
      diff = await deps.git.diff(path, staged);
    } catch {
      // Правок больше нет — например, проиндексировали последний блок. Скажем это
      // прямо: пустое сравнение выглядело бы как сбой.
      title.textContent = path.split('/').pop() ?? path;
      subtitle.textContent = 'изменений нет';
      handle?.set({ language: languageFromPath(path), original: '', modified: '' });
      return;
    }

    title.textContent = path.split('/').pop() ?? path;
    title.title = path;
    subtitle.textContent = staged ? 'индекс против HEAD' : 'рабочее дерево против индекса';
    subtitle.title = staged ? 'Показаны правки, которые уйдут в коммит' : 'Показаны правки, которых в индексе ещё нет';

    // Редактор создаём уже видимым: Monaco измеряет контейнер при создании,
    // а у скрытого контейнера ширина нулевая.
    if (!handle) handle = deps.createDiff(body);
    handle.set({ language: languageFromPath(path), original: diff.original, modified: diff.modified });
    drawHunks(diff.hunks);
  };

  return {
    element,
    get isOpen() {
      return open;
    },
    close,
    async open(path, staged) {
      current = { path, staged };
      open = true;
      element.hidden = false;
      await render(path, staged);
    },
  };
}
