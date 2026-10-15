import { clear, h, svgIcon } from './dom';

/**
 * Полоса вкладок бесед и поиск по ним.
 *
 * Вынесено из `chat.ts`: панель ведёт разговор и хранит беседы, а полоса
 * вкладок — это вид. Модуль не знает состояния бесед: список приходит в
 * `render` готовыми строками, а действия (переключить, закрыть, открыть меню,
 * перейти к найденному) уходят наружу колбэками. Так вкладки можно менять,
 * не задевая логику беседы.
 */

/** Больше строк не нужно: список поиска и без того длинный. */
const MAX_SEARCH_HITS = 30;

/** Строка вкладки: как её видно в полосе. */
export interface ChatTabItem {
  id: number;
  title: string;
  /** В этой беседе идёт генерация — вкладка помечается пульсирующей точкой. */
  streaming: boolean;
}

/** Найденное место в беседе — по одной строке на беседу. */
export interface ChatSearchHit {
  id: number;
  title: string;
  snippet: string;
}

export interface ChatTabsDeps {
  /** Переключиться на беседу. */
  onActivate(id: number): void;
  /** Закрыть беседу. */
  onClose(id: number): void;
  /** Новая беседа. */
  onNewChat(): void;
  /** Контекстное меню вкладки (перенос в редактор и закрытие). */
  onMenu(id: number, event: MouseEvent): void;
  /** Пройтись по беседам и вернуть найденные места (не больше `MAX_SEARCH_HITS`). */
  search(query: string): ChatSearchHit[];
  /** Перейти к найденному месту в беседе. */
  onPickSearch(id: number, query: string): void;
  /** Вернуть фокус в поле ввода: поиск закрыли — курсор снова в вопросе. */
  focusInput(): void;
}

export interface ChatTabsView {
  /** Шапка панели: полоса вкладок и кнопки действий. */
  element: HTMLElement;
  /** Полоса поиска по беседам: стоит под шапкой, пока поиск открыт. */
  searchBar: HTMLElement;
  /** Перерисовать полосу по списку бесед. */
  render(items: readonly ChatTabItem[], activeId: number): void;
}

export function createChatTabs(deps: ChatTabsDeps): ChatTabsView {
  const tabList = h('div', { class: 'tabs chat-tab-list' });
  const newChatButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Новая беседа', onClick: () => deps.onNewChat() },
    svgIcon('plus', 15),
  );

  const searchInput = h('input', {
    class: 'chat-search-input',
    type: 'text',
    spellcheck: false,
    placeholder: 'Поиск по всем беседам',
  });
  const searchResults = h('div', { class: 'chat-search-results', hidden: true });
  const searchBar = h('div', { class: 'chat-search', hidden: true }, searchInput, searchResults);
  const searchButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Поиск по беседам', onClick: () => toggleSearch() },
    svgIcon('search', 14),
  );

  /** Таймер отложенного поиска: ввод идёт быстро, а поиск — по всей истории. */
  let searchTimer = 0;

  function toggleSearch(): void {
    searchBar.hidden = !searchBar.hidden;
    if (searchBar.hidden) {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = 0;
      searchInput.value = '';
      searchResults.hidden = true;
      clear(searchResults);
      deps.focusInput();
    } else {
      searchInput.focus();
    }
  }

  function runSearch(): void {
    const query = searchInput.value.trim().toLowerCase();
    clear(searchResults);
    if (!query) {
      searchResults.hidden = true;
      return;
    }

    const hits = deps.search(query).slice(0, MAX_SEARCH_HITS);
    searchResults.hidden = false;
    if (hits.length === 0) {
      searchResults.appendChild(h('div', { class: 'chat-search-empty' }, 'Ничего не найдено'));
      return;
    }

    for (const hit of hits) {
      searchResults.appendChild(
        h(
          'button',
          {
            class: 'chat-search-item',
            type: 'button',
            onClick: () => deps.onPickSearch(hit.id, query),
          },
          h('span', { class: 'chat-search-title' }, hit.title),
          h('span', { class: 'chat-search-snippet' }, hit.snippet),
        ),
      );
    }
  }

  // Ищем с короткой задержкой: одна буква — один проход по всем беседам, а
  // набирают их быстрее, чем нужен результат.
  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 120);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      toggleSearch();
    }
  });

  function render(items: readonly ChatTabItem[], activeId: number): void {
    clear(tabList);
    for (const item of items) {
      const isActive = item.id === activeId;
      // Классы — как у вкладок редактора: одна полоса, одно поведение, один вид.
      const classes = ['tab', 'chat-tab'];
      if (isActive) classes.push('is-active');
      if (item.streaming) classes.push('is-busy');

      const tab = h(
        'div',
        {
          class: classes.join(' '),
          role: 'tab',
          tabindex: '0',
          'aria-selected': String(isActive),
          // Пульс точки — не единственный носитель «идёт генерация»: то же сказано
          // подписью для наведения и `aria-label` для озвучки — важное нельзя
          // передавать только анимацией. Под «уменьшить движение» точка статична, а
          // смысл остаётся.
          title: item.streaming ? `${item.title} — идёт генерация` : item.title,
          'aria-label': item.streaming ? `${item.title}, идёт генерация` : undefined,
        },
        svgIcon('chat', 13),
        h('span', { class: 'tab-label' }, item.title),
      );

      tab.addEventListener('click', () => deps.onActivate(item.id));
      tab.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        deps.onMenu(item.id, event);
      });
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        deps.onActivate(item.id);
      });
      // Средняя кнопка мыши закрывает вкладку — так же, как вкладки файлов.
      tab.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        deps.onClose(item.id);
      });

      // Крестик есть и у единственной беседы: без него вкладка выглядит
      // незаконченной, а отступы справа и слева расходятся (слева иконка, справа пусто).
      tab.appendChild(
        h(
          'button',
          {
            class: 'tab-close',
            type: 'button',
            title: 'Закрыть беседу',
            onClick: (event) => {
              event.stopPropagation();
              deps.onClose(item.id);
            },
          },
          svgIcon('close', 11),
        ),
      );

      tabList.appendChild(tab);
    }
  }

  const element = h(
    'div',
    { class: 'panel-header chat-tabs' },
    tabList,
    h('div', { class: 'panel-actions' }, searchButton, newChatButton),
  );

  return { element, searchBar, render };
}
