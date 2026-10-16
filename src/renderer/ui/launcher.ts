import { CloneEvent, type CloneProgressPayload, type RecentProject } from '../../shared/api';
import {
  PROJECT_KINDS,
  isProjectKind,
  projectKindInfo,
  projectNameProblem,
  type ProjectKind,
} from '../../shared/project-kinds';
import { RpcClient } from '../core/rpc';
import { WindowFrame } from '../core/window-frame';
import { h, svgIcon } from './dom';
import { createSelect } from './select';
import { installTooltips } from './tooltip';

/**
 * Стартовое окно: открыть проект, клонировать, создать новый или взять один из недавних.
 *
 * Своей логики про файлы здесь нет — всё делает main (история живёт
 * в settings.json, клонирование идёт через git, заготовки нового проекта пишет
 * `project/scaffold`). Окно лишь показывает состояние и шлёт запросы, поэтому его
 * легко проверить моком моста.
 *
 * Клонирование и создание устроены одинаково: своя форма, своя папка назначения
 * и один и тот же переход в проект — `openProject` по ответу main. Разница только
 * в том, откуда берётся содержимое папки: из сети или из заготовки.
 */
export async function startLauncher(mount: HTMLElement): Promise<void> {
  // Подсказки — свои, вместо системных (см. `ui/tooltip.ts`).
  installTooltips();

  const rpc = new RpcClient();

  const topBarLeft = h('div', { class: 'topbar-left' });
  const topBarTitle = h('div', { class: 'topbar-title is-brand' }, 'chui_iDE');
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

  const createToggle = h(
    'button',
    { class: 'btn launcher-action', type: 'button', onClick: () => toggleCreate() },
    svgIcon('folderPlus', 15),
    h('span', {}, 'Создать проект'),
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
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Папка назначения'),
      h('div', { class: 'field-row' }, destination, pickDestination),
    ),
    h(
      'div',
      { class: 'launcher-row' },
      cloneButton,
      h('button', { class: 'btn', type: 'button', onClick: () => toggleClone(false) }, 'Отмена'),
    ),
    cloneProgress,
  );

  /* ── форма создания ────────────────────────────────────────────────────── */

  // Создание повторяет клонирование по устройству: имя, папка назначения и один
  // переход в проект. Добавляется только выбор типа: от него зависит набор
  // файлов-заготовок, а значит и то, что человек увидит в дереве после открытия.
  const nameInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'my-project',
  });
  // Тип проекта — наш список, а не системный `<select>`: он подчиняется палитре
  // и плотности приложения, как остальные выпадашки (см. `ui/select.ts`).
  const kindSelect = createSelect({ title: 'Тип проекта', class: 'launcher-kind' });
  kindSelect.setOptions(PROJECT_KINDS.map((item) => ({ value: item.kind, label: item.label, hint: item.hint })));
  const kindHint = h('p', { class: 'field-hint' }, projectKindInfo(PROJECT_KINDS[0].kind).hint);
  const nameHint = h('p', { class: 'field-hint' });
  const createDestination = h('span', { class: 'launcher-path is-empty' }, 'папка не выбрана');
  const pickCreateDestination = h(
    'button',
    { class: 'btn', type: 'button', onClick: () => void pickCreateFolder() },
    'Выбрать папку',
  );
  const createButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void create() },
    'Создать',
  );
  const createProgress = h('div', { class: 'launcher-progress' });

  const createForm = h(
    'div',
    { class: 'launcher-create', hidden: true },
    h('label', { class: 'field' }, h('span', {}, 'Имя проекта'), nameInput, nameHint),
    h('label', { class: 'field' }, h('span', {}, 'Тип проекта'), kindSelect.element, kindHint),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Где создать'),
      h('div', { class: 'field-row' }, createDestination, pickCreateDestination),
    ),
    h(
      'div',
      { class: 'launcher-row' },
      createButton,
      h('button', { class: 'btn', type: 'button', onClick: () => toggleCreate(false) }, 'Отмена'),
    ),
    createProgress,
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
      h('h1', { class: 'launcher-title' }, 'chui_iDE'),
      h(
        'p',
        { class: 'launcher-subtitle' },
        'Откройте проект, создайте новый или склонируйте репозиторий — дальше начнётся обычная работа в редакторе.',
      ),
    ),
    h('div', { class: 'launcher-actions' }, openButton, cloneToggle, createToggle),
    cloneForm,
    createForm,
    errorLine,
    h('div', { class: 'launcher-section-title' }, 'Недавние проекты'),
    recentHost,
  );

  mount.appendChild(h('div', { class: 'launcher' }, topBar, content));

  // Своя рамка: без системной шапки окно не сдвинуть и не закрыть.
  const frame = new WindowFrame(rpc, topBarRight, topBar);
  void frame.refresh();

  let destinationPath = '';
  let createDestinationPath = '';
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
    createToggle.disabled = next;
    nameInput.disabled = next;
    pickCreateDestination.disabled = next;
    kindSelect.setDisabled(next);
    refreshCreate();
  };

  const renderRecent = (projects: readonly RecentProject[]): void => {
    recentHost.replaceChildren();

    if (projects.length === 0) {
      recentHost.appendChild(
        h(
          'p',
          { class: 'launcher-empty' },
          'Пока ничего не открывалось. Первый проект появится здесь, и его можно будет открыть одним нажатием.',
        ),
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
        project.exists ? null : h('span', { class: 'launcher-item-hint' }, 'папка не найдена'),
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

  async function pickCreateFolder(): Promise<void> {
    const result = await rpc.request('dialog.pickFolder', { title: 'Где создать проект' });
    if (!result.path) return;
    createDestinationPath = result.path;
    createDestination.textContent = createDestinationPath;
    createDestination.classList.remove('is-empty');
    refreshCreate();
  }

  /**
   * Что показать под полем имени и можно ли уже создавать.
   *
   * Проверка имени — общей функцией (`projectNameProblem`), той же, что у main:
   * окно говорит о причине до запроса, а main не даёт обойти правило в обход окна.
   */
  function refreshCreate(): void {
    const name = nameInput.value.trim();
    const problem = projectNameProblem(name);
    const preview = problem ?? (name && createDestinationPath ? `${createDestinationPath}/${name}` : '');
    nameHint.textContent = preview;
    nameHint.classList.toggle('is-error', Boolean(problem));
    nameHint.hidden = preview === '';
    kindHint.textContent = projectKindInfo(chosenKind()).hint;
    createButton.disabled = busy || Boolean(problem) || !createDestinationPath;
  }

  /** Выбранный вид: список отдаёт строку, поэтому сверяем её со списком видов. */
  function chosenKind(): ProjectKind {
    const value = kindSelect.value;
    return isProjectKind(value) ? value : PROJECT_KINDS[0].kind;
  }

  /** Открыть проект: без пути спрашиваем папку, с путём открываем сразу. */
  async function openProject(path?: string): Promise<void> {
    if (busy) return;
    showError(null);

    let target = path;
    if (!target) {
      const picked = await rpc.request('dialog.pickFolder', { title: 'Открыть проект' });
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

  /**
   * Создать проект: main пишет папку с заготовками выбранного вида и возвращает
   * путь, дальше — тот же переход, что после клонирования.
   */
  async function create(): Promise<void> {
    if (busy) return;
    showError(null);

    const name = nameInput.value.trim();
    const problem = projectNameProblem(name);
    if (problem) {
      showError(problem);
      nameInput.focus();
      return;
    }
    if (!createDestinationPath) {
      showError('Выберите папку, где создать проект');
      return;
    }

    setBusy(true);
    createProgress.textContent = 'Создаю проект…';
    try {
      const result = await rpc.request('app.createProject', {
        name,
        directory: createDestinationPath,
        kind: chosenKind(),
      });
      createProgress.textContent = 'Готово, открываю проект…';
      setBusy(false);
      await openProject(result.path);
    } catch (error) {
      setBusy(false);
      createProgress.textContent = '';
      showError(describe(error));
    }
  }

  function toggleClone(show = cloneForm.hidden): void {
    cloneForm.hidden = !show;
    // Две формы занимают одно место на экране: открытая вторая только мешала бы.
    if (show) createForm.hidden = true;
    showError(null);
    if (show) urlInput.focus();
  }

  function toggleCreate(show = createForm.hidden): void {
    createForm.hidden = !show;
    if (show) cloneForm.hidden = true;
    showError(null);
    if (show) {
      refreshCreate();
      nameInput.focus();
    }
  }

  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void clone();
  });
  nameInput.addEventListener('input', refreshCreate);
  kindSelect.onChange(refreshCreate);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void create();
  });

  // Кнопка «Создать» серая, пока нет имени или папки, а подсказка говорит, чего не хватает.
  refreshCreate();

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
