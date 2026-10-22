import type { DefineCommand } from './command-args';
import type { ToastKind } from '../ui/toast';

/** Окна git, которые открываются командой и сами собирают свои данные. */
export interface GitToolPanels {
  bisect(): Promise<void>;
  worktrees(): Promise<void>;
  /** Запросы на слияние площадки (PR/MR) через `gh`/`glab`. */
  pullRequests(): Promise<void>;
  issues(): Promise<void>;
  pipelines(): Promise<void>;
  notifications(): Promise<void>;
  identity(): Promise<void>;
  lfs(): Promise<void>;
  sparse(): Promise<void>;
  /** Сравнение двух ссылок: список различий и просмотр отдельного файла. */
  compareRefs(): Promise<void>;
}

export interface GitToolsDeps {
  isRepository(): boolean;
  showToast(message: string, kind?: ToastKind): void;
  panels: GitToolPanels;
  /** Забрать код подмодулей — единственная команда здесь, которая меняет диск. */
  submoduleUpdate(): Promise<void>;
}

type Opener = {
  id: string;
  title: string;
  keywords: string[];
  open(panels: GitToolPanels): Promise<void>;
};

/**
 * Окна, которые не меняют репозиторий: bisect, worktrees, интеграция с площадкой,
 * личность, LFS, sparse, сравнение веток.
 *
 * Все они — «открой окно», и различаются только именем окна. Поэтому здесь таблица,
 * а не десять одинаковых `define`: тело у всех одно и то же (проверить репозиторий и
 * открыть), и правку в повторе легко забыть в одном месте. Данные для окон собирают
 * сами окна — команде нечего готовить заранее.
 */
const OPENERS: readonly Opener[] = [
  {
    id: 'git.bisect',
    title: 'Найти багованный коммит (bisect)',
    keywords: ['bisect', 'бисект', 'плохой коммит', 'поиск'],
    open: (panels) => panels.bisect(),
  },
  {
    id: 'git.worktrees',
    title: 'Рабочие каталоги (worktree)',
    keywords: ['worktree', 'каталог', 'ветка', 'ворктри'],
    open: (panels) => panels.worktrees(),
  },
  {
    id: 'git.pullRequests',
    title: 'Запросы на слияние (PR/MR)',
    keywords: ['pr', 'mr', 'pull request', 'merge request', 'github', 'gitlab', 'запрос', 'слияние'],
    open: (panels) => panels.pullRequests(),
  },
  {
    id: 'git.issues',
    title: 'Задачи площадки (issues)',
    keywords: ['issue', 'issues', 'задача', 'задачи', 'github', 'gitlab', 'ticket'],
    open: (panels) => panels.issues(),
  },
  {
    id: 'git.pipelines',
    title: 'Прогоны CI (Actions/Pipelines)',
    keywords: ['ci', 'actions', 'pipelines', 'прогон', 'сборка', 'github', 'gitlab'],
    open: (panels) => panels.pipelines(),
  },
  {
    id: 'git.notifications',
    title: 'Уведомления площадки',
    keywords: ['уведомления', 'notifications', 'todos', 'github', 'gitlab', 'непрочитано'],
    open: (panels) => panels.notifications(),
  },
  {
    id: 'git.identity',
    title: 'Личность и подпись коммитов',
    keywords: ['подпись', 'gpg', 'ssh', 'signing', 'key', 'author', 'имя', 'почта', 'co-authored-by'],
    open: (panels) => panels.identity(),
  },
  {
    id: 'git.lfs',
    title: 'Большие файлы (Git LFS)',
    keywords: ['lfs', 'большие файлы', 'хранилище', 'gitattributes'],
    open: (panels) => panels.lfs(),
  },
  {
    id: 'git.sparse',
    title: 'Разреженный рабочий каталог…',
    keywords: ['sparse', 'разреженный', 'sparse-checkout', 'монорепо', 'папки'],
    open: (panels) => panels.sparse(),
  },
  {
    id: 'git.compareBranches',
    title: 'Сравнить ветки',
    keywords: ['diff', 'ветки', 'сравнить', 'различия'],
    open: (panels) => panels.compareRefs(),
  },
];

export function registerGitToolsCommands(define: DefineCommand, deps: GitToolsDeps): void {
  const { showToast } = deps;
  const enabled = (): boolean => deps.isRepository();

  for (const opener of OPENERS) {
    define({ id: opener.id, title: opener.title, keywords: opener.keywords, category: 'Git', enabled }, async () => {
      // Проверяем и здесь: команду зовут не только из палитры (где `enabled` гасит
      // пункт), но и из меню, горячих клавиш и агента.
      if (!deps.isRepository()) {
        showToast('Проект не в репозитории git', 'error');
        return;
      }
      await opener.open(deps.panels);
    });
  }

  // Подмодули: в дереве они помечены значком, а забрать их код можно только здесь.
  define(
    {
      id: 'git.submoduleUpdate',
      title: 'Обновить подмодули',
      keywords: ['submodule', 'подмодуль', 'init', 'update'],
      category: 'Git',
      enabled,
    },
    async () => {
      if (!deps.isRepository()) {
        showToast('Проект не в репозитории git', 'error');
        return;
      }
      // Идёт по сети: показываем, что работа началась, иначе пауза выглядит как зависание.
      showToast('Забираю подмодули…');
      try {
        await deps.submoduleUpdate();
        showToast('Подмодули обновлены');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  );
}
