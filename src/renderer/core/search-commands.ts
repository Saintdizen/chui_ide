import type { DefineCommand } from './command-args';

/**
 * Команды поиска. Все три ведут в одну и ту же панель — разница только в том,
 * с каким запросом она открывается: пустым, готовым (TODO/FIXME) или никаким
 * (структурный поиск открывает своё окно). Поэтому порт один — панель.
 */

/**
 * Панель поиска: запуск запроса. Показ делает dock — панель уже живёт в нём,
 * и второй способ её показать был бы лишним путём к тому же результату.
 */
export interface SearchView {
  search(query: string, options?: { isRegex?: boolean }): void;
  /** Где искать: папка (или файл) проекта; `null` — весь проект. */
  setScope(path: string | null): void;
  focus(): void;
}

/** Окно структурного поиска — своё, не панель. */
export interface StructuralSearchDialog {
  open(): void;
}

export interface SearchDeps {
  dock: { show(view: 'search'): void };
  searchView: SearchView;
  structuralSearch: StructuralSearchDialog;
}

/**
 * Пометки в коде одним проходом. Регулярка ловит только целые слова: `TODOS` или
 * `hackathon` в результаты не попадают, иначе шум съел бы полезное.
 */
export const TODO_QUERY = '\\b(TODO|FIXME|HACK|XXX)\\b';

export function registerSearchCommands(define: DefineCommand, deps: SearchDeps): void {
  const { dock, searchView, structuralSearch } = deps;

  define({ id: 'search.project', title: 'Поиск по проекту', category: 'Поиск', keybinding: 'Ctrl+Shift+F' }, () =>
    dock.show('search'),
  );

  /**
   * Поиск внутри папки (или внутри файла): область задаётся путём и уходит в
   * сам запрос. Без этого «искать в папке» пришлось бы делать руками — чистить
   * лишние попадания глазами по всему проекту.
   */
  define(
    { id: 'search.inFolder', title: 'Найти в этой папке', category: 'Поиск' },
    (raw?: unknown) => {
      const path = typeof raw === 'string' && raw.length > 0 ? raw : null;
      // Область сбрасываем явно: без пути ищем по проекту, а не в прошлой папке.
      deps.searchView.setScope(path);
      deps.dock.show('search');
      deps.searchView.focus();
    },
  );

  // TODO/FIXME — тот же поиск по проекту, только запрос готовый: регулярка ловит
  // пометки одним проходом, а результаты открываются как обычно — панелью поиска.
  define(
    {
      id: 'search.todo',
      title: 'Найти TODO и FIXME',
      category: 'Поиск',
      keywords: ['todo', 'fixme', 'hack', 'пометки'],
    },
    () => {
      dock.show('search');
      searchView.search(TODO_QUERY, { isRegex: true });
    },
  );

  define({ id: 'editor.structuralReplace', title: 'Заменить по структуре', category: 'Рефакторинг' }, () =>
    structuralSearch.open(),
  );
}
