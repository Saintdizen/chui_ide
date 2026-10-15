import type { GitDiff, GitDiffHunk } from '../../shared/api';
import type { OwnDiffHandle, DiffSide } from '../editor/host/diff-editor';
import type { GitModel } from '../core/git-model';
import type { ReviewModel } from '../core/review-model';
import type { ReviewThread } from '../../shared/review';
import { REVIEW_LOCAL_AUTHOR, reviewSummary } from '../../shared/review';
import { compareLabel } from '../core/file-compare';
import { languageFromPath } from '../core/languages';
import { h, svgIcon } from './dom';

export interface DiffViewDeps {
  /** Фабрика сравнения: движок приходит извне, здесь только тексты. */
  createDiff: (container: HTMLElement) => OwnDiffHandle;
  git: GitModel;
  /** Прочитать файл для сравнения двух произвольных файлов (не из git). */
  readText: (path: string) => Promise<string>;
  /** Замечания к коду текущего проекта: их показывает и правит экран сравнения. */
  reviews: ReviewModel;
  /** Сообщить о сбое операции с блоком (например, патч не приложился). */
  notify?: (message: string) => void;
}

export interface DiffView {
  element: HTMLElement;
  /**
   * Показать сравнение файла. `staged` — индекс против HEAD; `commit` — рабочее
   * дерево против названного коммита (просмотр истории, блоки не индексируются).
   */
  open(path: string, staged: boolean, commit?: string): Promise<void>;
  /**
   * Показать файл между двумя ссылками (ветками, коммитами): слева `base`, справа
   * `head`. Это просмотр — части правки индексировать нечего, кнопок у блоков нет.
   */
  openRefs(base: string, head: string, path: string): Promise<void>;
  /**
   * Показать различие двух файлов из дерева. Это просмотр: файлы не из git,
   * индексировать нечего, поэтому блоки без кнопок.
   */
  openFiles(left: string, right: string): Promise<void>;
  /** Показать ленту замечаний (кнопка в шапке и команда палитры). */
  showComments(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Что показано сейчас: после правки перерисовываем тот же diff. */
interface DiffTarget {
  path: string;
  staged: boolean;
  /** Коммит для просмотра истории; нет — обычное рабочее сравнение. */
  commit?: string;
  /** Сравнение двух ссылок: слева `refs.base`, справа `refs.head`. */
  refs?: { base: string; head: string };
  /** Сравнение двух файлов из дерева: слева `filePair.left`, справа `filePair.right`. */
  filePair?: { left: string; right: string };
}

/** Новое замечание, которое человек ещё набирает. */
interface CommentDraft {
  side: DiffSide;
  line: number;
}

/**
 * Экран сравнения поверх редактора: шапка с названием файла, сам diff и лента
 * замечаний справа.
 *
 * Это не вкладка: вкладки принадлежат открытым документам, а сравнение —
 * временный экран, который закрывается кнопкой или Escape. Так сравнение
 * не мешает модели документов и не требует «виртуальных» файлов.
 *
 * У каждого блока изменений есть кнопка «проиндексировать блок» (в режиме
 * индекса — «убрать из индекса»): так в индекс уходит отдельная правка, а не
 * файл целиком. Границы блоков приходят от main вместе с текстами — из того же
 * diff, что прикладывает `git apply`, поэтому номера блоков совпадают.
 *
 * Ревью — вторая работа этого экрана: у строки можно оставить замечание, в треде
 * ведутся ответы, тред помечается решённым. Замечание живёт в модели (`ReviewModel`),
 * а не в сравнении: тот же файл, показанный в другом сравнении, замечания сохраняет.
 */
export function createDiffView(deps: DiffViewDeps): DiffView {
  const title = h('span', { class: 'diff-title' });
  const subtitle = h('span', { class: 'diff-subtitle' });
  const body = h('div', { class: 'diff-body' });

  let handle: OwnDiffHandle | null = null;
  let open = false;
  /** Что показано сейчас: после правки перерисовываем тот же diff. */
  let current: DiffTarget | null = null;
  /** Тексты открытого сравнения: из них берём строку-ориентир для замечания. */
  let currentDiff: GitDiff | null = null;
  /** Идёт операция с блоком: повторное нажатие не должно запускать её снова. */
  let busy = false;
  /** Режим сравнения: рядом или одним столбцом. Помнится между открытиями. */
  let sideBySide = true;
  /** Открытый тред: его строка подсвечена, его карточка помечена в ленте. */
  let activeThread: string | null = null;
  /** Новое замечание, набираемое сейчас. */
  let draft: CommentDraft | null = null;
  /** Показывать ли решённые замечания в ленте. */
  let showResolved = true;
  /** Видна ли колонка замечаний. */
  let panelVisible = false;

  const close = (): void => {
    open = false;
    element.hidden = true;
    handle?.dispose();
    handle = null;
    current = null;
    currentDiff = null;
    activeThread = null;
    draft = null;
  };

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 14),
  );

