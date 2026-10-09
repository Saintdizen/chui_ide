import type { GitBranch, GitChange, GitFileStatus } from '../../shared/api';
import type { CommandRegistry } from '../core/commands';
import type { GitModel } from '../core/git-model';
import type { WorkspaceModel } from '../core/workspace-model';
import { showContextMenu } from './context-menu';
import { clear, h, svgIcon, type IconName } from './dom';
import { createSelect } from './select';

const CHANGE_LETTER: Record<GitChange, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

const CHANGE_TITLE: Record<GitChange, string> = {
  modified: 'изменён',
  added: 'добавлен в индекс',
  deleted: 'удалён',
  renamed: 'переименован',
  untracked: 'новый файл',
  conflicted: 'конфликт слияния',
};

export interface SourceControlDeps {
  git: GitModel;
  workspace: WorkspaceModel;
  commands: CommandRegistry;
}

export interface SourceControlView {
  element: HTMLElement;
  /** Поставить курсор в поле сообщения — этим панель «открывается». */
  focus(): void;
}

/**
 * Панель изменений: ветка, сообщение коммита и два списка — проиндексированные
 * и остальные правки. Своих операций над репозиторием панель не делает:
 * она шлёт команды, поэтому то же действие доступно из палитры и от ассистента.
 */
