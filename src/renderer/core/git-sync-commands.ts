import { asPath, type DefineCommand } from './command-args';
import { fetchResultsSummary } from '../../shared/git-multiroot';
import type { PullMode } from '../../shared/git-pull';
import { prepareDiscard, planPush } from './file-actions';
import type { GitModel } from './git-model';
import type { ToastKind } from '../ui/toast';

/** Первая содержательная строка ответа git — для уведомления: целиком оно не влезет. */
export const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? text;

/**
 * Ветки, синхронизация с удалённым и массовые действия с индексом.
 *
 * Общее у них — то, что каждая команда делает что-то разом со всем деревом:
 * переключает файлы под ногами, гонит пачку коммитов или отправляет/принимает
 * всё. Поэтому здесь всё, что можно испортить, спрашивает или предупреждает
 * заранее: несохранённые буферы — до переключения, необратимый откат —
 * системным диалогом, push без коммитов впереди — тостом вместо вызова git.
 * Как только человек выбирает ветку, зовётся `checkout` — уже после
 * `prepareCheckout`, который решает, есть ли что сохранить и надо ли спросить.
 */

export interface GitSyncDeps {
  git: GitModel;
  showToast(message: string, kind?: ToastKind): void;
  /**
   * Сохранить или спросить про несохранённое перед переключением ветки. Тело —
   * в `core/file-write.ts`: тот же ответ нужен и Ctrl+S, и коммиту.
   */
  prepareCheckout(): Promise<boolean>;
  /** Экран конфликтов; `false` — в файле конфликтов нет. */
  openConflict(path: string): Promise<boolean>;
  currentPath(): string | null;
  /** Режим pull из настроек: `default` не подсказывает git флагов. */
  pullMode(): PullMode;
  isMultiRoot(): boolean;
  confirm(options: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
  activePath(): string | null;
  hasTab(path: string): boolean;
  closeTab(path: string): void;
  /** Перечитать файл с диска после отката. */
  openPath(path: string): Promise<void>;
}

export function registerGitSyncCommands(define: DefineCommand, deps: GitSyncDeps): void {
  const { git, showToast } = deps;

  /** Разрешить конфликт слияния: экран с обеими сторонами и выбором по блокам. */
  define({ id: 'git.resolveConflicts', title: 'Разрешить конфликт слияния', category: 'Git' }, async (path) => {
    const target = asPath(path) ?? deps.currentPath();
    if (!target) {
      showToast('Откройте файл с конфликтом', 'error');
      return;
    }
    if (!(await deps.openConflict(target))) showToast('В этом файле нет конфликтов слияния');
  });

  // Переключение и создание ветки меняют файлы под ногами: несохранённый буфер они
  // не видят. Поэтому сперва prepareCheckout — сохранить или спросить.
  define({ id: 'git.checkout', title: 'Переключить ветку', category: 'Git' }, async (name) => {
    if (typeof name !== 'string' || !name) return;
    if (!(await deps.prepareCheckout())) return;
    await git.checkout(name);
    showToast(`Ветка: ${name}`);
  });

  define({ id: 'git.createBranch', title: 'Создать ветку', category: 'Git' }, async (name) => {
    const branch = typeof name === 'string' ? name.trim() : '';
    if (!branch) return;
    if (!(await deps.prepareCheckout())) return;
    await git.checkout(branch, true);
    showToast(`Ветка создана: ${branch}`);
  });

  // Синхронизация с удалённым репозиторием. Нажатие кнопки — уже решение человека,
  // поэтому отдельного вопроса не задаём; об исходе говорит уведомление, а провал
  // (нет remote, отказ авторизации, конфликт) приходит текстом от git.
  define(
    { id: 'git.fetch', title: 'Забрать изменения (fetch)', category: 'Git', enabled: () => git.isRepository },
    async () => {
      const result = await git.fetch();
      showToast(`fetch: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  // Многообласть: папок несколько, у каждой свой репозиторий — обновляем все разом.
  define(
    {
      id: 'git.fetchRoots',
      title: 'Забрать изменения во всех папках (fetch)',
      category: 'Git',
      enabled: () => deps.isMultiRoot(),
    },
    async () => {
      const results = await git.fetchRoots();
      const summary = fetchResultsSummary(results);
      showToast(summary.text, summary.ok ? 'info' : 'error');
    },
  );

  // Режим pull берём из настроек (проектных): у команд разные привычки — кому слияние,
  // кому перебазирование. `default` не подсказывает флагов, и git ведёт себя как настроен.
  define(
    { id: 'git.pull', title: 'Влить изменения (pull)', category: 'Git', enabled: () => git.isRepository },
    async () => {
      const result = await git.pull(deps.pullMode());
      showToast(`pull: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  // То же слиянием или перебазированием — разово, поверх настройки: иногда нужно
  // именно так, не меняя поведение по умолчанию.
  define(
    {
      id: 'git.pullRebase',
      title: 'Влить изменения (pull) с перебазированием',
      category: 'Git',
      enabled: () => git.isRepository,
    },
    async () => {
      const result = await git.pull('rebase');
      showToast(`pull --rebase: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  define(
    { id: 'git.push', title: 'Отправить коммиты (push)', category: 'Git', enabled: () => git.isRepository },
    async () => {
      // Счётчики считает main: без них push уходил «в пустоту» (всё отправлено) или
      // отваливался отказом non-fast-forward вместо понятного «сначала влейте».
      const repository = git.repository;
      if (!repository) return;
      const plan = planPush(repository.ahead, repository.behind);
      if (plan === 'nothing') {
        showToast('Отправлять нечего: коммитов впереди нет');
        return;
      }
      if (plan === 'rejected') {
        showToast('На удалённой ветке есть чужие коммиты: сначала влейте их (pull)', 'error');
        return;
      }
      const result = await git.push();
      showToast(`push: ${firstLine(result.message)}`, result.ok ? 'info' : 'error');
    },
  );

  define(
    {
      id: 'git.stageAll',
      title: 'Проиндексировать все изменения',
      category: 'Git',
      enabled: () => git.unstaged.length > 0,
    },
    async () => {
      const paths = git.unstaged.map((file) => file.path);
      if (paths.length === 0) {
        showToast('Нет изменений для индексации', 'error');
        return;
      }
      await git.stage(paths);
    },
  );

  define(
    { id: 'git.unstageAll', title: 'Убрать всё из индекса', category: 'Git', enabled: () => git.staged.length > 0 },
    async () => {
      const paths = git.staged.map((file) => file.path);
      if (paths.length === 0) {
        showToast('Индекс уже пуст', 'error');
        return;
      }
      await git.unstage(paths);
    },
  );

  define(
    { id: 'git.discardAll', title: 'Откатить все правки', category: 'Git', enabled: () => git.unstaged.length > 0 },
    async () => {
      const paths = git.unstaged.map((file) => file.path);
      if (paths.length === 0) {
        showToast('Нет правок для отката', 'error');
        return;
      }

      // Откат необратим: спрашиваем системным диалогом, как и для одного файла.
      const confirmed = await deps.confirm({
        title: 'Откатить все правки',
        message: 'Отменить все правки в рабочем дереве?',
        detail: `Файлов: ${paths.length}. Изменённые вернутся к последнему коммиту, новые будут удалены. Вернуть правки будет нельзя.`,
        confirmLabel: 'Откатить все',
      });
      if (!confirmed) return;

      // Вкладки убираем ДО git: новые файлы он удаляет с диска, а вкладка с их текстом
      // осталась бы — и первое же Ctrl+S воскресило бы выброшенный файл. Активность
      // помним здесь же: после закрытия `active` станет соседняя (prepareDiscard).
      const plan = prepareDiscard(paths, deps.activePath(), deps.hasTab);
      for (const path of plan.close) deps.closeTab(path);

      await git.discard(paths);
      // Файлы изменились под нами — открываем заново то, что было на экране. Без этого
      // на экране остался бы текст из прежнего снимка, а не с диска.
      // Берём его из activePath — это и есть «тот файл», а не первый в списке.
      if (plan.activePath) await deps.openPath(plan.activePath).catch(() => undefined);
      showToast('Правки откатаны');
    },
  );
}
