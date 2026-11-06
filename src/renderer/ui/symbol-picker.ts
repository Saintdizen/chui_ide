import { filterSymbols, type ProjectSymbol } from '../../shared/lsp-symbols';
import { basename } from '../../shared/languages';
import type { RpcClient } from '../core/rpc';
import { clear, dialogOverlay, h, svgIcon } from './dom';
import { focusOwner, returnFocus } from './focus-return';

/**
 * Поиск символа по всему проекту (`Ctrl+T`).
 *
 * Отличие от быстрого открытия файла: там ищут файл, здесь — класс, функцию или
 * переменную, не зная, в каком они файле. Список даёт языковой сервер
 * (`workspace/symbol`), поэтому строки появляются по мере ввода, а не заранее:
 * держать у себя все символы проекта было бы и дорого, и неактуально.
 *
 * Запрос уходит с задержкой: пока человек печатает, спрашивать сервер на каждую
 * букву бессмысленно. Ответ сервера фильтруем ещё раз — по подстроке и без повторов.
 */

export interface SymbolPickerDeps {
  rpc: RpcClient;
  /** Открыть файл символа и встать на его позицию. `side` — в соседнюю панель. */
  openSymbol(symbol: ProjectSymbol, side?: boolean): void;
  /**
   * Источник символов. Нет — символы всего проекта через `lsp.symbols` (Ctrl+T).
   * Задан — палитра работает по нему же: символы ОДНОГО файла и т.п.
   */
  source?: SymbolPickerSource;
}

/** Откуда брать символы и как их подписывать. */
export interface SymbolPickerSource {
  /** Подсказка в поле ввода. */
  placeholder: string;
  /** Получить символы по запросу (уже отсортированный/отфильтрованный сервером). */
  load(query: string): Promise<ProjectSymbol[]>;
  /** Считать `container` хлебной тропой (вложенность), а не «местом». */
  breadcrumb?: boolean;
  /** С какой длины запроса спрашивать. 0 — показать всё сразу (символы файла). */
  minQuery?: number;
}

export interface SymbolPickerView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/** С какой длины запроса идти к серверу: одна буква даст сотни совпадений. */
const MIN_QUERY = 2;
/** Пауза после нажатия: серверу тоже нужно время, а список — не мгновенный. */
const DEBOUNCE = 250;

/**
 * Почему список символов пуст (п.10).
 *
 * Без этого на три разных события показывалось одно «Ничего не найдено»,
 * и человек с пустого экрана не понимал, что делать: набрать точнее, снять
 * `@вид` или сменить проект — шаги разные.
 */
export function symbolEmptyReason(state: {
  /** Символов в источнике (проекте или языке). */
  found: number;
  /** Был запрос вида `@метод`: именно он мог отсечь всё. */
  kindQuery?: string;
  /** Сколько прошло фильтр по виду. */
  kindSize?: number;
}): string {
  if (state.found === 0) return 'В проекте не нашлось символов этого языка';
  if (state.kindQuery && state.kindSize === 0) return `Символов вида «${state.kindQuery}» нет`;
  return 'Ничего не найдено — попробуйте короче';
}

