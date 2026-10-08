import type { CommandRegistry } from '../core/commands';
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
  eol: string;
  encoding: string;
  /** Ветка или null, если репозитория нет. */
  branch: string | null;
  /** Сколько файлов с правками: показывает виджет ветки. */
  changes: number;
}

export interface StatusBarView {
  element: HTMLElement;
  update(patch: Partial<StatusState>): void;
}

/**
 * Статусбар как в PyCharm: слева путь к активному файлу и ветка git,
 * справа «строка:столбец», перевод строки, кодировка, отступ, язык.
 * Полоса плоская, без «острова» — на фоне приложения.
 */
export function createStatusBar(commands: CommandRegistry): StatusBarView {
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
    eol: 'LF',
    encoding: 'UTF-8',
    branch: null,
    changes: 0,
  };

  const workspaceItem = h('span', { class: 'status-item' });
  const fileItem = h('span', { class: 'status-item status-file' });
  const gitItem = h(
    'button',
    {
      class: 'status-item status-git',
      type: 'button',
      title: 'Изменения в репозитории',
      onClick: () => void commands.execute('view.showChanges'),
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
  const versionItem = h('span', { class: 'status-item status-muted' });
  const aiItem = h('span', { class: 'status-item status-ai' }, svgIcon('sparkle', 12));

  const element = h(
    'div',
    { class: 'statusbar' },
    h('div', { class: 'status-group' }, workspaceItem, gitItem, fileItem),
    h(
      'div',
      { class: 'status-group' },
      aiItem,
      versionItem,
      positionItem,
      eolItem,
      encodingItem,
      indentItem,
      languageItem,
    ),
  );

  const render = (): void => {
    workspaceItem.textContent = state.workspace ?? 'нет проекта';
    fileItem.textContent = state.file ? `${state.dirty ? '● ' : ''}${state.file}` : '';
    fileItem.hidden = !state.file;
    positionItem.textContent = `${state.line}:${state.column}`;
    eolItem.textContent = state.eol;
    encodingItem.textContent = state.encoding;
    indentItem.textContent = `${state.tabSize} пробела`;
    languageItem.textContent = state.language ?? '—';
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
