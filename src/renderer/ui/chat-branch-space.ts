import type { BranchSpace } from '../../shared/branch-space';
import { describeBranchSpace, taskBranchName, uniqueBranchName, worktreePathFor } from '../../shared/branch-space';
import type { GitModel } from '../core/git-model';
import type { WorkspaceModel } from '../core/workspace-model';
import { h } from './dom';

/**
 * Где живёт задача — в главном дереве или в отдельной ветке.
 *
 * Чип стоит у композера и говорит честно: «отдельная ветка chui/fix-cache», а не
 * молчит. Рядом — одна кнопка по смыслу: в главном дереве «Работать в ветке»,
 * в отдельном — «Применить к главному дереву» и «Вернуться».
 */
export interface ChatBranchSpaceDeps {
  git: GitModel;
  workspace: WorkspaceModel;
  /** Заголовок беседы — из него собирается имя ветки. */
  sessionTitle: () => string;
  confirm: (options: { title: string; message: string; detail: string; confirmLabel: string }) => Promise<boolean>;
  notify: (text: string, kind?: 'info' | 'error') => void;
}

export interface ChatBranchSpaceView {
  element: HTMLElement;
  /** Перечитать состояние (открыли беседу, сменили корень, закончился прогон). */
  refresh(): void;
}

export function createChatBranchSpace(deps: ChatBranchSpaceDeps): ChatBranchSpaceView {
  const label = h('span', { class: 'branch-space-label' });
  const action = h('button', {
    class: 'branch-space-action',
    type: 'button',
    hidden: true,
    onClick: () => void run(),
  });
  // «Вернуться» без слияния: задачу можно и бросить, не таща её в главное дерево.
  const back = h('button', {
    class: 'branch-space-action',
    type: 'button',
    hidden: true,
    onClick: () => void goBack(),
  });
  back.textContent = 'Вернуться';
  back.title = 'Переключить окно в главное дерево, ничего не вливая';
  const element = h('div', { class: 'branch-space', hidden: true }, label, action, back);
  let busy = false;

  function draw(): void {
    const root = deps.workspace.root;
    const mainRoot = deps.git.rootSummaries[0]?.root ?? null;
    if (!root) {
      element.hidden = true;
      return;
    }
    const space: BranchSpace = {
      root,
      branch: deps.git.branch,
      worktree: mainRoot !== null && root !== mainRoot,
    };
    element.hidden = false;
    label.textContent = describeBranchSpace(space, mainRoot);
    element.dataset.worktree = space.worktree ? 'yes' : 'no';
    element.title = space.worktree
      ? `Задача работает в отдельном каталоге: ${root}`
      : 'Задача работает в главном дереве проекта';
    action.hidden = false;
    action.textContent = space.worktree ? 'Применить' : 'В отдельной ветке';
    action.title = space.worktree
      ? 'Влить ветку задачи в текущую ветку главного дерева'
      : 'Создать ветку и работать в отдельном каталоге';
    action.disabled = busy || !deps.git.isRepository;
    back.hidden = !space.worktree;
    back.disabled = busy;
  }

  async function run(): Promise<void> {
    if (busy) return;
    const root = deps.workspace.root;
    if (!root) return;
    const mainRoot = deps.git.rootSummaries[0]?.root ?? null;
    busy = true;
    draw();
    try {
      if (mainRoot && root !== mainRoot) await apply(mainRoot);
      else await isolate(root);
    } catch (error) {
      deps.notify(`Не получилось: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      busy = false;
      draw();
    }
  }

  /** Увести задачу в отдельную ветку: worktree рядом с проектом и корень туда же. */
  async function isolate(root: string): Promise<void> {
    const existing = (await deps.git.branches()).map((item) => item.name);
    const branch = uniqueBranchName(taskBranchName(deps.sessionTitle()), existing);
    const path = worktreePathFor(root, branch);
    const worktrees = await deps.git.worktrees();
    const mainRoot = worktrees[0]?.path ?? root;
    const ok = await deps.confirm({
      title: 'Работать в отдельной ветке?',
      message: `Задача уйдёт в ветку ${branch}, окно переключится в её каталог.`,
      detail: `Каталог: ${path}\nГлавное дерево: ${mainRoot}\nИзменения в главном дереве останутся нетронутыми.`,
      confirmLabel: 'Создать ветку',
    });
    if (!ok) return;
    await deps.git.worktreeAdd(path, { newBranch: branch });
    await deps.workspace.setActiveRoot(path);
    deps.notify(`Задача идёт в ветке ${branch}`);
  }

  /** Вернуться в главное дерево, ничего не вливая: ветка остаётся как есть. */
  async function goBack(): Promise<void> {
    const mainRoot = deps.git.rootSummaries[0]?.root;
    if (!mainRoot || busy) return;
    busy = true;
    draw();
    try {
      await deps.workspace.setActiveRoot(mainRoot);
      deps.notify('Окно вернулось в главное дерево');
    } catch (error) {
      deps.notify(`Не получилось: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      busy = false;
      draw();
    }
  }

  /** Влить ветку задачи в главное дерево и вернуть окно туда. */
  async function apply(mainRoot: string): Promise<void> {
    const branch = deps.git.branch;
    if (!branch) {
      deps.notify('Ветку не видно: в этом каталоге нет имени ветки (detached HEAD).', 'error');
      return;
    }
    const ok = await deps.confirm({
      title: 'Применить к главному дереву?',
      message: `Ветка ${branch} будет влита в текущую ветку главного дерева.`,
      detail: `Главное дерево: ${mainRoot}\nКаталог задачи останется на месте — убрать его можно в «Worktree».`,
      confirmLabel: 'Влить',
    });
    if (!ok) return;
    await deps.workspace.setActiveRoot(mainRoot);
    const result = await deps.git.mergeBranch(branch);
    if (result.ok) {
      deps.notify(`Ветка ${branch} влита в главное дерево`);
      return;
    }
    if (result.conflict) {
      deps.notify('Слияние остановилось на конфликте: разрешите его в главном дереве.', 'error');
      return;
    }
    deps.notify(result.message || 'Слияние не удалось', 'error');
  }

  // Обновляемся, когда меняется git или рабочая папка: ветку можно переключить
  // в терминале, и чип не должен врать о старом месте.
  deps.git.onDidChange(() => draw());
  deps.workspace.onDidChange(() => draw());
  draw();
  return { element, refresh: draw };
}
