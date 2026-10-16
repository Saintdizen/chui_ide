import type { GitSparseInfo } from '../../shared/git-sparse';
import { addSparseDirectory, removeSparseDirectory, sparseDirectories, sparseSummary } from '../../shared/git-sparse';
import type { GitModel } from '../core/git-model';
import { clear, h } from './dom';
import { createModal } from './modal';

export interface SparseModalDeps {
  git: GitModel;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface SparseModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/**
 * Экран разреженного рабочего каталога (sparse checkout): что из репозитория
 * выложено на диск.
 *
 * В больших монорепозиториях весь проект на диск не нужен — работа идёт в одном-двух
 * пакетах. Режим `cone` выбирает каталоги: `src` и `tests` выкладываются целиком, а
 * прочее — только файлы в корне. Окно показывает выбранные каталоги и даёт добавить
 * новый, убрать лишний и выключить режим целиком.
 *
 * Выключение возвращает на диск весь репозиторий: это может быть долго и занять
 * место, поэтому у кнопки честная подпись, а не «ОК».
 */
export function createSparseModal(deps: SparseModalDeps): SparseModalView {
  let info: GitSparseInfo | null = null;
  let busy = false;

  const status = h('div', { class: 'sparse-status' });
  const dirsList = h('div', { class: 'sparse-list' });
  const dirInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'например, packages/api',
  });

  const addButton = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => void add() }, 'Добавить');
  const disableButton = h(
    'button',
    { class: 'btn', type: 'button', title: 'Вернуть на диск весь репозиторий', onClick: () => void disable() },
    'Выключить режим',
  );

  // Кнопка «Выключить режим» — подвал окна: тело (список каталогов) растёт.
  const footer = h('footer', { class: 'modal-footer is-end' }, disableButton);
  const modal = createModal({ className: 'sparse-modal', title: 'Разреженный рабочий каталог', footer });
  modal.body.append(
    status,
    h('div', { class: 'settings-divider' }),
    h('div', { class: 'field-label' }, 'Каталоги на диске'),
    h(
      'div',
      { class: 'field-hint' },
      'Файлы вне этих каталогов в рабочем дереве не появляются. История git от этого не ' +
        'меняется: режим решает, что выкладывать на диск. Через запятую можно задать сразу ' +
        'несколько — например, `src, tests`.',
    ),
    dirsList,
    h('div', { class: 'sparse-add' }, dirInput, addButton),
    h('div', { class: 'settings-divider' }),
    h(
      'div',
      { class: 'field-hint' },
      'Выключение возвращает на диск весь репозиторий — это может занять время и место.',
    ),
  );

  const close = (): void => modal.close();

  const action = (label: string, run: () => void, danger = false): HTMLElement =>
    h('button', { class: `btn btn-small${danger ? ' is-danger' : ''}`, type: 'button', onClick: run }, label);

  const renderStatus = (): void => {
    clear(status);
    if (!info) return;
    status.append(h('p', { class: 'sparse-line' }, sparseSummary(info)));
    footer.hidden = !info.enabled;
    addButton.disabled = false;
  };

  const renderDirs = (): void => {
    clear(dirsList);
    if (!info || !info.enabled) {
      dirsList.append(h('p', { class: 'sparse-empty' }, 'Разреженный режим не включён — на диске весь репозиторий.'));
      return;
    }
    if (!info.cone) {
      // Режим шаблонов: каталоги не выбирали — показываем правила как есть и не
      // притворяемся, что понимаем их лучше git.
      for (const pattern of info.patterns) {
        dirsList.append(h('div', { class: 'sparse-row' }, h('code', { class: 'sparse-pattern' }, pattern)));
      }
      return;
    }
    const dirs = sparseDirectories(info.patterns);
    if (dirs.length === 0) {
      dirsList.append(h('p', { class: 'sparse-empty' }, 'Каталоги не выбраны — на диске только корень.'));
      return;
    }
    for (const dir of dirs) {
      dirsList.append(
        h(
          'div',
          { class: 'sparse-row' },
          h('span', { class: 'sparse-dir', title: dir }, dir),
          action('Убрать', () => void remove(dir), true),
        ),
      );
    }
  };

  const render = (): void => {
    renderStatus();
    renderDirs();
  };

  /** Общая обёртка: операция не должна запускаться дважды и обязана показать сбой. */
  const run = async (operation: () => Promise<GitSparseInfo>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      info = await operation();
      render();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  async function add(): Promise<void> {
    const value = dirInput.value.trim();
    if (value === '') {
      deps.notify('Укажите каталог — например, packages/api', 'error');
      return;
    }
    // Через запятую можно задать несколько сразу: так удобнее для монорепозитория.
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const current = info?.enabled && info.cone ? sparseDirectories(info.patterns) : [];
    let next = current;
    for (const part of parts) next = addSparseDirectory(next, part);
    await run(() => deps.git.sparseSet(next));
    dirInput.value = '';
  }

  async function remove(directory: string): Promise<void> {
    const current = info?.enabled && info.cone ? sparseDirectories(info.patterns) : [];
    const next = removeSparseDirectory(current, directory);
    // Убрали последний каталог — выключаем режим целиком: пустой набор git не примет.
    if (next.length === 0) {
      await run(() => deps.git.sparseDisable());
      return;
    }
    await run(() => deps.git.sparseSet(next));
  }

  async function disable(): Promise<void> {
    await run(() => deps.git.sparseDisable());
  }

  async function open(): Promise<void> {
    modal.open();
    status.replaceChildren(h('p', { class: 'field-hint' }, 'Спрашиваю git…'));
    dirsList.replaceChildren();
    try {
      info = await deps.git.sparseInfo();
    } catch (error) {
      info = null;
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  return { element: modal.element, open, close };
}
