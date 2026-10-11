import { basename } from '../../shared/languages';
import {
  countFileSymbols,
  outlineState,
  toFileSymbols,
  type FileSymbol,
  type OutlineState,
} from '../../shared/lsp-symbols';
import { pathToUri } from '../core/document';
import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import type { RpcClient } from '../core/rpc';
import { clear, h } from './dom';

export interface OutlineDeps {
  rpc: RpcClient;
  openEditors: OpenEditors;
  documents: DocumentStore;
  /** Показать символ в редакторе: файл и место объявления. */
  reveal: (path: string, line: number, column: number) => void;
  /** Панель на виду: пересобирать структуру по правке имеет смысл только тогда. */
  isVisible: () => boolean;
}

export interface OutlineView {
  element: HTMLElement;
  /** Перечитать структуру активного файла (вызывается при показе вкладки). */
  refresh(): void;
  /** Файл изменился: перечитать с задержкой, если панель на виду. */
  notifyChange(path: string): void;
  focus(): void;
}

/** Пауза перед перечитыванием: структуру смотрим не на каждое нажатие. */
const REFRESH_DELAY = 500;

/**
 * Структура текущего файла (Outline): классы, функции, методы — списком с
 * вложенностью. Помогает в больших файлах: видно состав целиком, а клик по
 * символу переносит к объявлению.
 *
 * Источник — языковой сервер (`textDocument/documentSymbol`): своего разбора
 * структуры у IDE нет, а у сервера язык разобран по-настоящему. Нет сервера для
 * языка — панель честно скажет об этом, а не покажет пустоту.
 *
 * Структура обновляется при смене активного файла и по правке (с задержкой и
 * только когда панель на виду): на каждый символ запрашивать список незачем.
 */
export function createOutline(deps: OutlineDeps): OutlineView {
  const title = h('span', { class: 'outline-title' }, 'Структура');
  const summary = h('span', { class: 'outline-summary' });
  const refreshButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Пересобрать структуру', onClick: () => void refresh() },
    '⟳',
  );
  const body = h('div', { class: 'outline-body' });
  const element = h(
    'div',
    { class: 'outline-panel' },
    h('div', { class: 'outline-toolbar' }, title, summary, h('div', { class: 'toolbar-spacer' }), refreshButton),
    body,
  );

  /** Номер последнего запроса: старый ответ не должен перерисовать свежий файл. */
  let requestId = 0;
  let symbols: FileSymbol[] = [];
  /** Что показывать: готовая структура, пустой файл или «сервера нет». */
  let state: OutlineState = 'unavailable';
  let path: string | null = null;
  let loading = false;
  /** Пауза перед перечитыванием: новое изменение сбрасывает прежнее. */
  let timer: number | null = null;

  const symbolRow = (symbol: FileSymbol, depth: number): HTMLElement => {
    const row = h(
      'button',
      {
        class: 'outline-row',
        type: 'button',
        style: { paddingLeft: `${depth * 14 + 8}px` },
        title: `${symbol.kind}: ${symbol.name} — строка ${symbol.line}`,
      },
      h('span', { class: 'outline-kind' }, kindBadge(symbol.kind)),
      h('span', { class: 'outline-name' }, symbol.name),
    );
    row.addEventListener('click', () => {
      if (path) deps.reveal(path, symbol.line, 1);
    });
    return row;
  };

  const renderTree = (nodes: readonly FileSymbol[], depth: number, host: HTMLElement): void => {
    for (const node of nodes) {
      host.appendChild(symbolRow(node, depth));
      if (node.children.length > 0) renderTree(node.children, depth + 1, host);
    }
  };

  const render = (): void => {
    clear(body);

    const document = deps.openEditors.active;
    if (!document) {
      summary.textContent = '';
      body.appendChild(h('div', { class: 'outline-empty' }, 'Файл не открыт.'));
      return;
    }

    title.textContent = basename(document.path);
    if (loading) {
      summary.textContent = '…';
      body.appendChild(h('div', { class: 'outline-empty' }, 'Читаю структуру…'));
      return;
    }

    const total = countFileSymbols(symbols);
    summary.textContent = total > 0 ? String(total) : '';
    if (state !== 'ready') {
      body.appendChild(
        h(
          'div',
          { class: 'outline-empty' },
          state === 'unavailable'
            ? 'Структура недоступна: нужен языковой сервер для этого языка'
            : 'В файле нет объявлений',
        ),
      );
      return;
    }

    renderTree(symbols, 0, body);
  };

  async function refresh(): Promise<void> {
    const document = deps.openEditors.active;
    path = document?.path ?? null;
    if (!document) {
      symbols = [];
      render();
      return;
    }

    const id = (requestId += 1);
    loading = true;
    render();
    // Прокси к серверу: `null` — сервера для языка нет, пустой список — сервер
    // ответил, объявлений в файле просто нет. Разница видна пользователю.
    const result = await deps.rpc
      .request('lsp.request', {
        path: document.path,
        method: 'textDocument/documentSymbol',
        params: { textDocument: { uri: pathToUri(document.path) } },
      })
      .catch(() => null);
    // Пока ходили, сменился файл или запрос — ответ уже не к месту.
    if (id !== requestId) return;

    loading = false;
    symbols = toFileSymbols(result);
    state = outlineState(result, symbols);
    render();
  }

  function notifyChange(changed: string): void {
    if (!deps.isVisible() || changed !== deps.openEditors.active?.path) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void refresh();
    }, REFRESH_DELAY);
  }

  // Смена активного файла — другая структура: панель на виду, значит обновляем сразу.
  deps.openEditors.onDidChange(() => {
    if (deps.isVisible()) void refresh();
    else {
      // Скрыта — структуру перечитаем при показе (refresh в onShow), а пока
      // сбрасываем, чтобы не показать чужой файл.
      symbols = [];
      path = null;
    }
  });
  deps.documents.onDidChange(({ document }) => notifyChange(document.path));

  render();

  return {
    element,
    refresh: () => void refresh(),
    notifyChange,
    focus: () => refreshButton.focus(),
  };
}

/** Значок вида символа: одна буква — компактно и без картинок на каждый вид. */
function kindBadge(kind: string): string {
  const badges: Record<string, string> = {
    класс: 'C',
    метод: 'M',
    функция: 'ƒ',
    переменная: 'v',
    константа: 'c',
    интерфейс: 'I',
    модуль: 'm',
  };
  return badges[kind] ?? '·';
}