  // Навигация по блокам и режим отображения — действия экрана сравнения, поэтому
  // стоят в шапке рядом с закрытием, а не в самом редакторе.
  const prevButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Предыдущий блок (Alt+↑)',
      onClick: () => handle?.goToChange(-1),
    },
    svgIcon('chevronUp', 14),
  );
  const nextButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Следующий блок (Alt+↓)',
      onClick: () => handle?.goToChange(1),
    },
    svgIcon('chevronDown', 14),
  );
  const layoutButton = h('button', { class: 'icon-btn is-active', type: 'button' }, svgIcon('split', 14));
  const syncLayoutButton = (): void => {
    layoutButton.classList.toggle('is-active', sideBySide);
    layoutButton.title = sideBySide ? 'Показать одним столбцом' : 'Показать рядом';
  };
  layoutButton.addEventListener('click', () => {
    sideBySide = !sideBySide;
    handle?.setLayout(sideBySide);
    syncLayoutButton();
  });
  syncLayoutButton();

  const reviewButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Замечания к коду' },
    svgIcon('chat', 14),
  );
  reviewButton.addEventListener('click', () => setPanelVisible(!panelVisible));

  const headerActions = h(
    'div',
    { class: 'diff-actions' },
    prevButton,
    nextButton,
    layoutButton,
    reviewButton,
    closeButton,
  );
  const header = h('div', { class: 'diff-header' }, svgIcon('file', 14), title, subtitle, headerActions);

  // Лента замечаний: справа от сравнения, своей колонкой.
  const reviewList = h('div', { class: 'review-list' });
  const reviewSummaryText = h('span', { class: 'review-summary' });
  const resolvedToggle = h(
    'button',
    { class: 'review-toggle', type: 'button', title: 'Показывать решённые' },
    'решённые',
  );
  resolvedToggle.addEventListener('click', () => {
    showResolved = !showResolved;
    renderReviewPanel();
  });
  const clearResolved = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Убрать решённые замечания' },
    svgIcon('trash', 14),
  );
  clearResolved.addEventListener('click', () => {
    const path = current?.path;
    if (path) deps.reviews.clearResolved(path);
  });
  const reviewHead = h(
    'div',
    { class: 'review-head' },
    svgIcon('chat', 14),
    h('span', { class: 'review-title' }, 'Замечания'),
    reviewSummaryText,
    h('div', { class: 'review-head-actions' }, resolvedToggle, clearResolved),
  );
  const reviewPanel = h('aside', { class: 'diff-review' }, reviewHead, reviewList);
  reviewPanel.hidden = true;

  const main = h('div', { class: 'diff-main' }, body, reviewPanel);
  const element = h('div', { class: 'diff-view' }, header, main);
  element.hidden = true;

  function setPanelVisible(visible: boolean): void {
    panelVisible = visible;
    reviewPanel.hidden = !visible;
    reviewButton.classList.toggle('is-active', visible);
    // Колонка сравнения сузилась/расширилась — вьюпорт перемерит сам (ResizeObserver),
    // достаточно перерисовать ленту.
    renderReviewPanel();
  }

  /** Тред, открытый сейчас в ленте (`null` — ни один). */
  function activeThreadThread(): ReviewThread | null {
    if (!activeThread) return null;
    return deps.reviews.all.find((thread) => thread.id === activeThread) ?? null;
  }

  document.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      // Escape сперва закрывает набираемое замечание, и только потом сам экран.
      if (draft) {
        draft = null;
        renderReviewPanel();
        return;
      }
      close();
      return;
    }
    // Alt+↑/↓ — ходьба по блокам, как в других IDE. Без Alt стрелки не трогаем:
    // они принадлежат курсору, а он в сравнении тоже нужен.
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      handle?.goToChange(1);
    } else if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      handle?.goToChange(-1);
    }
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
    if (current) await render(current);
  };

  /**
   * Нарисовать блоки: у каждого кнопка, ведущая в `applyHunk` по его номеру.
   * В просмотре против коммита кнопок нет: часть правки относительно коммита
   * индексировать неотчего — индекс тут не при чём.
   */
  const drawHunks = (target: DiffTarget, hunks: readonly GitDiffHunk[]): void => {
    if (!handle) return;
    // Сравнение ссылок, файлов и просмотр коммита — это просмотр: индексировать нечего.
    if (target.commit || target.refs || target.filePair) {
      handle.setHunkActions(null, () => undefined);
      return;
    }
    const label = target.staged ? 'Убрать из индекса' : 'Проиндексировать блок';
    handle.setHunkActions(
      hunks.map((hunk, index) => ({ index, line: hunk.newStart, label })),
      (index) => void applyHunk(index),
    );
  };

  // — замечания ревью —

  /** Строка-ориентир: её текст на нужной стороне открытого сравнения. */
  const anchorAt = (side: DiffSide, line: number): string => {
    if (!currentDiff) return '';
    const text = side === 'original' ? currentDiff.original : currentDiff.modified;
    return text.split('\n')[line - 1] ?? '';
  };

  /** Показать тред: панель открывается, карточка помечается, строка подсвечивается. */
  const focusThread = (id: string): void => {
    activeThread = id;
    draft = null;
    setPanelVisible(true);
    const thread = activeThreadThread();
    if (thread) handle?.revealComment(thread.side, thread.line);
    renderReviewPanel();
  };

  /** Начать новое замечание к строке. */
  const startDraft = (side: DiffSide, line: number): void => {
    draft = { side, line };
    activeThread = null;
    setPanelVisible(true);
    renderReviewPanel();
  };

  /** Подпись строки: номер и на какой стороне сравнения. */
  const lineLabel = (side: DiffSide, line: number): string =>
    side === 'original' ? `строка ${line} → (было)` : `строка ${line} (стало)`;

  const formatTime = (ms: number): string => {
    if (!ms) return '';
    const date = new Date(ms);
    const two = (value: number): string => String(value).padStart(2, '0');
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
  };

  /** Карточка треда: место, сообщения и форма ответа. */
  const buildThread = (thread: ReviewThread): HTMLElement => {
    const card = h('article', { class: 'review-thread' });
    if (thread.id === activeThread) card.classList.add('is-active');
    if (thread.resolved) card.classList.add('is-resolved');

    const jump = h(
      'button',
      {
        class: 'review-jump',
        type: 'button',
        title: 'Показать эту строку в сравнении',
        onClick: () => {
          activeThread = thread.id;
          handle?.revealComment(thread.side, thread.line);
          renderReviewPanel();
        },
      },
      lineLabel(thread.side, thread.line),
    );

    const resolve = h(
      'button',
      {
        class: 'icon-btn review-resolve',
        type: 'button',
        title: thread.resolved ? 'Снова открыть' : 'Пометить решённым',
        onClick: () => deps.reviews.resolve(thread.id, !thread.resolved),
      },
      svgIcon('check', 13),
    );
    if (thread.resolved) resolve.classList.add('is-active');

    const remove = h(
      'button',
      {
        class: 'icon-btn review-delete',
        type: 'button',
        title: 'Удалить замечание',
        onClick: () => {
          if (activeThread === thread.id) activeThread = null;
          deps.reviews.remove(thread.id);
        },
      },
      svgIcon('trash', 13),
    );
    card.append(h('div', { class: 'review-thread-head' }, jump, resolve, remove));

    const comments = h('div', { class: 'review-comments' });
    for (const comment of thread.comments) {
      const author = comment.author === REVIEW_LOCAL_AUTHOR ? 'вы' : comment.author;
      comments.append(
        h(
          'div',
          { class: 'review-comment' },
          h(
            'div',
            { class: 'review-comment-head' },
            h('span', { class: 'review-author' }, author),
            h('span', { class: 'review-time' }, formatTime(comment.createdAt)),
          ),
          h('div', { class: 'review-text' }, comment.text),
        ),
      );
    }
    card.append(comments);

    const input = h('textarea', { class: 'review-input', rows: '2', placeholder: 'Ответить…' });
    const form = h(
      'form',
      {
        class: 'review-reply',
        onSubmit: (event: Event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (text === '') return;
          deps.reviews.reply(thread.id, text);
          input.value = '';
        },
      },
      input,
      h('button', { class: 'btn btn-small btn-primary', type: 'submit' }, 'Ответить'),
    );
    card.append(form);
    return card;
  };

  /** Форма нового замечания: место подписано, текст набирается здесь. */
  const buildDraft = (target: CommentDraft): HTMLElement => {
    const input = h('textarea', {
      class: 'review-input',
      rows: '3',
      placeholder: `Замечание: ${anchorAt(target.side, target.line).trim().slice(0, 60) || 'строка без текста'}`,
    });
    const form = h(
      'form',
      {
        class: 'review-draft',
        onSubmit: (event: Event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (text === '' || !current) return;
          const id = deps.reviews.add(current.path, target.side, target.line, anchorAt(target.side, target.line), text);
          draft = null;
          activeThread = id;
          renderReviewPanel();
        },
      },
      h('div', { class: 'review-draft-head' }, `Новое замечание — ${lineLabel(target.side, target.line)}`),
      input,
      h(
        'div',
        { class: 'review-draft-actions' },
        h('button', { class: 'btn btn-small btn-primary', type: 'submit' }, 'Добавить'),
        h(
          'button',
          {
            class: 'btn btn-small',
            type: 'button',
            onClick: () => {
              draft = null;
              renderReviewPanel();
            },
          },
          'Отмена',
        ),
      ),
    );
    // Поле появляется по клику на номер строки — сразу и берём фокус.
    setTimeout(() => input.focus(), 0);
    return form;
  };

  /** Перерисовать ленту замечаний и метки у строк сравнения. */
  const renderReviewPanel = (): void => {
    const path = current?.path ?? null;
    const threads = path ? deps.reviews.forFile(path) : [];
    const visible = threads.filter((thread) => showResolved || !thread.resolved);

    reviewSummaryText.textContent = reviewSummary(threads);
    resolvedToggle.classList.toggle('is-active', showResolved);
    clearResolved.hidden = !threads.some((thread) => thread.resolved);

    reviewList.replaceChildren();
    if (draft) reviewList.append(buildDraft(draft));
    if (visible.length === 0 && !draft) {
      reviewList.append(
        h(
          'div',
          { class: 'review-empty' },
          threads.length === 0
            ? 'Клик по номеру строки в сравнении — замечание к ней.'
            : 'Все замечания решены. Показать их — кнопкой «решённые».',
        ),
      );
    }
    for (const thread of visible) reviewList.append(buildThread(thread));

    // Метки у строк: по значку на тред с числом сообщений.
    const marks = threads.map((thread) => ({
      side: thread.side,
      line: thread.line,
      count: thread.comments.length,
      resolved: thread.resolved,
    }));
    const selectedThread = activeThreadThread();
    handle?.setComments({
      marks,
      selected: draft
        ? { side: draft.side, line: draft.line }
        : selectedThread
          ? { side: selectedThread.side, line: selectedThread.line }
          : null,
      onSelect: (side, line) => {
        const found = threads.find((thread) => thread.side === side && thread.line === line);
        if (found) focusThread(found.id);
        else startDraft(side, line);
      },
      onRequest: (side, line) => startDraft(side, line),
    });
  };

  deps.reviews.onDidChange(() => {
    if (open) renderReviewPanel();
  });

  const render = async (target: DiffTarget): Promise<void> => {
    const { path, staged, commit, refs, filePair } = target;
    let diff: GitDiff;
    try {
      if (filePair) {
        // Два файла читаем сразу: сравнение — это их тексты, без git.
        const [original, modified] = await Promise.all([deps.readText(filePair.left), deps.readText(filePair.right)]);
        diff = { original, modified, hunks: [] };
      } else {
        diff = refs ? await deps.git.diffRefs(refs.base, refs.head, path) : await deps.git.diff(path, staged, commit);
      }
    } catch {
      // Правок больше нет — например, проиндексировали последний блок. Скажем это
      // прямо: пустое сравнение выглядело бы как сбой.
      title.textContent = path.split('/').pop() ?? path;
      subtitle.textContent = 'изменений нет';
      currentDiff = null;
      handle?.set({ language: languageFromPath(path), original: '', modified: '' });
      renderReviewPanel();
      return;
    }
    currentDiff = diff;

    title.textContent = path.split('/').pop() ?? path;
    title.title = path;
    if (filePair) {
      // Обе стороны называем: сравнение идёт между двумя файлами, а не с историей.
      title.textContent = compareLabel(filePair);
      subtitle.textContent = 'сравнение двух файлов';
      subtitle.title = `Слева: ${filePair.left}\nСправа: ${filePair.right}`;
    } else if (refs) {
      subtitle.textContent = `${refs.base} → ${refs.head}`;
      subtitle.title = 'Слева содержимое из первой ссылки, справа — из второй';
    } else if (commit) {
      subtitle.textContent = `${commit} против рабочего дерева`;
      subtitle.title = 'Показаны правки, сделанные после этого коммита';
    } else {
      subtitle.textContent = staged ? 'индекс против HEAD' : 'рабочее дерево против индекса';
      subtitle.title = staged
        ? 'Показаны правки, которые уйдут в коммит'
        : 'Показаны правки, которых в индексе ещё нет';
    }

    // Редактор создаём уже видимым: Monaco измеряет контейнер при создании,
    // а у скрытого контейнера ширина нулевая.
    if (!handle) {
      handle = deps.createDiff(body);
      // Режим, выбранный человеком в прошлый раз, восстанавливаем.
      handle.setLayout(sideBySide);
    }
    handle.set({ language: languageFromPath(path), original: diff.original, modified: diff.modified });
    drawHunks(target, diff.hunks);
    renderReviewPanel();
  };

  return {
    element,
    get isOpen() {
      return open;
    },
    showComments() {
      setPanelVisible(true);
    },
    close,
    async open(path, staged, commit) {
      current = { path, staged, commit };
      open = true;
      element.hidden = false;
      activeThread = null;
      draft = null;
      await render(current);
    },
    async openFiles(left, right) {
      current = { path: right, staged: false, filePair: { left, right } };
      open = true;
      element.hidden = false;
      activeThread = null;
      draft = null;
      await render(current);
    },
    async openRefs(base, head, path) {
      current = { path, staged: false, refs: { base, head } };
      open = true;
      element.hidden = false;
      activeThread = null;
      draft = null;
      await render(current);
    },
  };
}
