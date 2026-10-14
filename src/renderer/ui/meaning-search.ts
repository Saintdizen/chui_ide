import type { SearchHit } from '../../shared/api';
import type { ProjectSymbol } from '../../shared/lsp-symbols';
import { combineMeaning, meaningRegex, type MeaningHit } from '../../shared/meaning-search';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';

/**
 * Поиск по смыслу: запрос можно писать словами, а не угадывать точную строку.
 *
 * Источника два, и оба уже есть в проекте: имена символов даёт языковой сервер
 * (`workspace/symbol`), строки — обычный текстовый поиск. Здесь они сводятся в
 * один список (`combineMeaning`), где объявления идут впереди упоминаний.
 * Отличие от «перейти к символу» (`Ctrl+T`): тот ищет только по именам, а тут
 * находятся и комментарии, и строки, и текст кода — по словам запроса.
 */

export interface MeaningSearchDeps {
  rpc: RpcClient;
  /** Открыть файл результата и встать на его позицию. */
  openHit(hit: MeaningHit): void;
  /** Путь для показа рядом с результатом. */
  relative(path: string): string;
}

export interface MeaningSearchView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/** С какой длины запроса идти к источникам: одна буква даст лавину совпадений. */
const MIN_QUERY = 2;
/** Пауза после нажатия: серверу тоже нужно время, а список — не мгновенный. */
const DEBOUNCE = 250;
/** Сколько строк спрашивать у текстового поиска до ранжирования. */
const MAX_TEXT_HITS = 300;
/** Сколько результатов показывать. */
const MAX_RESULTS = 60;
/** Длина подписи строки: очень длинную строку показываем началом. */
const MAX_LABEL = 160;

export function createMeaningSearch(deps: MeaningSearchDeps): MeaningSearchView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Поиск по смыслу — опишите словами, что ищете…',
    spellcheck: false,
  });
  const list = h('div', { class: 'palette-list' });
  const overlay = h('div', { class: 'overlay', hidden: true }, h('div', { class: 'palette' }, input, list));

  let hits: MeaningHit[] = [];
  let cursor = 0;
  let timer: number | null = null;
  /** Номер последнего запроса: старый ответ не должен затирать новый. */
  let requestId = 0;
  let loading = false;

  function run(hit: MeaningHit): void {
    close();
    deps.openHit(hit);
  }

  function render(): void {
    clear(list);
    cursor = Math.min(cursor, Math.max(hits.length - 1, 0));

    if (loading) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Ищу по смыслу…'));
      return;
    }

    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      list.appendChild(h('div', { class: 'palette-empty' }, `Введите хотя бы ${MIN_QUERY} символа`));
      return;
    }

    if (hits.length === 0) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Ничего не найдено'));
      return;
    }

    hits.forEach((hit, index) => {
      const label = hit.label.length > MAX_LABEL ? `${hit.label.slice(0, MAX_LABEL)}…` : hit.label;
      const item = h(
        'button',
        { class: `palette-item${index === cursor ? ' is-active' : ''}`, type: 'button' },
        svgIcon(hit.kind === 'symbol' ? 'file' : 'search', 13),
        h('span', { class: 'palette-item-title' }, label),
        h('span', { class: 'palette-item-kind' }, hit.hint),
        h('span', { class: 'palette-item-category' }, `${deps.relative(hit.path)}:${hit.line}`),
      );
      item.addEventListener('click', () => run(hit));
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

    const [symbols, found] = await Promise.all([
      deps.rpc.request('lsp.symbols', { query }).catch(() => [] as ProjectSymbol[]),
      deps.rpc
        .request('workspace.search', {
          query: meaningRegex(query),
          isRegex: true,
          caseSensitive: false,
          maxResults: MAX_TEXT_HITS,
        })
        .catch(() => null),
    ]);

    // Пока ходили, запрос или текст могли смениться — тогда ответ уже не нужен.
    if (id !== requestId) return;
    loading = false;

    const lines = (found?.hits ?? []).map((hit: SearchHit) => ({ path: hit.path, line: hit.line, text: hit.text }));
    hits = combineMeaning(symbols, lines, query, MAX_RESULTS);
    render();
  }

  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      // Запрос отменяем: иначе ответ придёт на пустой список и собьёт показ.
      requestId += 1;
      loading = false;
      hits = [];
      render();
      return;
    }
    timer = window.setTimeout(() => void ask(query), DEBOUNCE);
  }

  input.addEventListener('input', () => {
    cursor = 0;
    schedule();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, hits.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = hits[cursor];
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
      hits = [];
      cursor = 0;
      loading = false;
      render();
      input.focus();
    },
    close,
  };
}
