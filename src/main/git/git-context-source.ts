import type { GitRemote, GitStatus } from '../../shared/api';

/**
 * Всё, что вызывающий даёт модулям `./git/*` — полный набор колбэков.
 *
 * Модули объявляют не его, а свои узкие контексты из `./contexts` (или пишут
 * такой же интерфейс сами): `Source` их структурно удовлетворяет, потому что
 * содержит больше, чем любой из них просит. Так модуль не может позвать то,
 * чего не просил, а класс собирает набор в одном месте — `GitService.gitContext()`.
 */
export interface Source {
  root(): string;
  repositoryRoot(explicit?: string): Promise<string | null>;
  refresh(): Promise<GitStatus>;
  gitPath(repoRoot: string, name: string): Promise<string | null>;
  remotes(): Promise<GitRemote[]>;
}
