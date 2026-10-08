import { CloneEvent, type CloneProgressPayload, type RecentProject } from '../../shared/api';
import { RpcClient } from '../core/rpc';
import { WindowFrame } from '../core/window-frame';
import { h, svgIcon } from './dom';

/**
 * Стартовое окно: выбрать проект, клонировать или открыть один из недавних.
 *
 * Своей логики про файлы здесь нет — всё делает main (история живёт
 * в settings.json, клонирование идёт через git). Окно лишь показывает
 * состояние и шлёт запросы, поэтому его легко проверить моком моста.
 */
export async function startLauncher(mount: HTMLElement): Promise<void> {
  const rpc = new RpcClient();

  const topBarLeft = h('div', { class: 'topbar-left' });
  const topBarTitle = h('div', { class: 'topbar-title' }, 'Chui IDE');
  const topBarRight = h('div', { class: 'topbar-right' });
  const topBar = h('header', { class: 'topbar' }, topBarLeft, topBarTitle, topBarRight);

  /* ── действия ──────────────────────────────────────────────────────────── */

  const openButton = h(
    'button',
    { class: 'btn btn-primary launcher-action', type: 'button', onClick: () => void openProject() },
    svgIcon('folder', 15),
    h('span', {}, 'Открыть проект'),
  );
  const cloneToggle = h(
    'button',
    { class: 'btn launcher-action', type: 'button', onClick: () => toggleClone() },
    svgIcon('branch', 15),
    h('span', {}, 'Склонировать проект'),
  );

  /* ── форма клонирования ────────────────────────────────────────────────── */

  const urlInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'https://github.com/user/repo.git',
  });
  const destination = h('span', { class: 'launcher-path is-empty' }, 'папка не выбрана');
  const pickDestination = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onClick: () => void pickDestinationFolder(),
    },
    'Выбрать папку',
  );
  const cloneButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void clone() },
    'Клонировать',
  );
  const cloneProgress = h('div', { class: 'launcher-progress' });

  const cloneForm = h(
    'div',
    { class: 'launcher-clone', hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Адрес репозитория'), urlInput),
    h('label', { class: 'field' }, h('span', {}, 'Папка назначения'), h('div', { class: 'field-row' }, destination, pickDestination)),
    h(
      'div',
      { class: 'launcher-row' },
      cloneButton,
      h('button', { class: 'link-btn', type: 'button', onClick: () => toggleClone(false) }, 'Отмена'),
    ),
    cloneProgress,
  );

  /* ── недавние проекты ──────────────────────────────────────────────────── */

  const recentHost = h('div', { class: 'launcher-recent' });
  const errorLine = h('p', { class: 'launcher-error', hidden: true });

  const content = h(
    'div',
    { class: 'launcher-body' },
    h(
      'div',
      { class: 'launcher-intro' },
      h('h1', { class: 'launcher-title' }, 'Chui IDE'),
      h('p', { class: 'launcher-subtitle' }, 'Откройте папку проекта или склонируйте репозиторий — дальше начнётся обычная работа в редакторе.'),
    ),
    h('div', { class: 'launcher-actions' }, openButton, cloneToggle),
    cloneForm,
    errorLine,
    h('div', { class: 'launcher-section-title' }, 'Недавние проекты'),
    recentHost,
  );

  mount.appendChild(h('div', { class: 'launcher' }, topBar, content));

  // Своя рамка: без системной шапки окно не сдвинуть и не закрыть.
  const frame = new WindowFrame(rpc, topBarRight, topBar);
  void frame.refresh();

  let destinationPath = '';
  let busy = false;

  const showError = (text: string | null): void => {
    errorLine.textContent = text ?? '';
    errorLine.hidden = text === null;
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    cloneButton.disabled = next;
    openButton.disabled = next;
    cloneToggle.disabled = next;
    urlInput.disabled = next;
    pickDestination.disabled = next;
  };

  const renderRecent = (projects: readonly RecentProject[]): void => {
    recentHost.replaceChildren();

    if (projects.length === 0) {
      recentHost.appendChild(
        h('p', { class: 'launcher-empty' }, 'Пока ничего не открывалось. Первый проект появится здесь, и его можно будет открыть одним нажатием.'),
      );
      return;
    }

    for (const project of projects) {
      const row = h(
        'button',
        {
          class: `launcher-item${project.exists ? '' : ' is-missing'}`,
          type: 'button',
          title: project.exists ? project.path : `Папка не найдена: ${project.path}`,
          onClick: () => void openProject(project.path),
        },
        svgIcon('folder', 14),
        h(
          'span',
          { class: 'launcher-item-text' },
          h('span', { class: 'launcher-item-name' }, project.name),
          h('span', { class: 'launcher-item-path' }, project.path),
        ),
        project.exists
          ? null
          : h('span', { class: 'launcher-item-hint' }, 'папка не найдена'),
        h(
          'span',
          {
            class: 'launcher-item-remove',
            title: 'Убрать из списка',
            role: 'button',
            onClick: (event: Event) => {
              event.stopPropagation();
              void forget(project.path);
            },
          },
          svgIcon('close', 11),
        ),
      );
      recentHost.appendChild(row);
    }
  };

  const loadRecent = async (): Promise<void> => {
    try {
      renderRecent(await rpc.request('app.recentProjects'));
    } catch (error) {
      showError(describe(error));
    }
  };

  const forget = async (path: string): Promise<void> => {
    try {
      renderRecent(await rpc.request('app.forgetProject', { path }));
    } catch (error) {
      showError(describe(error));
    }
  };

  async function pickDestinationFolder(): Promise<void> {
    const result = await rpc.request('dialog.pickFolder', { title: 'Куда клонировать репозиторий' });
    if (!result.path) return;
    // Каталог выбираем, а папку проекта создаст git: имя он берёт из адреса.
    destinationPath = result.path;
    destination.textContent = destinationPath;
    destination.classList.remove('is-empty');
  }

  /** Открыть проект: без пути спрашиваем папку, с путём открываем сразу. */
  async function openProject(path?: string): Promise<void> {
    if (busy) return;
    showError(null);

    let target = path;
    if (!target) {
      const picked = await rpc.request('dialog.pickFolder', { title: 'Открыть папку проекта' });
      if (!picked.path) return;
      target = picked.path;
    }

    setBusy(true);
    try {
      // Main открывает окно IDE. Своё окно закрываем уже после ответа: если закрыть
      // его в main, ответ некуда будет отправить, и этот вызов не разрешится никогда.
      await rpc.request('app.openProject', { path: target });
      void rpc.request('window.close').catch(() => undefined);
    } catch (error) {
      setBusy(false);
      showError(describe(error));
    }
  }

  async function clone(): Promise<void> {
    if (busy) return;
    showError(null);

    const url = urlInput.value.trim();
    if (!url) {
      showError('Укажите адрес репозитория');
      urlInput.focus();
      return;
    }
    if (!destinationPath) {
      showError('Выберите папку, куда клонировать');
      return;
    }

    setBusy(true);
    cloneProgress.textContent = 'Клонирую…';

    try {
      const result = await rpc.stream(
        'git.clone',
        { url, directory: `${destinationPath}/${repositoryName(url)}` },
        (event, payload) => {
          if (event !== CloneEvent.Progress) return;
          cloneProgress.textContent = (payload as CloneProgressPayload).line;
        },
      );
      cloneProgress.textContent = 'Готово, открываю проект…';
      setBusy(false);
      await openProject(result.path);
    } catch (error) {
      setBusy(false);
      cloneProgress.textContent = '';
      showError(describe(error));
    }
  }

  function toggleClone(show = cloneForm.hidden): void {
    cloneForm.hidden = !show;
    showError(null);
    if (show) urlInput.focus();
  }

  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void clone();
  });

  await loadRecent();
  await frame.refresh();
}

/** Имя папки для клона: git берёт его из последнего сегмента адреса. */
function repositoryName(url: string): string {
  const trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '');
  return trimmed.split('/').pop() || 'repository';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
