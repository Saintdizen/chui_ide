import type { GitRefDiffFile } from '../../shared/git-ref-diff';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';
import { createSelect } from './select';

export interface RefDiffModalDeps {
  git: GitModel;
  /** Открыть файл в сравнении ссылок (своё окно сравнения). */
  openFile(base: string, head: string, path: string): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface RefDiffModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Буква статуса для списка: та же привычная нотация, что у git. */
const CHANGE_LETTER: Record<GitRefDiffFile['change'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: 'U',
};

/** Слово статуса — человеческое, для подсказки. */
const CHANGE_WORD: Record<GitRefDiffFile['change'], string> = {
  added: 'добавлен',
  modified: 'изменён',
  deleted: 'удалён',
  renamed: 'переименован',
  untracked: 'новый',
  conflicted: 'конфликт',
};

/**
 * Экран «сравнить ветки»: две ссылки сверху, список изменённых между ними файлов
 * под ними. Клик по файлу открывает его сравнение (слева первая ссылка, справа
 * вторая). Ссылками могут быть не только ветки: список тот же, что у переключения
 * веток, плюс идут теги и удалённые ветки — git понимает и их.
 *
 * Само окно репозиторий не меняет: только читает. Поэтому его можно открыть в любой
 * момент, а различие показывается просмотром — без кнопок «проиндексировать блок».
 */
export function createRefDiffModal(deps: RefDiffModalDeps): RefDiffModalView {
  let options: { value: string; label: string }[] = [];
  let files: GitRefDiffFile[] = [];
  let busy = false;

  const fromSelect = createSelect({ title: 'С чем сравнивать' });
  const toSelect = createSelect({ title: 'Что сравнивать' });
  const list = h('div', { class: 'refdiff-list' });
  const summary = h('span', { class: 'refdiff-summary' });

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
      { class: 'modal refdiff-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Сравнить ветки' },
      h('header', { class: 'modal-header' }, h('span', { class: 'modal-title' }, 'Сравнить ветки'), closeButton),
      h(
        'div',
        { class: 'modal-body' },
        h(
          'div',
          { class: 'refdiff-toolbar' },
          h('span', { class: 'field-label' }, 'С чем:'),
          fromSelect.element,
          h('span', { class: 'refdiff-arrow' }, '→'),
          h('span', { class: 'field-label' }, 'Что:'),
          toSelect.element,
          summary,
        ),
        list,
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

  const load = async (): Promise<void> => {
    if (busy) return;
    const base = fromSelect.value;
    const head = toSelect.value;
    if (!base || !head) return;
    busy = true;
    clear(list);
    summary.textContent = 'Считаю…';
    try {
      const diff = await deps.git.compareRefs(base, head);
      files = diff.files;
      render(base, head);
    } catch (error) {
      files = [];
      summary.textContent = '';
      clear(list);
      list.append(h('p', { class: 'refdiff-empty' }, 'Не удалось сравнить — проверьте ссылки.'));
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  /** Сводка и список файлов: у каждого буква статуса, путь и счётчик строк. */
  const render = (base: string, head: string): void => {
    clear(list);
    if (files.length === 0) {
      summary.textContent = 'Различий нет';
      list.append(h('p', { class: 'refdiff-empty' }, 'Ветки совпадают: изменённых файлов нет.'));
      return;
    }
    summary.textContent = `файлов: ${files.length}`;

    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const counts = file.additions === null || file.deletions === null ? '' : `+${file.additions} −${file.deletions}`;
      const row = h(
        'div',
        { class: `refdiff-row is-${file.change}`, title: `${CHANGE_WORD[file.change]}: ${file.path}` },
        h('span', { class: 'refdiff-status' }, CHANGE_LETTER[file.change]),
        h('span', { class: 'refdiff-path' }, file.path),
        h('span', { class: 'refdiff-counts' }, counts),
      );
      row.addEventListener('click', () => deps.openFile(base, head, file.path));
      fragment.append(row);
    }
    list.append(fragment);
  };

  fromSelect.onChange(() => void load());
  toSelect.onChange(() => void load());

  async function open(): Promise<void> {
    element.hidden = false;
    try {
      const branches = await deps.git.branches();
      options = branches.map((branch) => ({
        value: branch.name,
        // Удалённые ветки подписаны `origin/имя`: так видно, что они чужие.
        label: `${branch.remote ? 'origin/' : ''}${branch.name}${branch.current ? ' (текущая)' : ''}`,
      }));
    } catch (error) {
      options = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    if (options.length === 0) {
      clear(list);
      summary.textContent = '';
      list.append(h('p', { class: 'refdiff-empty' }, 'В репозитории нет веток для сравнения.'));
      return;
    }

    fromSelect.setOptions(options);
    toSelect.setOptions(options);
    // По умолчанию «с чем» — HEAD (текущая ветка плюс её коммиты), «что» — первая
    // другая ветка из списка. Так сравнение уже что-то показывает при открытии.
    const head = options.find((option) => option.label.includes('(текущая)'))?.value ?? options[0]!.value;
    const base = options.find((option) => option.value !== head)?.value ?? head;
    fromSelect.setValue(base);
    toSelect.setValue(head);
    await load();
  }

  return { element, open, close };
}
