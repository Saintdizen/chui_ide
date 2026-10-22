import { isEmptyCommitMessage } from '../../shared/commit-message';
import type { DefineCommand } from './command-args';
import type { GitModel } from './git-model';
import type { ToastKind } from '../ui/toast';

/**
 * Сообщение коммита по diff: модель читает правки и предлагает текст.
 *
 * Это не агент и не беседа — один запрос, короткий ответ (`ai.commitMessage`).
 * Текст кладём В ПОЛЕ, а не коммитим сразу: сообщение правят и дополняют, а
 * кнопка «Закоммитить» рядом. Diff собирает main (`git.commitDiff`): в renderer
 * рабочего дерева нет, а обрезать и склеить правки — работа для того, у кого git.
 */
export interface GitAiDeps {
  git: GitModel;
  showToast(message: string, kind?: ToastKind): void;
  /** Включены ли подсказки модели: без этого запрос в сеть не уходит. */
  isAiEnabled(): boolean;
  /** Объяснить, почему AI молчит (настройка, ключ, согласие). */
  warnAiDisabled(): void;
  commitMessage(payload: {
    diff: string;
    staged: boolean;
    branch: string | null;
    untracked: readonly string[];
  }): Promise<{ message: string }>;
  /** Положить готовый текст в поле панели изменений. */
  setMessage(message: string): void;
  /** Показать панель с полем, не переключая уже открытую. */
  revealComposer(): void;
}

export function registerGitAiCommands(define: DefineCommand, deps: GitAiDeps): void {
  const { git, showToast } = deps;

  define({ id: 'git.generateCommitMessage', title: 'Сообщение коммита по diff (AI)', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    if (!deps.isAiEnabled()) {
      deps.warnAiDisabled();
      return;
    }

    const context = await git.commitDiff();
    if (!context.diff.trim() && context.untracked.length === 0) {
      showToast('Правок нет — сообщение писать не по чему', 'error');
      return;
    }

    try {
      const { message } = await deps.commitMessage({
        diff: context.diff,
        staged: context.staged,
        branch: git.branch,
        untracked: context.untracked,
      });
      if (isEmptyCommitMessage(message)) {
        showToast('Модель вернула пустое сообщение — попробуйте ещё раз', 'error');
        return;
      }
      deps.setMessage(message);
      // Панель изменений теперь в поповере у кнопки ветки: показываем её, чтобы
      // готовое сообщение было видно. Уже открытый не переключаем (toggle бы закрыл).
      deps.revealComposer();
      // Диф обрезан — предупреждаем: модель видела не всю правку, тему стоит проверить.
      showToast(context.truncated ? 'Сообщение готово (diff был обрезан — проверьте)' : 'Сообщение готово');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
}
