import { asPath, type DefineCommand } from './command-args';
import type { PopupMenuItem } from '../ui/popup-menu';
import type { ToastKind } from '../ui/toast';
import type { GitModel } from './git-model';
import { type GitResult, gitStepNotice, rebaseNotice } from './git-notice';

/**
 * История и теги: там, где человек выбирает коммит или ветку в списке.
 *
 * Почти всё здесь — «показать список и выполнить выбранное»: журнал коммитов,
 * теги, reflog, история файла. Списки открывает хозяин попапа, поэтому в deps
 * приходит одна функция `popup`, а не координаты с якорем: команду зовут и из
 * палитры, где якоря под курсором нет.
 */
export interface GitHistoryDeps {
  git: GitModel;
  showToast(message: string, kind?: ToastKind): void;
  /** Системный диалог: сброс ветки и отмена коммита необратимы. */
  confirm(options: { title: string; message: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /** Спросить строку: имя тега или ветки. `null` — человек отказался. */
  ask(options: { title: string; label: string; value: string }): Promise<string | null>;
  popup(items: PopupMenuItem[]): void;
  /** Выполнить другую команду (в списке тегов есть «Создать тег…»). */
  execute(id: string): void;
  openRebase(): Promise<void>;
  /** Сравнение версии файла с текущим текстом. */
  openDiff(path: string, commit: string): Promise<void>;
  currentPath(): string | null;
}

export function registerGitHistoryCommands(define: DefineCommand, deps: GitHistoryDeps): void {
  const { git, showToast } = deps;

  /**
   * Итог операции с историей одним сообщением. Rebase может не закончиться: он
   * останавливается на конфликте или на шаге правки — об этом говорим отдельно,
   * а не показываем текст git как ошибку.
   */
  const reportRebase = (result: GitResult): void => {
    const notice = rebaseNotice(result);
    showToast(notice.message, notice.kind);
  };

  /**
   * Пропуск шага: rebase после него продолжается, поэтому «исправьте коммит
   * и продолжите» тут было бы прямой подсказкой сделать не то.
   */
  const reportStep = (result: GitResult, done: string): void => {
    const notice = gitStepNotice(result, done);
    showToast(notice.message, notice.kind);
  };

  /** Интерактивный rebase: список коммитов собирает своё окно. */
  define(
    {
      id: 'git.rebase',
      title: 'Перестроить историю (interactive rebase)',
      category: 'Git',
      keywords: ['rebase', 'squash', 'fixup', 'склеить', 'переставить'],
      enabled: () => git.isRepository,
    },
    async () => {
      if (!git.isRepository) {
        showToast('Проект не в репозитории git', 'error');
        return;
      }
      await deps.openRebase();
    },
  );

  define({ id: 'git.rebaseContinue', title: 'Rebase: продолжить', category: 'Git' }, async () => {
    try {
      reportRebase(await git.rebaseContinue());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  define({ id: 'git.rebaseSkip', title: 'Rebase: пропустить коммит', category: 'Git' }, async () => {
    try {
      reportStep(await git.rebaseSkip(), 'Коммит пропущен, rebase идёт дальше');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  define({ id: 'git.rebaseAbort', title: 'Rebase: прервать', category: 'Git' }, async () => {
    try {
      await git.rebaseAbort();
      showToast('Rebase прерван, ветка на прежнем месте');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /* ── отдельные коммиты и теги ─────────────────────────────────────────── */

  /** Сбросить ветку на коммит. Режим выбирает, что будет с правками; спрашиваем всегда. */
  const resetTo = async (mode: 'soft' | 'mixed' | 'hard', hash: string, summary: string): Promise<void> => {
    const detail =
      mode === 'hard'
        ? 'Правки в рабочем дереве и индексе будут потеряны безвозвратно.'
        : mode === 'mixed'
          ? 'Индекс сбросится, правки в файлах останутся.'
          : 'Правки останутся и в файлах, и в индексе — они не пропадут.';
    const confirmed = await deps.confirm({
      title: 'Сброс ветки',
      message: `Сбросить ${git.branch ?? 'ветку'} на ${hash}?`,
      detail: `${summary}\n${detail}`,
      confirmLabel: mode === 'hard' ? 'Сбросить жёстко' : 'Сбросить',
    });
    if (!confirmed) return;
    try {
      await git.reset(mode, hash);
      showToast(`Ветка сброшена на ${hash}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  /** Действия над одним коммитом: перенос, откат и сброс ветки на него. */
  const commitActions = (hash: string, summary: string): PopupMenuItem[] => [
    {
      label: 'Перенести в текущую ветку (cherry-pick)',
      onSelect: () => {
        void git.cherryPick(hash).then(
          () => showToast(`Коммит ${hash} перенесён`),
          (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
        );
      },
    },
    {
      label: 'Отменить коммит (revert)',
      onSelect: () => {
        void git.revert(hash).then(
          () => showToast(`Коммит ${hash} отменён`),
          (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
        );
      },
    },
    { separator: true },
    {
      label: 'Сбросить ветку на этот коммит',
      submenu: [
        { label: 'Мягкий (soft) — правки в индексе', onSelect: () => void resetTo('soft', hash, summary) },
        { label: 'Смешанный (mixed) — индекс чист', onSelect: () => void resetTo('mixed', hash, summary) },
        {
          label: 'Жёсткий (hard) — правки теряются',
          danger: true,
          onSelect: () => void resetTo('hard', hash, summary),
        },
      ],
    },
  ];

  /** История коммитов репозитория: у каждого — действия над этим коммитом. */
  define({ id: 'git.showLog', title: 'История коммитов', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    const commits = await git.log(undefined, 50);
    if (commits.length === 0) {
      showToast('Коммитов ещё нет');
      return;
    }
    deps.popup(
      commits.map((commit) => ({
        label: `${commit.hash} ${commit.date} ${commit.author}`,
        hint: commit.summary,
        submenu: commitActions(commit.hash, commit.summary),
      })),
    );
  });

  /** Создать тег на текущем коммите. */
  define({ id: 'git.createTag', title: 'Создать тег', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    const name = await deps.ask({ title: 'Создать тег', label: 'Имя тега', value: '' });
    if (!name) return;
    try {
      await git.createTag(name);
      showToast(`Тег ${name} создан`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** Теги: список с действиями и создание нового. */
  define({ id: 'git.tags', title: 'Теги', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    const tags = await git.tags();
    const items: PopupMenuItem[] = [
      { label: 'Создать тег…', onSelect: () => void deps.execute('git.createTag') },
      { separator: true },
    ];
    if (tags.length === 0) {
      items.push({ label: 'Тегов нет', hint: 'поставьте первый', onSelect: () => undefined });
    }
    for (const tag of tags) {
      items.push({
        label: tag.name,
        hint: tag.commit,
        submenu: [
          {
            label: 'Переключиться на тег',
            onSelect: () => {
              void deps
                .confirm({
                  title: 'Переключение на тег',
                  message: `Перейти на тег ${tag.name}?`,
                  detail: 'Ветка станет отсоединённой (detached HEAD): новые коммиты в неё не попадут.',
                  confirmLabel: 'Перейти',
                })
                .then((confirmed) => (confirmed ? git.checkout(tag.name) : undefined))
                .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'));
            },
          },
          {
            label: 'Отправить в origin',
            onSelect: () => {
              void git.pushTag(tag.name).then(
                (result) => showToast(result.message),
                (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
              );
            },
          },
          { separator: true },
          {
            label: 'Удалить тег',
            danger: true,
            onSelect: () => {
              void deps
                .confirm({
                  title: 'Удалить тег',
                  message: `Удалить тег ${tag.name}?`,
                  detail: 'Удалённый тег останется в origin — там его нужно убирать отдельно.',
                  confirmLabel: 'Удалить',
                })
                .then((confirmed) => (confirmed ? git.deleteTag(tag.name) : undefined))
                .then(() => undefined)
                .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'));
            },
          },
        ],
      });
    }
    deps.popup(items);
  });

  /** Отменить последний коммит, оставив его правки в индексе (reset --soft HEAD~1). */
  define({ id: 'git.undoCommit', title: 'Отменить последний коммит (правки остаются)', category: 'Git' }, async () => {
    if (!git.repository?.head) {
      showToast('Коммитов ещё нет', 'error');
      return;
    }
    const confirmed = await deps.confirm({
      title: 'Отменить коммит',
      message: 'Отменить последний коммит?',
      detail: 'Коммит уйдёт из истории, а его правки останутся в индексе — их можно поправить и закоммитить заново.',
      confirmLabel: 'Отменить коммит',
    });
    if (!confirmed) return;
    try {
      await git.reset('soft', 'HEAD~1');
      showToast('Последний коммит отменён, правки в индексе');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** Журнал ссылок: сюда смотрят, чтобы откатить неудачный merge, rebase или reset. */
  define({ id: 'git.reflog', title: 'Журнал ссылок (reflog)', category: 'Git' }, async () => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    const entries = await git.reflog(50);
    if (entries.length === 0) {
      showToast('Журнал ссылок пуст');
      return;
    }
    deps.popup(
      entries.map((entry) => ({
        label: `${entry.ref} → ${entry.hash}`,
        hint: entry.action,
        submenu: [
          {
            label: 'Перенести в текущую ветку (cherry-pick)',
            onSelect: () => {
              void git.cherryPick(entry.hash).then(
                () => showToast(`Коммит ${entry.hash} перенесён`),
                (error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'),
              );
            },
          },
          { separator: true },
          {
            label: 'Сбросить ветку сюда (soft) — правки в индексе',
            onSelect: () => void resetTo('soft', entry.hash, entry.action),
          },
          { label: 'Сбросить ветку сюда (mixed)', onSelect: () => void resetTo('mixed', entry.hash, entry.action) },
          {
            label: 'Сбросить ветку сюда (hard) — правки теряются',
            danger: true,
            onSelect: () => void resetTo('hard', entry.hash, entry.action),
          },
        ],
      })),
    );
  });

  /** Удалить ветку. Имя можно передать аргументом, иначе спрашиваем. */
  define({ id: 'git.deleteBranch', title: 'Удалить ветку', category: 'Git' }, async (nameArg) => {
    if (!git.isRepository) {
      showToast('Проект не в репозитории git', 'error');
      return;
    }
    const name =
      typeof nameArg === 'string' && nameArg
        ? nameArg
        : await deps.ask({ title: 'Удалить ветку', label: 'Имя ветки', value: '' });
    if (!name) return;
    try {
      await git.deleteBranch(name);
      showToast(`Ветка ${name} удалена`);
    } catch (error) {
      // git не даёт удалить невлитую ветку — предложим сделать это силой.
      const confirmed = await deps.confirm({
        title: 'Ветка не влита',
        message: `Удалить ветку ${name} принудительно?`,
        detail: error instanceof Error ? error.message : String(error),
        confirmLabel: 'Удалить принудительно',
      });
      if (!confirmed) return;
      try {
        await git.deleteBranch(name, true);
        showToast(`Ветка ${name} удалена принудительно`);
      } catch (forced) {
        showToast(forced instanceof Error ? forced.message : String(forced), 'error');
      }
    }
  });

  /** Переименовать текущую ветку. */
  define({ id: 'git.renameBranch', title: 'Переименовать текущую ветку', category: 'Git' }, async () => {
    const from = git.branch;
    if (!git.isRepository || !from) {
      showToast('Мы не на ветке — переименовывать нечего', 'error');
      return;
    }
    const to = await deps.ask({ title: 'Переименовать ветку', label: `Новое имя для «${from}»`, value: from });
    if (!to || to === from) return;
    try {
      await git.renameBranch(from, to);
      showToast(`Ветка переименована в ${to}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** Добавить файл (или файлы) в .gitignore. Пути принимаем аргументом команды. */
  define({ id: 'git.ignore', title: 'Добавить в .gitignore', category: 'Git' }, async (pathArg) => {
    const paths = Array.isArray(pathArg)
      ? (pathArg as unknown[]).filter((item): item is string => typeof item === 'string')
      : typeof pathArg === 'string'
        ? [pathArg]
        : [];
    if (paths.length === 0) {
      showToast('Нечего добавлять: файл не выбран', 'error');
      return;
    }
    try {
      await git.ignore(paths);
      showToast(paths.length === 1 ? 'Добавлено в .gitignore' : `В .gitignore добавлено файлов: ${paths.length}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  /** История коммитов файла: выбор записи открывает сравнение с текущим текстом. */
  define({ id: 'git.fileHistory', title: 'История файла', category: 'Git' }, async (path) => {
    const target = asPath(path) ?? deps.currentPath();
    if (!target) {
      showToast('Откройте файл, историю которого хотите посмотреть', 'error');
      return;
    }

    const commits = await git.log(target, 50);
    if (commits.length === 0) {
      showToast('Истории нет: файл не в git или коммитов ещё нет');
      return;
    }

    // Команда может прийти и из палитры, поэтому якоря под курсором нет —
    // отсчитываем панель от угла самой области редактора.
    deps.popup(
      commits.map((commit) => ({
        label: `${commit.hash} ${commit.date} ${commit.author}`,
        hint: commit.summary,
        onSelect: () => void deps.openDiff(target, commit.hash),
      })),
    );
  });
}
