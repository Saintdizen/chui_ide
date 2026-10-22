import type { DefineCommand } from './command-args';
import type { GitModel } from './git-model';
import type { ToastKind } from '../ui/toast';

/**
 * Панели git, которые ничего не меняют: история текстом и список отложенных
 * изменений. Обеим нужна модель git и попап, поэтому живут рядом.
 */
export interface GitPanelDeps {
  git: GitModel;
  showToast(message: string, kind?: ToastKind): void;
  /** Текстовая панель только для чтения (модалка в `ui/text-modal`). */
  openText(title: string, text: string): void;
  /** Список stash с действиями над записями. */
  openStash(): Promise<void>;
}

export function registerGitPanelCommands(define: DefineCommand, deps: GitPanelDeps): void {
  const { git, showToast } = deps;

  /** История в виде графа веток — текстом, как её рисует git. */
  define({ id: 'git.logGraph', title: 'История с графом веток', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    const text = await git.logGraph(100);
    if (!text.trim()) {
      showToast('Истории ещё нет');
      return;
    }
    deps.openText('История (граф веток)', text);
  });

  /** Отложенные изменения (stash): список записей и действия над ними. */
  define({ id: 'git.openStash', title: 'Отложенные изменения (stash)', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    await deps.openStash();
  });
}