export function createSymbolPicker(deps: SymbolPickerDeps): SymbolPickerView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: deps.source?.placeholder ?? 'Имя символа — класс, функция, переменная…',
    spellcheck: false,
  });
  const list = h('div', { class: 'palette-list' });
  const overlay = dialogOverlay(h('div', { class: 'palette' }, input, list), {
    label: 'Символы проекта',
  });

  let matches: ProjectSymbol[] = [];
  /** Сколько символов вернул источник и сколько из них прошло фильтр по виду. */
  let sourceSize = 0;
  let kindSize = 0;
  /**
   * Запомненный фильтр по виду (`@метод`): `render` рисует пустой экран уже
   * после фильтра, и без этого поля не отличить «вид не совпал» от «текст не совпал».
   */
  let kindQuery: string | undefined;
  let cursor = 0;
  let timer: number | null = null;
  /** Номер последнего запроса: старый ответ не должен затирать новый. */
  let requestId = 0;
  let loading = false;

  function run(symbol: ProjectSymbol, side = false): void {
    close();
    deps.openSymbol(symbol, side);
  }

  function render(): void {
    clear(list);
    cursor = Math.min(cursor, Math.max(matches.length - 1, 0));

    if (loading) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Ищу символы…'));
      return;
    }

    const query = input.value.trim();
    const minQuery = deps.source?.minQuery ?? MIN_QUERY;
    if (query.length < minQuery) {
      list.appendChild(h('div', { class: 'palette-empty' }, `Введите хотя бы ${minQuery} символа`));
      return;
    }

    if (matches.length === 0) {
      // Причина важнее вывода (п.10): «Ничего не найдено» на проекте без
      // символов и на неудачном запросе — разные вещи с разным следующим шагом.
      list.appendChild(
        h('div', { class: 'palette-empty' }, symbolEmptyReason({ found: sourceSize, kindSize, kindQuery })),
      );
      return;
    }

    matches.forEach((symbol, index) => {
      const dir = symbol.path.slice(0, Math.max(symbol.path.length - basename(symbol.path).length - 1, 0));
      // У символа из зависимости вместо пути проекта — пакет: `requests` говорит о месте
      // больше, чем `…/site-packages/requests/sessions.py`.
      // Хлебная тропа: `container` — это вложенность (класс › метод), а не место файла.
      const breadcrumb = deps.source?.breadcrumb;
      const category = breadcrumb
        ? (symbol.container ?? symbol.path)
        : symbol.package
          ? `${symbol.package}${symbol.container ? ` · ${symbol.container}` : ''}`
          : (symbol.container ?? dir);
      const item = h(
        'button',
        { class: `palette-item${index === cursor ? ' is-active' : ''}`, type: 'button' },
        svgIcon('file', 13),
        h('span', { class: 'palette-item-title' }, symbol.name),
        h('span', { class: 'palette-item-kind' }, symbol.kind),
        h('span', { class: 'palette-item-category' }, category),
      );
      item.addEventListener('click', () => run(symbol));
      item.addEventListener('mousemove', () => {
        if (cursor === index) return;
        cursor = index;
        render();
      });
      list.appendChild(item);
    });
  }

  async function ask(query: string): Promise<void> {
    const id = (requestId += 1);
    loading = true;
    render();
    const found = deps.source
      ? await deps.source.load(query).catch(() => [])
      : await deps.rpc.request('lsp.symbols', { query }).catch(() => []);
    // Пока ходили, запрос или текст могли смениться — тогда ответ уже не нужен.
    if (id !== requestId) return;
    loading = false;
    // Фильтр по виду символа: `@метод` (женский/мужской падеж — по началу слова).
    kindQuery = /@(\S+)/.exec(query)?.[1];
    const text = query.replace(/@\S*/, '').trim();
    const byKind = kindQuery ? found.filter((s) => s.kind.toLowerCase().startsWith(kindQuery!.toLowerCase())) : found;
    matches = filterSymbols(byKind, text);
    // Запоминаем размеры: без них пустой экран не отличить от «символов нет
    // вовсе» и от «не совпал вид».
    sourceSize = found.length;
    kindSize = byKind.length;
    render();
  }

  function scheduleQuery(): void {
    if (timer !== null) window.clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      // Запрос отменяем: иначе ответ придёт на пустой список и собьёт показ.
      requestId += 1;
      loading = false;
      matches = [];
      render();
      return;
    }
    timer = window.setTimeout(() => void ask(query), DEBOUNCE);
  }

  input.addEventListener('input', () => {
    cursor = 0;
    scheduleQuery();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, matches.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = matches[cursor];
      // Ctrl+Enter — в соседнюю панель (как VS Code): сравнить, не теряя текущий вид.
      if (target) run(target, event.ctrlKey || event.metaKey);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  /** Чей фокус был до открытия: уйдёт в поле запроса, вернём ему же. */
  let owner: HTMLElement | null = null;

  function close(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    requestId += 1;
    overlay.hidden = true;
    // Фокус забирали себе — возвращаем. Иначе после Escape клавиатура начинает
    // обход с верха страницы вместо того места, откуда палитру открыли.
    returnFocus(owner);
    owner = null;
  }

  return {
    element: overlay,
    open() {
      // Владельца берём ДО `input.focus()`: после него `document.activeElement`
      // уже само поле, и вернуть фокус было бы некуда.
      owner = focusOwner();
      overlay.hidden = false;
      input.value = '';
      matches = [];
      cursor = 0;
      loading = false;
      render();
      input.focus();
      // Символы открытого файла: показываем сразу всё, без ожидания ввода.
      if ((deps.source?.minQuery ?? MIN_QUERY) === 0) void ask('');
    },
    close,
  };
}
