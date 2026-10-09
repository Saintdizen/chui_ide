import type { SearchResult } from '../../shared/api';
import type { CommandRegistry } from '../core/commands';
import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import { clear, debounce, h, svgIcon } from './dom';
import { showToast } from './toast';

export interface SearchView {
  element: HTMLElement;
  focus(): void;
  setScope(path: string | null): void;
}

export interface SearchDeps {
  rpc: RpcClient;
  commands: CommandRegistry;
  workspace: WorkspaceModel;
  /** Перечитать открытый файл после замены на диске. */
  reloadFile?(path: string): void | Promise<void>;
}

/**
 * Поиск по проекту в нижней панели. Идёт через тот же RPC, которым позже
 * будет пользоваться инструмент `search` ассистента — одна реализация на двоих.
 */
export function createSearchView(deps: SearchDeps): SearchView {
  const input = h('input', {
    class: 'field-input search-input',
    type: 'search',
    placeholder: 'Найти в проекте (Enter — искать)',
    spellcheck: false,
  });
  const replaceInput = h('input', {
    class: 'field-input search-replace-input',
    type: 'text',
    placeholder: 'Чем заменить',
    spellcheck: false,
  });
  const replaceButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Заменить все вхождения в проекте' },
    'Заменить все',
  );
  const scopeNote = h('span', { class: 'search-scope' });
  const status = h('div', { class: 'search-status' });
  const results = h('div', { class: 'search-results' });

  const element = h(
    'div',
    { class: 'search-view' },
    h('div', { class: 'search-toolbar' }, h('div', { class: 'search-box' }, svgIcon('search', 14), input), scopeNote),
    h('div', { class: 'search-toolbar search-replace' }, replaceInput, replaceButton),
    status,
    results,
  );

  let sequence = 0;
  let scope: string | null = null;

  const render = (result: SearchResult, query: string): void => {
    clear(results);

    if (result.hits.length === 0) {
      status.textContent = `Ничего не найдено (проверено файлов: ${result.scanned})`;
      return;
    }

    const groups = new Map<string, typeof result.hits>();
    for (const hit of result.hits) {
      const bucket = groups.get(hit.path);
      if (bucket) bucket.push(hit);
      else groups.set(hit.path, [hit]);
    }

    for (const [path, hits] of groups) {
      results.appendChild(
        h(
          'div',
          { class: 'search-file', title: path },
          svgIcon('file', 12),
          h('span', { class: 'search-file-path' }, deps.workspace.relative(path)),
          h('span', { class: 'search-count' }, String(hits.length)),
        ),
      );

      for (const hit of hits) {
        const row = h(
          'button',
          { class: 'search-hit', type: 'button', title: `${path}:${hit.line}` },
          h('span', { class: 'search-line' }, String(hit.line)),
          h('span', { class: 'search-text' }, highlight(hit.text, query)),
        );
        row.addEventListener('click', () => void deps.commands.execute('file.revealAt', hit.path, hit.line, hit.column));
        results.appendChild(row);
      }
    }

    status.textContent = `${result.hits.length} совпадений в ${groups.size} файлах${result.truncated ? ' (список обрезан)' : ''}`;
  };

  const search = async (): Promise<void> => {
    const query = input.value.trim();
    if (!query) {
      clear(results);
      status.textContent = '';
      return;
    }
    if (!deps.workspace.root) {
      status.textContent = 'Сначала откройте папку проекта';
      return;
    }

    const current = (sequence += 1);
    status.textContent = 'Ищу…';
    try {
      const result = await deps.rpc.request('workspace.search', { query, maxResults: 300 });
      if (current !== sequence) return;
      render(result, query);
    } catch (error) {
      if (current !== sequence) return;
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  };

  /** Замена по всему проекту: идёт в main, затем перечитываем затронутые файлы. */
  const replaceEverywhere = async (): Promise<void> => {
    const query = input.value.trim();
    const replacement = replaceInput.value;
    if (!query) {
      status.textContent = 'Введите, что искать';
      return;
    }
    if (!deps.workspace.root) {
      status.textContent = 'Сначала откройте папку проекта';
      return;
    }

    replaceButton.disabled = true;
    status.textContent = 'Заменяю…';
    try {
      const result = await deps.rpc.request('workspace.replace', { query, replacement });
      for (const path of result.files) await deps.reloadFile?.(path);
      showToast(
        result.replaced > 0
          ? `Заменено вхождений: ${result.replaced} · файлов: ${result.files.length}`
          : 'Ничего не заменено',
        result.replaced > 0 ? 'info' : 'error',
      );
      await search();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      replaceButton.disabled = false;
    }
  };

  replaceButton.addEventListener('click', () => void replaceEverywhere());
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void replaceEverywhere();
    }
  });

  const schedule = debounce(() => void search(), 300);
  input.addEventListener('input', () => schedule());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void search();
  });

  return {
    element,
    focus: () => {
      input.focus();
      input.select();
    },
    setScope(path) {
      scope = path;
      scopeNote.textContent = scope ? `область: ${deps.workspace.relative(scope)}` : '';
    },
  };
}

/** Подсветка совпадения без innerHTML: текст собирается из текстовых узлов. */
function highlight(text: string, query: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let cursor = 0;

  while (lowerQuery.length > 0) {
    const found = lowerText.indexOf(lowerQuery, cursor);
    if (found < 0) break;
    if (found > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, found)));
    fragment.appendChild(h('mark', {}, text.slice(found, found + query.length)));
    cursor = found + query.length;
  }

  fragment.appendChild(document.createTextNode(text.slice(cursor)));
  return fragment;
}
