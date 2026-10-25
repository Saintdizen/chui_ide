import { watch, type FSWatcher } from 'node:fs';
import { repositoryMetaDir } from './status';

/** Пачка правок в `.git` приходит очередью: одного пересчёта на пачку хватает. */
export const REPOSITORY_WATCH_DEBOUNCE_MS = 300;

/**
 * Слежение за метаданными репозитория активного корня.
 *
 * Зачем отдельно от общего наблюдения за рабочей папкой: коммит из терминала или
 * чужого инструмента меняет `.git/HEAD` и `.git/index`, но не файлы дерева — правки
 * в проводнике не появятся, а пометки git застынут. Общий наблюдатель за корнем
 * такие события ловит не всегда (буфер inotify переполняется на пачках правок), а
 * тут файлов мало и события редкие.
 */
export class RepositoryWatcher {
  private watcher: FSWatcher | null = null;
  /** Корень, за метаданными которого следим: чтобы не пересоздавать на каждый статус. */
  private watchedRoot: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** Без обработчика слежение не заводится: уведомлять некого. */
  constructor(private readonly onChange: (() => void) | null = null) {}

  /** Переключить наблюдение на активный корень; `null` — просто выключить. */
  sync(repoRoot: string | null): void {
    if (!this.onChange || repoRoot === this.watchedRoot) return;
    this.close();
    this.watchedRoot = repoRoot;
    if (!repoRoot) return;
    const gitDir = repositoryMetaDir(repoRoot);
    if (!gitDir) {
      this.watchedRoot = null;
      return;
    }
    try {
      const watcher = watch(gitDir, { recursive: true }, () => this.schedule());
      // Сбой наблюдения — не беда: пометки обновятся по следующему событию папки.
      watcher.on('error', () => this.close());
      this.watcher = watcher;
    } catch {
      // не на всех платформах есть рекурсивное наблюдение — живём без него
      this.watchedRoot = null;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange?.();
    }, REPOSITORY_WATCH_DEBOUNCE_MS);
  }

  /** Остановить наблюдение: выход приложения или смена корня. */
  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watchedRoot = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
