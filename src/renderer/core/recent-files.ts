/**
 * История открытых файлов — для палитры (MRU, most recently used).
 *
 * Без неё пустой `Ctrl+Shift+O` показывал начало проекта по алфавиту: чтобы открыть
 * файл, над которым работал минуту назад, надо было вспомнить его имя. VS Code в этом
 * месте сначала идёт по недавним, потом по остальным; делаем так же.
 *
 * Логика чистая и без хранилища: модуль только ведёт список в памяти, а запись на диск
 * — дело того, кто его держит (`chat-persistence` рядом посвящён тому же — сохранению
 * состояния между запусками). Поэтому здесь всё проверяется тестами без окна.
 */

/** Сколько путей помним. Дальше — шум: в палитре всё равно видно первые десятки. */
export const RECENT_FILES_LIMIT = 50;

/**
 * Список недавних путей: свежие сверху, без повторов. Живёт одним объектом на
 * приложение, а не на проект: история — привычка человека, а не свойство каталога. При
 * показе чужие проекту пути отсекаются (см. `recentFor`),
 */
export interface RecentFiles {
  paths(): readonly string[];
  /** Отметить файл открытым: он встаёт первым, прежнее место забывается. */
  remember(path: string): void;
  /** Убрать путь (файл удалён или переименован). */
  forget(path: string): void;
  /** Загрузить сохранённый список (при старте). Чужие значения отбрасываются. */
  restore(paths: readonly string[]): void;
  clear(): void;
}

/** Путь ведёт в файл: не пустой, не кончается разделителем. */
function isFileLike(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !path.endsWith('/') && !path.endsWith('\\');
}

/** Новый список недавних. `limit` — сколько путей держим (по умолчанию `RECENT_FILES_LIMIT`). */
export function createRecentFiles(limit = RECENT_FILES_LIMIT): RecentFiles {
  const keep = Math.max(1, Math.floor(limit));
  let list: string[] = [];

  /** Поставить путь в начало, убрав прежний. */
  const promote = (path: string): void => {
    list = [path, ...list.filter((item) => item !== path)].slice(0, keep);
  };

  return {
    paths: () => list.slice(),
    remember(path) {
      if (!isFileLike(path)) return;
      promote(path);
    },
    forget(path) {
      list = list.filter((item) => item !== path);
    },
    restore(paths) {
      list = [];
      // Сохранённый список мог быть испорчен правкой файла настроек: чистим так же,
      // как при обычной записи, и не даём одному пути занять две строки.
      for (const path of paths) {
        if (!isFileLike(path)) continue;
        if (list.includes(path)) continue;
        list.push(path);
        if (list.length >= keep) break;
      }
    },
    clear() {
      list = [];
    },
  };
}

/**
 * Недавние пути, которые есть в текущем проекте (относительные, как их отдаёт сервер).
 * Порядок сохраняется: первым идёт самое свежее. `exists` — проверка «есть ли такой
 * файл» — приходит снаружи: история хранит абсолютные пути, а палитра работает
 * относительными.
 */
export function recentFor(
  history: readonly string[],
  projectRoot: string | null,
  exists: (path: string) => boolean,
): string[] {
  if (!projectRoot) return [];
  const prefix = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
  const out: string[] = [];
  for (const path of history) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (!relative || !exists(relative)) continue;
    if (!out.includes(relative)) out.push(relative);
  }
  return out;
}
