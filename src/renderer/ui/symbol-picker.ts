import { filterSymbols, type ProjectSymbol } from '../../shared/lsp-symbols';
import { basename } from '../../shared/languages';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';

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
  /** Открыть файл символа и встать на его позицию. */
  openSymbol(symbol: ProjectSymbol): void;
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

export function createSymbolPicker(deps: SymbolPickerDeps): SymbolPickerView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Имя символа — класс, функция, переменная…',
    spellcheck: false,
  });
  const list = h('div', { class: 'palette-list' });
  const overlay = h('div', { class: 'overlay', hidden: true }, h('div', { class: 'palette' }, input, list));

  let matches: ProjectSymbol[] = [];
  let cursor = 0;
  let timer: number | null = null;
  /** Номер последнего запроса: старый ответ не должен затирать новый. */
  let requestId = 0;
  let loading = false;

  function run(symbol: ProjectSymbol): void {
    close();
    deps.openSymbol(symbol);
  }

  function render(): void {
    clear(list);
    cursor = Math.min(cursor, Math.max(matches.length - 1, 0));

    if (loading) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Ищу символы…'));
      return;
    }

    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      list.appendChild(h('div', { class: 'palette-empty' }, `Введите хотя бы ${MIN_QUERY} символа`));
      return;
    }

    if (matches.length === 0) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Ничего не найдено'));
      return;
    }

    matches.forEach((symbol, index) => {
      const dir = symbol.path.slice(0, Math.max(symbol.path.length - basename(symbol.path).length - 1, 0));
      const item = h(
        'button',
        { class: `palette-item${index === cursor ? ' is-active' : ''}`, type: 'button' },
        svgIcon('file', 13),
        h('span', { class: 'palette-item-title' }, symbol.name),
        h('span', { class: 'palette-item-kind' }, symbol.kind),
        h('span', { class: 'palette-item-category' }, symbol.container ?? dir),
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
    const found = await deps.rpc.request('lsp.symbols', { query }).catch(() => []);
    // Пока ходили, запрос или текст могли смениться — тогда ответ уже не нужен.
    if (id !== requestId) return;
    loading = false;
    matches = filterSymbols(found, query);
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
      if (target) run(target);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  function close(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    requestId += 1;
    overlay.hidden = true;
  }

  return {
    element: overlay,
    open() {
      overlay.hidden = false;
      input.value = '';
      matches = [];
      cursor = 0;
      loading = false;
      render();
      input.focus();
    },
    close,
  };
}
