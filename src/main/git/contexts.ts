import type { GitRemote, GitStatus } from '../../shared/api';

/**
 * Что модулям `./git/*` нужно от `GitService`.
 *
 * Контексты разные не из вредности: модуль объявляет только то, на что его тело
 * реально опирается, и `lfs.ts` не может позвать `refresh`, которого не просил.
 * Но у корня и статуса есть свойства, которые легко потерять при переносе, —
 * про них этот файл.
 */

/**
 * Корни проекта и репозитория.
 *
 * `root()` — рабочая папка проекта и бросает, если проекта нет: её зовут в самом
 * начале операции, и «папки нет» оттуда — ошибка, а не пустой ответ.
 *
 * `repositoryRoot()` возвращает `null`, если папка не репозиторий git. Проект
 * вправе его не иметь (открыли просто папку), так что `null` — это ответ, а не
 * сбой. `explicit` — корень, названный вызывающим, выше рабочей папки не поднимаемся.
 */
export interface RepositoryContext {
  root(): string;
  repositoryRoot(explicit?: string): Promise<string | null>;
}

/**
 * Пересчёт статуса **и** рассылка `GitChanged`.
 *
 * Это не «перечитать статус»: после операции на диске меняется много файлов
 * сразу (checkout, submodule update, rebase), и UI узнаёт о них только из этой
 * рассылки. Модуль, которому нужен только свежий статус, получает `refresh`
 * и не обязан знать, что за ним стоит уведомление.
 */
export interface StatusContext {
  refresh(): Promise<GitStatus>;
}

/**
 * Путь внутри `.git` — для того, что git хранит своими файлами (`rebase-merge`,
 * hooks, shallow). У связанных рабочих каталогов `.git` — файл, а не папка,
 * поэтому строить путь склейкой корня нельзя: модуль обязан спросить `gitPath`.
 */
export interface GitDirContext {
  gitPath(repoRoot: string, name: string): Promise<string | null>;
}

/** Свежий статус: его запрашивают `locate` и `discard`, а не берут из кеша. */
export interface SnapshotContext {
  status(): Promise<GitStatus>;
}

/**
 * Индекс и рабочее дерево: галочки в списке изменений и полоски на полях файла.
 * Нужны и свежий статус (он один знает корень и относительный путь файла), и
 * рассылка `GitChanged` после каждого действия.
 */
export interface WorktreeContext extends SnapshotContext, StatusContext {}

/**
 * Чтение истории: «что было», а не «что поменять». Ничего не пишет и не
 * рассылает `GitChanged`, поэтому в контексте только корень репозитория.
 * `null` от `repositoryRoot` здесь — пустой ответ, а не сбой.
 */
export interface HistoryContext extends RepositoryContext {}

/** Удалённые репозитории: `forge.ts` и `network.ts` решают по ним, что показать. */
export interface RemoteContext {
  remotes(): Promise<GitRemote[]>;
}