export function createSourceControl(deps: SourceControlDeps): SourceControlView {
  const branchName = h('span', { class: 'sc-branch-name' });
  const branchSelect = createSelect({ title: 'Текущая ветка', placeholder: 'нет ветки', class: 'sc-branch-select' });
  const branchInput = h('input', {
    class: 'sc-branch-input',
    type: 'text',
    placeholder: 'Имя новой ветки, Enter — создать',
    spellcheck: false,
  });
  const branchCreate = h('div', { class: 'sc-branch-create', hidden: true }, branchInput);

  const message = h('textarea', {
    class: 'sc-message',
    rows: 3,
    spellcheck: false,
    placeholder: 'Сообщение коммита, Ctrl+Enter — закоммитить',
  });
  const commitButton = h('button', {
    class: 'btn btn-primary sc-commit',
    type: 'button',
    title: 'Закоммитить проиндексированное',
    onClick: () => void commit(),
  }, 'Закоммитить');

  const stagedGroup = h('div', { class: 'sc-group' });
  const unstagedGroup = h('div', { class: 'sc-group' });
  const hint = h('p', { class: 'sc-hint' });
  const initButton = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => void deps.commands.execute('git.init'),
  }, 'Создать репозиторий');

  const newBranchButton = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Новая ветка',
    onClick: () => openBranchInput(),
  }, svgIcon('plus', 14));

  const element = h(
    'div',
    { class: 'source-control' },
    h(
      'div',
      { class: 'sc-head' },
      svgIcon('branch', 14),
      branchName,
      branchSelect.element,
      h(
        'div',
        { class: 'panel-actions' },
        newBranchButton,
        h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Обновить состояние', onClick: () => void deps.commands.execute('git.refresh') },
          svgIcon('refresh', 14),
        ),
      ),
    ),
    branchCreate,
    h('div', { class: 'sc-commit-box' }, message, h('div', { class: 'sc-commit-actions' }, hint, commitButton)),
    h('div', { class: 'sc-list' }, stagedGroup, unstagedGroup, initButton),
  );

  message.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void commit();
    }
  });

  branchSelect.onChange((name) => {
    if (name) void deps.commands.execute('git.checkout', name);
  });

  /* ── создание ветки: поле открывается кнопкой «+», Enter — создать ── */

  function openBranchInput(): void {
    branchCreate.hidden = false;
    branchInput.value = '';
    branchInput.focus();
  }

  function closeBranchInput(): void {
    branchCreate.hidden = true;
    branchInput.value = '';
  }

  branchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeBranchInput();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = branchInput.value.trim();
    if (!name) return;
    closeBranchInput();
    void deps.commands.execute('git.createBranch', name);
  });

  // Уход фокуса закрывает поле — как у строки переименования в дереве.
  branchInput.addEventListener('blur', () => closeBranchInput());

  const commit = async (): Promise<void> => {
    const info = await deps.commands.execute('git.commit', message.value);
    // Сообщение очищаем только при успешном коммите: иначе текст не вернуть.
    if (info) message.value = '';
  };

  const row = (file: GitFileStatus, staged: boolean): HTMLElement => {
    const action = h(
      'button',
      {
        class: 'sc-row-action',
        type: 'button',
        title: staged ? 'Убрать из индекса' : 'Проиндексировать',
        onClick: (event: Event) => {
          event.stopPropagation();
          void deps.commands.execute(staged ? 'git.unstage' : 'git.stage', file.path);
        },
      },
      svgIcon(staged ? 'minus' : 'plus', 13),
    );

    return h(
      'button',
      {
        class: `sc-row is-${file.change}`,
        type: 'button',
        title: `${file.relative} — ${CHANGE_TITLE[file.change]}`,
        onClick: () => void deps.commands.execute('git.showDiff', file.path, staged),
        onContextMenu: (event: Event) => openMenu(file, staged, event as MouseEvent),
      },
      svgIcon('file', 13),
      h('span', { class: 'sc-row-name' }, deps.workspace.relative(file.path)),
      h('span', { class: `sc-badge is-${file.change}`, title: CHANGE_TITLE[file.change] }, CHANGE_LETTER[file.change]),
      action,
    );
  };

  const openMenu = (file: GitFileStatus, staged: boolean, event: MouseEvent): void => {
    event.preventDefault();
    showContextMenu(
      [
        { label: 'Показать различия', onSelect: () => void deps.commands.execute('git.showDiff', file.path, staged) },
        { label: 'Открыть файл', onSelect: () => void deps.commands.execute('file.revealAt', file.path, 1, 1) },
        { separator: true as const },
        staged
          ? { label: 'Убрать из индекса', onSelect: () => void deps.commands.execute('git.unstage', file.path) }
          : { label: 'Проиндексировать', onSelect: () => void deps.commands.execute('git.stage', file.path) },
        {
          label: 'Откатить правки',
          danger: true,
          onSelect: () => void deps.commands.execute('git.discard', file.path, CHANGE_TITLE[file.change]),
        },
      ],
      event.clientX,
      event.clientY,
    );
  };

  /** Массовое действие группы: кнопка в шапке списка. */
  const groupAction = (title: string, icon: IconName, command: string): HTMLButtonElement =>
    h(
      'button',
      {
        class: 'sc-group-action',
        type: 'button',
        title,
        onClick: (event: Event) => {
          event.stopPropagation();
          void deps.commands.execute(command);
        },
      },
      svgIcon(icon, 13),
    );

  const group = (title: string, files: GitFileStatus[], staged: boolean): void => {
    const host = staged ? stagedGroup : unstagedGroup;
    clear(host);
    host.hidden = files.length === 0;
    if (files.length === 0) return;

    // Действия — справа от счётчика: видно, что можно сделать со всем списком,
    // не открывая контекстное меню каждой строки.
    const actions = h('div', { class: 'sc-group-actions' });
    if (staged) {
      actions.appendChild(groupAction('Убрать всё из индекса', 'minus', 'git.unstageAll'));
    } else {
      actions.appendChild(groupAction('Проиндексировать всё', 'plus', 'git.stageAll'));
      actions.appendChild(groupAction('Откатить все правки', 'revert', 'git.discardAll'));
    }

    host.appendChild(
      h(
        'div',
        { class: 'sc-group-title' },
        h('span', {}, title),
        h('span', { class: 'sc-group-count' }, String(files.length)),
        actions,
      ),
    );
    for (const file of files) host.appendChild(row(file, staged));
  };

  const renderBranches = async (): Promise<void> => {
    const current = deps.git.branch;
    const branches: GitBranch[] = await deps.git.branches();
    const signature = branches.map((branch) => `${branch.name}${branch.current ? '*' : ''}`).join('|');
    if (branchSelect.element.dataset.signature === signature) return;

    branchSelect.setOptions(
      branches.map((branch) => ({
        value: branch.name,
        label: branch.name,
        hint: branch.remote ? 'удалённая' : undefined,
      })),
    );
    branchSelect.element.dataset.signature = signature;
    if (current) branchSelect.setValue(current);
    branchSelect.setHidden(branches.length === 0);
  };

  const render = (): void => {
    const repository = deps.git.repository;
    const isRepo = repository !== null;

    branchName.textContent = repository
      ? repository.branch ?? `HEAD ${repository.head ?? ''}`.trim()
      : 'не репозиторий';
    branchSelect.setHidden(!isRepo);
    newBranchButton.hidden = !isRepo;
    if (!isRepo) closeBranchInput();

    const staged = deps.git.staged;
    const unstaged = deps.git.unstaged;
    group('Проиндексировано', staged, true);
    group('Изменения', unstaged, false);

    const total = staged.length + unstaged.length;
    hint.textContent = total === 0 ? '' : `${total} ${plural(total)}`;
    commitButton.disabled = message.value.trim().length === 0;
    initButton.hidden = isRepo;

    if (!isRepo) {
      stagedGroup.hidden = true;
      unstagedGroup.hidden = true;
      hint.textContent = 'Рабочая папка не в репозитории git';
    } else {
      void renderBranches();
    }
  };

  message.addEventListener('input', () => {
    commitButton.disabled = message.value.trim().length === 0;
  });

  deps.git.onDidChange(render);
  render();

  return {
    element,
    focus: () => message.focus(),
  };
}

function plural(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'файл с правками';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла с правками';
  return 'файлов с правками';
}
