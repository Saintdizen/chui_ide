import { asPath, type DefineCommand } from './command-args';
import { amendWarning, planAmend } from './file-actions';
import { basename } from '../ui/dom';
import type { GitModel } from './git-model';
import type { ToastKind } from '../ui/toast';

/**
 * Команды git, которые меняют репозиторий: индекс, коммит, откат, создание.
 *
 * Вынесены из `app.ts` целиком, вместе с комментариями о том, почему порядок
 * действий именно такой. Регистратор команд и зависимости приходят снаружи:
 * модель git, уведомления, системный диалог и сохранение буферов живут в
 * приложении, а здесь только порядок шагов и тексты, которые видит человек.
 */
export interface GitWriteDeps {
  git: GitModel;
  showToast(message: string, kind?: ToastKind): void;
  /** Системный диалог подтверждения: `dialog.confirm` в main. */
  confirm(options: { title: string; message: string; detail?: string; confirmLabel?: string }): Promise<boolean>;
  /** Корень проекта: без него создавать репозиторий негде. Функция, а не значение:
   * `enabled` спрашивают заново на каждом показе палитры, а папку могут открыть позже. */
  root(): string | null;
  relative(path: string): string;
  /** Записать буферы на диск: git смотрит рабочее дерево, а не экран. */
  saveDirtyForGit(): Promise<boolean>;
}

export function registerGitWriteCommands(define: DefineCommand, deps: GitWriteDeps): void {
  const { git, showToast } = deps;

  define(
    {
      id: 'git.refresh',
      title: 'Обновить состояние репозитория',
      category: 'Git',
    },
    async () => {
      await git.refresh();
    },
  );

  define(
    {
      id: 'git.init',
      title: 'Создать репозиторий git',
      category: 'Git',
      enabled: () => deps.root() !== null && !git.isRepository,
    },
    async () => {
      await git.init();
      showToast('Репозиторий git создан');
    },
  );

  define({ id: 'git.stage', title: 'Проиндексировать файл', category: 'Git' }, async (path) => {
    const target = asPath(path);
    if (target) await git.stage([target]);
  });

  define({ id: 'git.unstage', title: 'Убрать файл из индекса', category: 'Git' }, async (path) => {
    const target = asPath(path);
    if (target) await git.unstage([target]);
  });

  define({ id: 'git.discard', title: 'Откатить правки файла', category: 'Git' }, async (path, label) => {
    const target = asPath(path);
    if (!target) return;

    // Откат необратим, поэтому спрашиваем системным диалогом, а не просто делаем.
    const confirmed = await deps.confirm({
      title: 'Откатить правки',
      message: `Отменить правки в ${basename(target)}?`,
      detail: `${deps.relative(target)}${typeof label === 'string' ? ` (${label})` : ''} — файл вернётся к состоянию последнего коммита. Вернуть правки будет нельзя.`,
      confirmLabel: 'Откатить',
    });
    if (!confirmed) return;

    await git.discard([target]);
    showToast(`Откатано: ${basename(target)}`);
  });

  define({ id: 'git.commit', title: 'Закоммитить изменения', category: 'Git' }, async (messageArg) => {
    const text = typeof messageArg === 'string' ? messageArg : '';
    if (!text.trim()) {
      showToast('Сначала напишите сообщение коммита', 'error');
      return undefined;
    }

    // Правки в буферах git ещё не видит: он смотрит рабочее дерево, а не экран.
    // Сохраняем ДО индексации — иначе и в индекс, и в коммит ушло бы старое содержимое.
    if (!(await deps.saveDirtyForGit())) return undefined;

    // Как в других IDE: пустой индекс — не повод отказывать, а повод спросить.
    if (git.staged.length === 0) {
      if (git.unstaged.length === 0) {
        showToast('Изменений для коммита нет', 'error');
        return undefined;
      }
      const confirmed = await deps.confirm({
        title: 'Коммит',
        message: 'В индексе нет файлов. Проиндексировать все изменения и закоммитить?',
        detail: `Файлов с правками: ${git.unstaged.length}`,
        confirmLabel: 'Проиндексировать и закоммитить',
      });
      if (!confirmed) return undefined;
      await git.stage(git.unstaged.map((file) => file.path));
    }

    const info = await git.commit(text);
    showToast(`Коммит ${info.hash}: ${info.summary}`);
    return info;
  });

  /**
   * Исправить последний коммит (amend). Пустое сообщение — оставить прежнее:
   * так можно просто добавить в него дозревшие правки.
   */
  define(
    {
      id: 'git.amendCommit',
      title: 'Исправить последний коммит (amend)',
      category: 'Git',
    },
    async (messageArg) => {
      const text = typeof messageArg === 'string' ? messageArg : '';
      if (!git.repository || git.repository.head === null) {
        showToast('Исправлять нечего: коммитов ещё нет', 'error');
        return undefined;
      }
      if (!(await deps.saveDirtyForGit())) return undefined;
      // Новое сообщение перезаписывает и текст коммита, и его историю: про это
      // спрашиваем ДО, а не показываем повод в `git log`.
      const plan = planAmend(git.repository.head, text.length > 0);
      if (plan.kind === 'no-head') return undefined;
      if (plan.warn) {
        const warning = amendWarning(true, git.repository.ahead > 0);
        const confirmed = await deps.confirm({
          title: 'Исправить последний коммит',
          message: warning ?? 'Сообщение последнего коммита будет заменено',
          detail: 'Старый коммит останется только в reflog: обычная история указывает на новый.',
          confirmLabel: 'Исправить',
        });
        if (!confirmed) return undefined;
      }
      const info = await git.commit(text, undefined, true);
      showToast(`Коммит ${info.hash} исправлен: ${info.summary}`);
      return info;
    },
  );
}
