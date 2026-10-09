import { h, svgIcon } from './dom';

export interface StatusState {
  workspace: string | null;
  file: string | null;
  dirty: boolean;
  line: number;
  column: number;
  language: string | null;
  version: number;
  ai: string;
  tabSize: number;
  /** Отступ символом табуляции — так у языков вроде Makefile. */
  useTabs: boolean;
  /** Чем запускается активный файл (`python3`, `.venv/bin/python`, `npm`). */
  tool: string | null;
  eol: string;
  encoding: string;
  /** Ветка или null, если репозитория нет. */
  branch: string | null;
  /** Сколько файлов с правками: показывает виджет ветки. */
  changes: number;
  /** Вид проекта — «Python», «Node.js». Слева, рядом с именем проекта. */
  projectKind: string | null;
  /** Выбранное Python-окружение (`.venv`, `python3`); null — виджет скрыт. */
  env: string | null;
}

export interface StatusBarView {
  element: HTMLElement;
  update(patch: Partial<StatusState>): void;
}

export interface StatusBarDeps {
  /** Открыть менеджер git у указанной кнопки — так работает кнопка ветки. */
  openGitManager(anchor: HTMLElement): void;
  /** Открыть попап Python-окружения у кнопки окружения. */
  openPythonEnv(anchor: HTMLElement): void;
  /** Клик по пути файла — быстрый переход к другому файлу. */
  openFilePicker(): void;
}

/**
 * Статусбар как в PyCharm: слева путь к активному файлу и ветка git,
 * справа «строка:столбец», перевод строки, кодировка, отступ, окружение и язык.
 * Полоса плоская, без «острова» — на фоне приложения.
 */
export function createStatusBar(deps: StatusBarDeps): StatusBarView {
  const state: StatusState = {
    workspace: null,
    file: null,
    dirty: false,
    line: 1,
    column: 1,
    language: null,
    version: 0,
    ai: 'готов',
    tabSize: 2,
    useTabs: false,
    tool: null,
    eol: 'LF',
    encoding: 'UTF-8',
    branch: null,
    changes: 0,
    projectKind: null,
    env: null,
  };

  const workspaceItem = h('span', { class: 'status-item' });
  const kindItem = h('span', { class: 'status-item status-kind' });
  const envItem = h(
    'button',
    {
      class: 'status-item status-env',
      type: 'button',
      title: 'Python-окружение проекта',
      onClick: (event: Event) => deps.openPythonEnv(event.currentTarget as HTMLElement),
    },
  );
  const fileItem = h('button', {
    class: 'status-item status-file',
    type: 'button',
    title: 'Быстрый переход к файлу',
    onClick: () => deps.openFilePicker(),
  });
  const gitItem = h(
    'button',
    {
      class: 'status-item status-git',
      type: 'button',
      title: 'Менеджер git',
      onClick: (event: Event) => deps.openGitManager(event.currentTarget as HTMLElement),
    },
    svgIcon('branch', 12),
  );
  const gitLabel = h('span', { class: 'status-git-label' });
  gitItem.appendChild(gitLabel);
  const positionItem = h('span', { class: 'status-item' });
  const eolItem = h('span', { class: 'status-item' });
  const encodingItem = h('span', { class: 'status-item' });
  const indentItem = h('span', { class: 'status-item' });
  const languageItem = h('span', { class: 'status-item' });
  const toolItem = h('span', { class: 'status-item status-tool' });
  const versionItem = h('span', { class: 'status-item status-muted' });
  const aiItem = h('span', { class: 'status-item status-ai' }, svgIcon('sparkle', 12));

  const element = h(
    'div',
    { class: 'statusbar' },
    h('div', { class: 'status-group' }, workspaceItem, kindItem, gitItem, fileItem),
    h(
      'div',
      { class: 'status-group' },
      aiItem,
      versionItem,
      positionItem,
      eolItem,
      encodingItem,
      indentItem,
      envItem,
      toolItem,
      languageItem,
    ),
  );

  const render = (): void => {
    workspaceItem.textContent = state.workspace ?? 'нет проекта';
    kindItem.textContent = state.projectKind ?? '';
    kindItem.hidden = !state.projectKind;
    kindItem.title = state.projectKind ? `Проект: ${state.projectKind}` : '';
    fileItem.textContent = state.file ? `${state.dirty ? '● ' : ''}${state.file}` : '';
    fileItem.hidden = !state.file;
    positionItem.textContent = `${state.line}:${state.column}`;
    eolItem.textContent = state.eol;
    encodingItem.textContent = state.encoding;
    indentItem.textContent = state.useTabs ? `таб ${state.tabSize}` : `${state.tabSize} пробела`;
    languageItem.textContent = state.language ?? '—';
    envItem.textContent = state.env ?? '';
    envItem.hidden = !state.env;
    envItem.title = state.env ? `Python-окружение: ${state.env}` : '';
    toolItem.textContent = state.tool ?? '';
    toolItem.hidden = !state.tool;
    toolItem.title = state.tool ? `Запуск: ${state.tool}` : '';
    versionItem.textContent = state.version ? `v${state.version}` : '';
    aiItem.title = `AI: ${state.ai}`;
    aiItem.classList.toggle('is-busy', state.ai !== 'готов');
    gitItem.hidden = state.branch === null;
    gitLabel.textContent = state.branch ? `${state.branch}${state.changes > 0 ? `  ±${state.changes}` : ''}` : '';
    gitItem.title = state.branch
      ? `Ветка ${state.branch}${state.changes > 0 ? `, файлов с правками: ${state.changes}` : ', изменений нет'}`
      : '';
  };

  render();

  return {
    element,
    update(patch) {
      Object.assign(state, patch);
      render();
    },
  };
}
