import type { BranchSpace } from '../../shared/branch-space';
import { describeBranchSpace, taskBranchName, uniqueBranchName, worktreePathFor } from '../../shared/branch-space';
import type { GitModel } from '../core/git-model';
import type { WorkspaceModel } from '../core/workspace-model';
import { h } from './dom';
import { errorText } from '../core/file-errors';

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
  /** Запомнить каталог задачи в беседе — он переживёт и ход, и окно. */
  setSessionRoot?: (root: string | null) => void;
}

export interface ChatBranchSpaceView {
  element: HTMLElement;
  /** Перечитать состояние (открыли беседу, сменили корень, закончился прогон). */
  refresh(): void;
  /**
   * Увести задачу в свой каталог без вопроса — для второй задачи (п.31).
   * `true` — увелась. `false` — уводить было нечего (не git, нет корня, уже
   * отдельный каталог) или не вышло: причина уходит тостом.
   */
  isolateQuietly(): Promise<boolean>;
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
      deps.notify(`Не получилось: ${errorText(error)}`, 'error');
    } finally {
      busy = false;
      draw();
    }
  }

  /**
   * Увести задачу в отдельную ветку: worktree рядом с проектом и корень туда же.
   *
   * `ask` — спрашивать человека. Кнопка спрашивает: это его решение. Вторая
   * задача (п.31) — не спрашивает, а уводит: иначе правки двух задач лягут
   * в одни файлы. И всё равно не молчит — тост говорит, где она теперь.
   *
   * Возвращает каталог задачи, `null` — уводить не стали.
   */
  async function isolate(root: string, ask = true): Promise<string | null> {
    const existing = (await deps.git.branches()).map((item) => item.name);
    const branch = uniqueBranchName(taskBranchName(deps.sessionTitle()), existing);
    const path = worktreePathFor(root, branch);
    const worktrees = await deps.git.worktrees();
    const mainRoot = worktrees[0]?.path ?? root;
    if (ask) {
      const ok = await deps.confirm({
        title: 'Работать в отдельной ветке?',
        message: `Задача уйдёт в ветку ${branch}, окно переключится в её каталог.`,
        detail: `Каталог: ${path}\nГлавное дерево: ${mainRoot}\nИзменения в главном дереве останутся нетронутыми.`,
        confirmLabel: 'Создать ветку',
      });
      if (!ok) return null;
    }
    await deps.git.worktreeAdd(path, { newBranch: branch });
    // Каталог задачи — в беседу, не только в окно: иначе следующий ход пойдёт
    // по активному корню, а он у второй задачи — чужой.
    deps.setSessionRoot?.(path);
    await deps.workspace.setActiveRoot(path);
    deps.notify(
      ask
        ? `Задача идёт в ветке ${branch}`
        : `Вторая задача уведена в свою ветку ${branch}: правки двух задач больше не в одних файлах`,
    );
    return path;
  }

  /** Вернуться в главное дерево, ничего не вливая: ветка остаётся как есть. */
  async function goBack(): Promise<void> {
    const mainRoot = deps.git.rootSummaries[0]?.root;
    if (!mainRoot || busy) return;
    busy = true;
    draw();
    try {
      await deps.workspace.setActiveRoot(mainRoot);
      // Вернулись в главное дерево — задача снова правит его, и своего каталога у неё нет.
      deps.setSessionRoot?.(null);
      deps.notify('Окно вернулось в главное дерево');
    } catch (error) {
      deps.notify(`Не получилось: ${errorText(error)}`, 'error');
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

  /**
   * Увести задачу без вопроса — для второй задачи (п.31).
   *
   * Отличий от кнопки два: нет вопроса и НЕТ переключения окна. Кнопку нажимает
   * человек, смотрящий в эту беседу, — ему и переключение. Вторая задача
   * уводится вбок, пока он смотрит в первую: увести за ним окно значило бы
   * выдернуть из-под рук файлы, которые он правит.
   */
  async function isolateQuietly(): Promise<boolean> {
    if (busy) return false;
    const root = deps.workspace.root;
    if (!root || !deps.git.isRepository) return false;
    const mainRoot = deps.git.rootSummaries[0]?.root ?? null;
    // Уже в отдельном каталоге — уводить нечего.
    if (mainRoot !== null && root !== mainRoot) return false;
    busy = true;
    draw();
    try {
      await isolate(root, false);
      // `isolate` переключил окно на каталог задачи — возвращаем туда, где
      // человек был. Молча: переключения ему не показывали, откат тоже.
      if (deps.workspace.root !== root) await deps.workspace.setActiveRoot(root);
      return true;
    } catch (error) {
      deps.notify(`Вторая задача осталась в общем каталоге: ${errorText(error)}`, 'error');
      return false;
    } finally {
      busy = false;
      draw();
    }
  }

  // Обновляемся, когда меняется git или рабочая папка: ветку можно переключить
  // в терминале, и чип не должен врать о старом месте.
  deps.git.onDidChange(() => draw());
  deps.workspace.onDidChange(() => draw());
  draw();
  return { element, refresh: draw, isolateQuietly };
}
