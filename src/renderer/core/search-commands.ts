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
export interface SearchPanel {
  search(query: string, options: { isRegex: boolean }): void;
}

/** Окно структурного поиска — своё, не панель. */
export interface StructuralSearchDialog {
  open(): void;
}

export interface SearchDeps {
  dock: { show(view: 'search'): void };
  searchView: SearchPanel;
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
