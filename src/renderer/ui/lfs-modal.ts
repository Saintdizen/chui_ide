import type { GitLfsInfo } from '../../shared/git-lfs';
import { lfsFileLabel, missingCount } from '../../shared/git-lfs';
import type { GitModel } from '../core/git-model';
import { clear, h } from './dom';
import { createModal } from './modal';

export interface LfsModalDeps {
  git: GitModel;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface LfsModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Больше этого числа файлов в списке не показываем: окно — не отчёт. */
const FILE_LIMIT = 200;

/**
 * Экран Git LFS: какие файлы ведёт большое хранилище и каким шаблонам это назначено.
 *
 * LFS держит большие файлы вне репозитория: в коммит идёт маленький указатель, а сам
 * файл подтягивается отдельно. Настроено ли это и для каких файлов — решает
 * `.gitattributes`; окно показывает и шаблоны, и попавшие под них файлы, а также
 * позволяет взять шаблон под LFS, отказаться от него и подтянуть содержимое.
 *
 * Без установленного `git-lfs` окно не молчит: оно объясняет, чего не хватает, —
 * иначе человек видел бы пустой список и решил, что LFS в проекте не нужен.
 */
export function createLfsModal(deps: LfsModalDeps): LfsModalView {
  let info: GitLfsInfo | null = null;
  let busy = false;

  const status = h('div', { class: 'lfs-status' });
  const patternsList = h('div', { class: 'lfs-list' });
  const filesList = h('div', { class: 'lfs-list' });
  const patternInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'например, *.psd',
  });

  const trackButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void track() },
    'Взять под LFS',
  );
  const pullButton = h(
    'button',
    { class: 'btn', type: 'button', title: 'Скачать содержимое больших файлов', onClick: () => void pull() },
    'Подтянуть файлы',
  );
  const installButton = h(
    'button',
    { class: 'btn', type: 'button', title: 'Поставить хуки LFS в этот репозиторий', onClick: () => void install() },
    'Поставить хуки',
  );

  // Кнопка «Подтянуть файлы» — подвал окна: тело (шаблоны и файлы) растёт.
  const footer = h('footer', { class: 'modal-footer is-end' }, pullButton);
  const modal = createModal({ className: 'lfs-modal', title: 'Большие файлы (Git LFS)', footer });
  modal.body.append(
    status,
    h('div', { class: 'settings-divider' }),
    h('div', { class: 'field-label' }, 'Отслеживаемые шаблоны'),
    h(
      'div',
      { class: 'field-hint' },
      'Шаблон — это правило по имени файла (`*.psd`, `assets/**`). Строка уходит в ' +
        '`.gitattributes` и коммитится вместе с кодом: так LFS настраивается для всех.',
    ),
    patternsList,
    h('div', { class: 'lfs-add' }, patternInput, trackButton, installButton),
    h('div', { class: 'settings-divider' }),
    h('div', { class: 'field-label' }, 'Файлы под LFS'),
    h(
      'div',
      { class: 'field-hint' },
      'Указатель — путь файла в репозитории; само содержимое лежит в хранилище. ' +
        '«Не подтянут» значит, что файла на диске нет и его надо скачать.',
    ),
    filesList,
  );

  const close = (): void => modal.close();

  const action = (label: string, run: () => void, danger = false): HTMLElement =>
    h('button', { class: `btn btn-small${danger ? ' is-danger' : ''}`, type: 'button', onClick: run }, label);

  /** Сообщение о том, чего не хватает: git-lfs не в системе или в проекте. */
  const renderStatus = (): void => {
    clear(status);
    if (!info) return;
    if (!info.available) {
      status.append(
        h('p', { class: 'lfs-warn' }, 'git-lfs не найден в системе — большие файлы работать не будут.'),
        h(
          'p',
          { class: 'field-hint' },
          'Установите его обычным способом: apt install git-lfs, brew install git-lfs или скачайте с git-lfs.com. ' +
            'После установки загляните сюда снова.',
        ),
      );
      return;
    }
    const parts = [info.version ? `git-lfs ${info.version.replace(/^git-lfs\//, '')}` : 'git-lfs найден'];
    parts.push(info.configured ? 'LFS настроен' : 'LFS ещё не настроен в этом репозитории');
    const missing = missingCount(info.files);
    if (missing > 0) parts.push(`не подтянуто: ${missing}`);
    status.append(h('p', { class: 'lfs-line' }, parts.join(' · ')));
    footer.hidden = !info.configured;
  };

  const renderPatterns = (): void => {
    clear(patternsList);
    const patterns = info?.patterns ?? [];
    if (patterns.length === 0) {
      patternsList.append(h('p', { class: 'lfs-empty' }, 'Ни один шаблон не ведётся через LFS.'));
      return;
    }
    for (const item of patterns) {
      patternsList.append(
        h(
          'div',
          { class: 'lfs-row' },
          h('code', { class: 'lfs-pattern', title: item.line }, item.pattern),
          action('Убрать', () => void untrack(item.pattern), true),
        ),
      );
    }
  };

  const renderFiles = (): void => {
    clear(filesList);
    const files = info?.files ?? [];
    if (files.length === 0) {
      filesList.append(h('p', { class: 'lfs-empty' }, 'Файлов под LFS нет.'));
      return;
    }
    for (const file of files.slice(0, FILE_LIMIT)) {
      const row = h(
        'div',
        { class: 'lfs-row' },
        h('span', { class: 'lfs-file', title: file.path }, lfsFileLabel(file)),
        h('span', { class: 'lfs-state' }, file.present ? 'на диске' : 'не подтянут'),
      );
      if (!file.present) row.classList.add('is-missing');
      filesList.append(row);
    }
    if (files.length > FILE_LIMIT) {
      filesList.append(h('p', { class: 'lfs-empty' }, `Показаны первые ${FILE_LIMIT} из ${files.length}.`));
    }
  };

  const render = (): void => {
    renderStatus();
    renderPatterns();
    renderFiles();
  };

  /** Общая обёртка: операция не должна запускаться дважды и обязана показать сбой. */
  const run = async (operation: () => Promise<GitLfsInfo>): Promise<void> => {
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

  async function track(): Promise<void> {
    const pattern = patternInput.value.trim();
    if (pattern === '') {
      deps.notify('Укажите шаблон — например, *.psd', 'error');
      return;
    }
    await run(() => deps.git.lfsTrack(pattern));
    patternInput.value = '';
  }

  async function untrack(pattern: string): Promise<void> {
    await run(() => deps.git.lfsUntrack(pattern));
  }

  async function pull(): Promise<void> {
    await run(() => deps.git.lfsPull());
  }

  async function install(): Promise<void> {
    await run(() => deps.git.lfsInstall());
  }

  async function open(): Promise<void> {
    modal.open();
    status.replaceChildren(h('p', { class: 'field-hint' }, 'Спрашиваю git…'));
    patternsList.replaceChildren();
    filesList.replaceChildren();
    try {
      info = await deps.git.lfsInfo();
    } catch (error) {
      info = null;
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  return { element: modal.element, open, close };
}
