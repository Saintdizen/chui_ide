import type { GitWorktree } from '../../shared/git-worktrees';
import { worktreeLabel } from '../../shared/git-worktrees';
import type { GitModel } from '../core/git-model';
import { clear, h } from './dom';
import { createModal } from './modal';
import { createSelect } from './select';

export interface WorktreeModalDeps {
  git: GitModel;
  /** Корень текущего проекта: по нему видно, какой каталог открыт сейчас. */
  currentRoot(): string | null;
  /** Открыть каталог как проект (в текущем окне). */
  openProject(path: string): Promise<void>;
  /** Спросить подтверждение (системным диалогом). */
  confirm(options: { title: string; message: string; detail?: string; confirmLabel?: string }): Promise<boolean>;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface WorktreeModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/**
 * Экран дополнительных рабочих каталогов (`git worktree`).
 *
 * Worktree — это ещё одна папка, где тот же репозиторий выложен на другой ветке:
 * удобно держать две задачи рядом, не переключаясь. Окно показывает список, даёт
 * открыть каталог как проект, добавить новый (на существующей или новой ветке) и
 * удалить ненужный. Репозиторий при этом не меняется: каталоги — это папки на диске.
 */
export function createWorktreeModal(deps: WorktreeModalDeps): WorktreeModalView {
  let worktrees: GitWorktree[] = [];
  let branches: { value: string; label: string }[] = [];
  let busy = false;

  const list = h('div', { class: 'worktree-list' });
  const addRow = h('div', { class: 'worktree-add' });
  const pathInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'путь новой папки',
  });
  const branchSelect = createSelect({ title: 'Ветка' });
  const newBranchInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'новая ветка (необязательно)',
  });

  const modal = createModal({ className: 'worktree-modal', title: 'Рабочие каталоги (worktree)' });
  modal.body.append(
    h(
      'div',
      { class: 'field-hint' },
      'Каждый рабочий каталог — та же история репозитория, выложенная в отдельную папку на своей ветке. ' +
        'Так две задачи живут рядом и не мешают друг другу.',
    ),
    list,
    addRow,
  );

  const close = (): void => modal.close();

  const action = (label: string, run: () => void, danger = false): HTMLElement =>
    h('button', { class: `btn btn-small${danger ? ' is-danger' : ''}`, type: 'button', onClick: run }, label);

  /** Одна строка: ветка, путь, пометки и действия. */
  const row = (worktree: GitWorktree): HTMLElement => {
    const current = deps.currentRoot() === worktree.path;
    const classes = ['worktree-row'];
    if (current) classes.push('is-current');
    if (worktree.locked) classes.push('is-locked');
    if (worktree.prunable) classes.push('is-prunable');

    const notes = [worktree.locked ? `заблокирован: ${worktree.locked}` : '', worktree.prunable ? 'папки нет' : '']
      .filter(Boolean)
      .join(' · ');

    const buttons: HTMLElement[] = [];
    if (!current) buttons.push(action('Открыть', () => void openAsProject(worktree.path)));
    // Главный каталог удалять нельзя, и текущий — тоже: мы в нём работаем.
    if (!current) buttons.push(action('Удалить', () => void remove(worktree), true));

    return h(
      'div',
      { class: classes.join(' ') },
      h(
        'div',
        { class: 'worktree-info' },
        h('span', { class: 'worktree-branch' }, `${worktreeLabel(worktree)}${current ? ' · текущий' : ''}`),
        h('span', { class: 'worktree-path', title: worktree.path }, worktree.path),
        notes ? h('span', { class: 'worktree-note' }, notes) : null,
      ),
      h('div', { class: 'worktree-actions' }, ...buttons),
    );
  };

  const render = (): void => {
    clear(list);
    if (worktrees.length === 0) {
      list.append(h('p', { class: 'worktree-empty' }, 'Рабочих каталогов не найдено.'));
      return;
    }
    for (const worktree of worktrees) list.append(row(worktree));
  };

  const openAsProject = async (path: string): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await deps.openProject(path);
      close();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  const remove = async (worktree: GitWorktree): Promise<void> => {
    if (busy) return;
    const confirmed = await deps.confirm({
      title: 'Удалить рабочий каталог',
      message: `Убрать рабочий каталог «${worktree.path}»?`,
      detail: 'Папка с файлами будет удалена. Ветка и история репозитория останутся нетронутыми.',
      confirmLabel: 'Удалить',
    });
    if (!confirmed) return;
    busy = true;
    try {
      worktrees = await deps.git.worktreeRemove(worktree.path);
      render();
    } catch (error) {
      // Каталог с незакоммиченными правками git не удалит: спрашиваем про принудительное.
      const message = error instanceof Error ? error.message : String(error);
      const forced = await deps.confirm({
        title: 'Удалить принудительно?',
        message: 'git отказался удалять каталог.',
        detail: `${message}\n\nВ каталоге могут быть незакоммиченные правки — их потеря. Удалить принудительно?`,
        confirmLabel: 'Удалить принудительно',
      });
      if (forced) {
        try {
          worktrees = await deps.git.worktreeRemove(worktree.path, true);
          render();
        } catch (inner) {
          deps.notify(inner instanceof Error ? inner.message : String(inner), 'error');
        }
      } else {
        deps.notify(message, 'error');
      }
    } finally {
      busy = false;
    }
  };

  const add = async (): Promise<void> => {
    if (busy) return;
    const path = pathInput.value.trim();
    if (!path) {
      deps.notify('Укажите путь нового рабочего каталога', 'error');
      return;
    }
    const newBranch = newBranchInput.value.trim();
    const branch = newBranch ? undefined : branchSelect.value || undefined;
    busy = true;
    try {
      worktrees = await deps.git.worktreeAdd(path, { branch, newBranch });
      pathInput.value = '';
      newBranchInput.value = '';
      render();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  /** Пустая форма добавления: путь, ветка (существующая или новая) и «Добавить». */
  const buildAddRow = (): void => {
    clear(addRow);
    branchSelect.setOptions([{ value: '', label: 'отделённый указатель (без ветки)' }, ...branches]);
    branchSelect.setValue('');
    addRow.append(
      h('div', { class: 'field-label' }, 'Добавить каталог'),
      h('div', { class: 'worktree-add-fields' }, pathInput, branchSelect.element, newBranchInput),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => void add() }, 'Добавить'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          title: 'Убрать записи о каталогах, которых уже нет на диске',
          onClick: () => void prune(),
        },
        'Убрать пропавшие',
      ),
      h(
        'div',
        { class: 'field-hint' },
        'Ветка — существующая; поле «новая ветка» создаёт ветку в этом каталоге. Оба пусты — отделённый указатель.',
      ),
    );
  };

  const prune = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      worktrees = await deps.git.worktreePrune();
      render();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  async function open(): Promise<void> {
    modal.open();
    try {
      [worktrees, branches] = await Promise.all([
        deps.git.worktrees(),
        deps.git
          .branches()
          .then((list) => list.map((branch) => ({ value: branch.name, label: branch.name })))
          .catch(() => [] as { value: string; label: string }[]),
      ]);
    } catch (error) {
      worktrees = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    buildAddRow();
    render();
  }

  return { element: modal.element, open, close };
}
