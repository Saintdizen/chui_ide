import type { RpcClient } from '../core/rpc';
import { rankFiles } from '../core/quick-open-rank';
import type { WorkspaceModel } from '../core/workspace-model';
import { clear, h, svgIcon } from './dom';
import { showToast } from './toast';

export interface QuickOpenView {
  element: HTMLElement;
  /**
   * Открыть список файлов. Список читается один раз и держится до смены проекта.
   * `initialQuery` — начальный отбор: крошка папки подставляет свой путь, чтобы
   * сразу показать файлы рядом, а не весь проект.
   */
  open(initialQuery?: string): Promise<void>;
  /**
   * Выбрать файл, не открывая его: тем же списком и тем же отбором. Обещание
   * разрешается абсолютным путём или `null`, если выбор отменили (Escape).
   */
  pick(title: string): Promise<string | null>;
  close(): void;
}

/**
 * Быстрый открыватель файлов (`Ctrl+Shift+O`). В отличие от палитры команд,
 * которая ходит по реестру команд, здесь список файлов проекта: его отдаёт main
 * одним вызовом (`workspace.listFiles`). Отбор — `rankFiles`, отдельно от DOM.
 */
export function createQuickOpen(deps: {
  rpc: RpcClient;
  workspace: WorkspaceModel;
  /** Открыть файл по абсолютному пути — тот же вход, что у дерева и вкладок. */
  openFile(path: string): void | Promise<void>;
}): QuickOpenView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Начните вводить имя файла…',
    spellcheck: false,
  });
  const list = h('div', { class: 'palette-list' });
  const overlay = h('div', { class: 'overlay', hidden: true }, h('div', { class: 'palette' }, input, list));

  /** Относительные пути: ключ, по которому список перечитывается при смене проекта. */
  let root: string | null = null;
  let files: string[] = [];
  let loading = false;
  let matches: string[] = [];
  let cursor = 0;
  /** Режим выбора: пока задан, `run` возвращает путь сюда, а не открывает файл. */
  let picking: ((path: string | null) => void) | null = null;

  async function loadFiles(): Promise<void> {
    const current = deps.workspace.root;
    if (current === root && files.length > 0) return;
    loading = true;
    renderList();
    try {
      files = await deps.rpc.request('workspace.listFiles');
      root = current;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      files = [];
    } finally {
      loading = false;
    }
  }

  function run(relative: string): void {
    close();
    const base = deps.workspace.root;
    if (!base) return;
    const absolute = `${base}/${relative}`;
    // Режим выбора: путь уходит вызывающему, файл в редакторе не открываем.
    if (picking) {
      const resolve = picking;
      picking = null;
      resolve(absolute);
      return;
    }
    void deps.openFile(absolute);
  }

  function renderList(): void {
    clear(list);

    if (loading) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Читаю список файлов…'));
      return;
    }

    matches = rankFiles(files, input.value);
    cursor = Math.min(cursor, Math.max(matches.length - 1, 0));

    if (matches.length === 0) {
      list.appendChild(
        h('div', { class: 'palette-empty' }, files.length === 0 ? 'В проекте нет файлов' : 'Ничего не найдено'),
      );
      return;
    }

    matches.forEach((relative, index) => {
      const slash = relative.lastIndexOf('/');
      const name = slash < 0 ? relative : relative.slice(slash + 1);
      const dir = slash < 0 ? '' : relative.slice(0, slash);
      const item = h(
        'button',
        { class: `palette-item${index === cursor ? ' is-active' : ''}`, type: 'button' },
        svgIcon('file', 13),
        h('span', { class: 'palette-item-title' }, name),
        dir ? h('span', { class: 'palette-item-category' }, dir) : null,
      );
      item.addEventListener('click', () => run(relative));
      item.addEventListener('mousemove', () => {
        if (cursor === index) return;
        cursor = index;
        renderList();
      });
      list.appendChild(item);
    });
  }

  input.addEventListener('input', () => {
    cursor = 0;
    renderList();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, matches.length - 1);
      renderList();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      renderList();
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
    overlay.hidden = true;
    // Отмена выбора: обещание надо разрешить, иначе вызывающий ждёт вечно.
    if (picking) {
      const resolve = picking;
      picking = null;
      resolve(null);
    }
  }

  return {
    element: overlay,
    async open(initialQuery = '') {
      overlay.hidden = false;
      input.value = initialQuery;
      cursor = 0;
      // Список мог устареть: проект сменился или появились файлы. Читаем при открытии.
      await loadFiles();
      renderList();
      input.focus();
      // Курсор ставим в конец: набранный отбор остаётся, но его видно целиком.
      input.setSelectionRange(initialQuery.length, initialQuery.length);
    },
    pick(title) {
      return new Promise<string | null>((resolve) => {
        picking = resolve;
        input.placeholder = title;
        void this.open('').then(() => {
          // Заголовок ставим после `open`: он тоже пишет placeholder.
          input.placeholder = title;
        });
      });
    },
    close,
  };
}
