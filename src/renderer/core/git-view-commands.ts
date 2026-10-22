import { asPath, type DefineCommand } from './command-args';
import type { GitModel } from './git-model';
import type { ToastKind } from '../ui/toast';

/**
 * Команды git, которые показывают, а не меняют: сравнение файла, замечания
 * к ревью, blame и полоски изменений в жёлобе.
 *
 * Здесь же весь диалог с человеком: если показать нечего, об этом сообщают
 * не всплывающим исключением, а тостом с объяснением причины.
 */
export interface GitViewDeps {
  git: GitModel;
  showToast(message: string, kind?: ToastKind): void;
  /** Сравнение файла; `commit` — показать файл в состоянии этого коммита. */
  openDiff(path: string, staged: boolean, commit?: string): Promise<void>;
  diffIsOpen(): boolean;
  showDiffComments(): void;
  currentPath(): string | null;
  cursorLine(): number;
  toggleBlame(): boolean;
  toggleFileBlame(): boolean;
  toggleChangeGutter(): boolean;
}

export function registerGitViewCommands(define: DefineCommand, deps: GitViewDeps): void {
  const { git, showToast } = deps;

  define({ id: 'git.showDiff', title: 'Показать различия файла', category: 'Git' }, async (path, staged) => {
    const target = asPath(path);
    if (target) await deps.openDiff(target, staged === true);
  });

  /** Замечания к коду: сравнение файла и лента замечаний сбоку. */
  define({ id: 'git.reviewComments', title: 'Замечания к коду в сравнении', category: 'Git' }, async () => {
    const path = deps.currentPath();
    if (!path) {
      showToast('Откройте файл, чтобы оставить замечание', 'error');
      return;
    }
    const staged = git.statusOf(path)?.staged === true;
    if (!deps.diffIsOpen()) await deps.openDiff(path, staged);
    deps.showDiffComments();
  });

  /** Показать или скрыть автора строки у курсора (blame). */
  define({ id: 'git.toggleBlame', title: 'Автор строки (blame): показать/скрыть', category: 'Git' }, () => {
    const on = deps.toggleBlame();
    showToast(on ? 'Blame включён: у строки под курсором видно автора' : 'Blame выключен');
  });

  /** Подписи blame у всех строк файла: разом видно, кто и когда писал каждую строку. */
  define({ id: 'git.toggleFileBlame', title: 'Blame всего файла: показать/скрыть', category: 'Git' }, () => {
    const on = deps.toggleFileBlame();
    showToast(on ? 'Подписи у всех строк файла включены' : 'Подписи у всех строк файла выключены');
  });

  /** Перейти к коммиту, изменившему строку под курсором. */
  define({ id: 'git.showLineCommit', title: 'Коммит строки под курсором', category: 'Git' }, async () => {
    const path = deps.currentPath();
    if (!path) {
      showToast('Откройте файл, строку которого смотрите', 'error');
      return;
    }
    const at = deps.cursorLine();
    const lines = await git.blame(path, { startLine: at, endLine: at }).catch(() => []);
    const line = lines[0];
    if (!line) {
      showToast('У этой строки нет истории: файл не в git или строка не менялась', 'error');
      return;
    }
    await deps.openDiff(path, false, line.hash);
  });

  /** Показать или скрыть полоски изменений в жёлобе редактора. */
  define(
    { id: 'git.toggleChangeGutter', title: 'Полоски изменений в жёлобе: показать/скрыть', category: 'Git' },
    () => {
      const on = deps.toggleChangeGutter();
      showToast(on ? 'Полоски изменений включены' : 'Полоски изменений скрыты');
    },
  );
}
