import type { DirEntry, ExplorerSettings, GitChange } from '../../shared/api';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { GitInsideChange, GitModel } from '../core/git-model';
import type { OpenEditors } from '../core/open-editors';
import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import { showContextMenu } from './context-menu';
import { clear, debounce, h, svgIcon } from './dom';
import { fileIcon, folderIcon } from './file-icons';

type InlineEdit =
  | { kind: 'create'; parent: string; entryKind: 'file' | 'directory' }
  | { kind: 'rename'; path: string; currentName: string };

const CHANGE_LETTER: Record<GitChange, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

const CHANGE_TITLE: Record<GitChange, string> = {
  modified: 'изменён',
  added: 'добавлен в индекс',
  deleted: 'удалён',
  renamed: 'переименован',
  untracked: 'новый файл',
  conflicted: 'конфликт слияния',
};

export interface ExplorerView {
  element: HTMLElement;
  render(): void;
  scheduleRefresh(): void;
  reveal(path: string): void;
  /** Создание с инлайн-вводом имени: цель — выбранная папка или её родитель. */
  startCreate(entryKind: 'file' | 'directory'): void;
  startRename(path: string): void;
  /** Раскрытые папки — сохраняются в сессии проекта. */
  expandedPaths(): string[];
  /** Вернуть раскрытые папки прошлой сессии: чужие пути игнорируются. */
  restoreExpanded(paths: readonly string[]): void;
  /** Вид и поведение дерева: значки, сортировка, фильтры, клик. */
  applySettings(settings: ExplorerSettings): void;
}

/**
 * Значения до первого `settings.get`. Дублируют умолчания main-процесса: дерево
 * строится раньше, чем приходят настройки, и не должно мелькать другим видом.
 */
const FALLBACK_SETTINGS: ExplorerSettings = {
  icons: true,
  showHidden: true,
  foldersFirst: true,
  sort: 'name',
  indent: 12,
  rowDensity: 'normal',
  gitDecorations: true,
  folderChangeDot: true,
  openOnSingleClick: false,
  confirmDelete: true,
  exclude: [],
};

export interface ExplorerDeps {
  workspace: WorkspaceModel;
  rpc: RpcClient;
  commands: CommandRegistry;
  openEditors: OpenEditors;
  git: GitModel;
  /** Документы: по ним видно несохранённые правки — git их ещё не знает. */
  documents: DocumentStore;
}

/**
 * Проводник как в PyCharm: скруглённые строки, инлайн-переименование
 * и контекстное меню. Папки читаются лениво и кэшируются.
 */
export function createExplorer(deps: ExplorerDeps): ExplorerView {
  const element = h('div', { class: 'explorer' });
  const expanded = new Set<string>();
  const children = new Map<string, readonly DirEntry[]>();
  /* Незавершённые чтения папок и те, что прочитать не удалось. */
  const pending = new Map<string, Promise<void>>();
  const failed = new Set<string>();
  let inlineEdit: InlineEdit | null = null;
  let selected: string | null = null;
  let root: string | null = null;
  let options: ExplorerSettings = FALLBACK_SETTINGS;

  /**
   * Что показывать из содержимого папки: скрытое и исключённое отсеиваем до
   * отрисовки. Фильтр — часть вида, поэтому его результат не кешируем: смена
   * настройки должна применяться сразу.
   */
  const visible = (entries: readonly DirEntry[], dir: string): DirEntry[] => {
    const prefix = root && dir.startsWith(root) ? dir.slice(root.length + 1) : '';
    return sortEntries(
      entries.filter((entry) => {
        if (!options.showHidden && entry.name.startsWith('.')) return false;
        if (options.exclude.length === 0) return true;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return !options.exclude.some((pattern) => matchesGlob(entry.name, relative, pattern));
      }),
    );
  };

  const sortEntries = (entries: readonly DirEntry[]): DirEntry[] => {
    const kindRank = (entry: DirEntry): number => (options.foldersFirst ? (entry.kind === 'directory' ? 0 : 1) : 0);
    return [...entries].sort((a, b) => {
      const byKind = kindRank(a) - kindRank(b);
      if (byKind !== 0) return byKind;
      if (options.sort === 'type') {
        const byType = extensionOf(a.name).localeCompare(extensionOf(b.name));
        if (byType !== 0) return byType;
      }
      return a.name.localeCompare(b.name, 'ru');
    });
  };

  const readDir = async (dir: string): Promise<void> => {
    try {
      children.set(dir, await deps.rpc.request('workspace.readDir', { path: dir }));
    } catch (error) {
      failed.add(dir);
      console.error('[chui] не удалось прочитать папку', dir, error);
    } finally {
      pending.delete(dir);
    }
  };

  /**
   * Читает папку один раз: повторный запрос той же папки ждёт первый и получает
   * тот же промис. Просто выйти здесь нельзя: вызвавшая сторона получает
   * разрешённый промис, сразу рисует дерево снова, снова просит папку — и поток
   * навсегда остаётся в микротасках. Цикл обещаний не отдаёт управление ни
   * отрисовке, ни IPC: окно перестаёт отвечать и жжёт ядро процессора.
   */
  const load = (dir: string): Promise<void> => {
    const running = pending.get(dir);
    if (running) return running;
    const task = readDir(dir);
    pending.set(dir, task);
    return task;
  };

  /* ── инлайн-ввод имени ─────────────────────────────────────────────────── */

  const inlineInput = (depth: number, initial: string, commit: (value: string) => void): HTMLElement => {
    const input = h('input', { class: 'tree-input', type: 'text', value: initial, spellcheck: false });
    const row = h(
      'div',
      { class: 'tree-row is-editing', style: { paddingLeft: `${8 + depth * options.indent}px` } },
      input,
    );

    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      inlineEdit = null;
      if (value) commit(value);
      else render();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(input.value.trim());
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    });
    input.addEventListener('blur', () => finish(null));

    requestAnimationFrame(() => {
      input.focus();
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    });

    return row;
  };

  const commitCreate = async (edit: Extract<InlineEdit, { kind: 'create' }>, name: string): Promise<void> => {
    const target = `${edit.parent}/${name}`;
    try {
      if (edit.entryKind === 'directory') {
        await deps.commands.execute('file.createFolder', target);
        expanded.add(target);
      } else {
        await deps.commands.execute('file.createFile', target);
      }
    } catch {
      // команда уже показала ошибку пользователю
    }
    await refresh();
  };

  const commitRename = async (path: string, name: string): Promise<void> => {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (name && `${parent}/${name}` !== path) {
      await deps.commands.execute('file.rename', path, `${parent}/${name}`).catch(() => undefined);
    }
    await refresh();
  };

  /* ── контекстное меню ──────────────────────────────────────────────────── */

  const openMenu = (entry: DirEntry | null, event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    selected = entry?.path ?? null;
    render();

    const parent = entry ? (entry.kind === 'directory' ? entry.path : dirname(entry.path)) : (deps.workspace.root ?? '');
    const items = entry
      ? [
          { label: 'Новый файл…', onSelect: () => startCreateIn(parent, 'file') },
          { label: 'Новая папка…', onSelect: () => startCreateIn(parent, 'directory') },
          { separator: true as const },
          { label: 'Переименовать…', hint: 'F2', onSelect: () => startRename(entry.path) },
          { label: 'Удалить', hint: 'Del', danger: true, onSelect: () => void deps.commands.execute('file.delete', entry.path) },
          { separator: true as const },
          {
            label: 'Копировать путь',
            onSelect: () => {
              void navigator.clipboard.writeText(entry.path).catch(() => undefined);
            },
          },
        ]
      : [
          { label: 'Новый файл…', onSelect: () => startCreateIn(parent, 'file') },
          { label: 'Новая папка…', onSelect: () => startCreateIn(parent, 'directory') },
          { separator: true as const },
          { label: 'Обновить', onSelect: () => void deps.commands.execute('workspace.refresh') },
        ];

    showContextMenu(items, event.clientX, event.clientY);
  };

  const startCreateIn = (parent: string, entryKind: 'file' | 'directory'): void => {
    expanded.add(parent);
    if (!children.has(parent)) void load(parent);
    inlineEdit = { kind: 'create', parent, entryKind };
    // Рисуем ровно один раз и уже после перечитывания папок: лишняя перерисовка
    // заменила бы поле ввода только что созданным, а подмена узла закрывает ввод.
    void refresh().then(paint);
  };

  const startCreate = (entryKind: 'file' | 'directory'): void => {
    const root = deps.workspace.root;
    if (!root) return;
    if (selected) {
      const entry = findEntry(selected);
      const parent = entry?.kind === 'directory' ? entry.path : dirname(selected);
      startCreateIn(parent, entryKind);
      return;
    }
    startCreateIn(root, entryKind);
  };

  const startRename = (path: string): void => {
    const entry = findEntry(path);
    inlineEdit = { kind: 'rename', path, currentName: entry?.name ?? basename(path) };
    paint();
  };

  const findEntry = (path: string): DirEntry | undefined => {
    for (const entries of children.values()) {
      const found = entries.find((entry) => entry.path === path);
      if (found) return found;
    }
    return undefined;
  };

  /* ── отрисовка ─────────────────────────────────────────────────────────── */

  /**
   * Несохранённые документы git ещё не видит: на диске файл прежний. Но агент и
   * пользователь правят именно их, и в дереве такие файлы должны читаться как
   * изменённые — иначе работа агента исчезает из проводника до сохранения.
   */
  function isDirty(path: string): boolean {
    return deps.documents.get(path)?.dirty === true;
  }

  /** Правки внутри папки: git плюс несохранённые файлы ниже по пути. */
  function folderInside(path: string): GitInsideChange | null {
    const git = deps.git.changeInside(path);
    let count = git?.count ?? 0;
    let change: GitChange | null = git?.change ?? null;
    const prefix = `${path}/`;
    for (const document of deps.documents.dirty()) {
      if (!document.path.startsWith(prefix)) continue;
      count += 1;
      if (change === null) change = 'modified';
    }
    return count > 0 && change !== null ? { count, change } : null;
  }

  /** Подпись набора несохранённых файлов: по ней решаем, нужна ли перерисовка. */
  let dirtySignature = '';

  function syncDirty(): void {
    const next = deps.documents
      .dirty()
      .map((document) => document.path)
      .sort()
      .join('\n');
    if (next === dirtySignature) return;
    dirtySignature = next;
    render();
  }

  const renderRows = (container: HTMLElement, rawEntries: readonly DirEntry[], depth: number, dir: string): void => {
    const entries = visible(rawEntries, dir);
    for (const entry of entries) {
      const isDirectory = entry.kind === 'directory';
      const isExpanded = expanded.has(entry.path);
      const isActive = deps.openEditors.active?.path === entry.path;
      const isSelected = selected === entry.path;

      if (inlineEdit?.kind === 'rename' && inlineEdit.path === entry.path) {
        container.appendChild(inlineInput(depth, inlineEdit.currentName, (value) => void commitRename(entry.path, value)));
        continue;
      }

      const classes = ['tree-row'];
      if (isActive) classes.push('is-active');
      if (isSelected) classes.push('is-selected');

      // Пометка git из дерева не ходит в репозиторий: модель уже разложила статус по путям.
      const gitChange = deps.git.statusOf(entry.path)?.change;
      // Несохранённый документ git ещё не видит, но правка уже есть.
      const unsaved = !isDirectory && gitChange === undefined && isDirty(entry.path);
      const change = gitChange ?? (unsaved ? 'modified' : undefined);
      if (change) classes.push(`is-${change}`);

      // У папки правок быть не может, но внутри — сколько угодно: без пометки
      // свёрнутая папка выглядит чистой, хотя это не так. Класс на строке красит
      // и имя папки — весь путь к правке выделяется, а не только сам файл.
      const inside = isDirectory ? folderInside(entry.path) : null;
      if (inside) classes.push(`is-${inside.change}`);
      const insideTitle = inside ? `Правок внутри: ${inside.count}` : undefined;

      const row = h(
        'button',
        {
          class: classes.join(' '),
          type: 'button',
          draggable: 'true',
          title: change
            ? `${entry.path} — ${unsaved ? 'не сохранён' : CHANGE_TITLE[change]}`
            : insideTitle
              ? `${entry.path} — ${insideTitle}`
              : entry.path,
          dataset: { path: entry.path },
          style: { paddingLeft: `${8 + depth * options.indent}px` },
        },
        h('span', { class: `tree-twisty${isExpanded ? ' is-open' : ''}` }, isDirectory ? svgIcon('chevron', 12) : null),
        // Значок — по виду файла; с выключенной настройкой остаётся привычный
        // монохромный лист, чтобы дерево не пёстрило цветом.
        options.icons
          ? isDirectory
            ? folderIcon(entry.name, isExpanded)
            : fileIcon(entry.name)
          : svgIcon(isDirectory ? 'folder' : 'file', 15),
        h('span', { class: 'tree-name' }, entry.name),
        gitChange && options.gitDecorations
          ? h('span', { class: `tree-badge is-${gitChange}`, title: CHANGE_TITLE[gitChange] }, CHANGE_LETTER[gitChange])
          : null,
        unsaved && options.gitDecorations
          ? h('span', { class: 'tree-dot is-modified', title: 'не сохранён' })
          : null,
        inside && options.folderChangeDot ? h('span', { class: `tree-dot is-${inside.change}`, title: insideTitle }) : null,
      );

      row.addEventListener('click', () => {
        selected = entry.path;
        // Папка раскрывается всегда одним кликом (так работает стрелка),
        // а файл — по настройке: PyCharm открывает двойным, VS Code — одинарным.
        if (isDirectory || options.openOnSingleClick) void onClick(entry);
        else render();
      });
      row.addEventListener('dblclick', () => {
        if (!isDirectory && !options.openOnSingleClick) void onClick(entry);
      });
      row.addEventListener('contextmenu', (event) => openMenu(entry, event));
      // Перетаскивание в чат: путь кладём в dataTransfer — панель ассистента его приложит.
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', entry.path);
        event.dataTransfer?.setData('application/x-chui-path', entry.path);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      });
      container.appendChild(row);

      if (isCreateTarget(inlineEdit, entry.path)) {
        const edit = inlineEdit;
        container.appendChild(inlineInput(depth + 1, '', (value) => void commitCreate(edit, value)));
      }

      if (isDirectory && isExpanded) {
        const nested = children.get(entry.path);
        if (nested) renderRows(container, nested, depth + 1, entry.path);
        // Неудачное чтение само по себе не повторяем: иначе каждый проход
        // отрисовки заново просит ту же папку и дерево крутится без остановки.
        else if (!failed.has(entry.path)) void load(entry.path).then(render);
      }
    }
  };

  const onClick = async (entry: DirEntry): Promise<void> => {
    if (entry.kind !== 'directory') {
      await deps.commands.execute('file.open', entry.path);
      return;
    }
    if (expanded.has(entry.path)) {
      expanded.delete(entry.path);
      render();
      return;
    }
    expanded.add(entry.path);
    if (!children.has(entry.path)) await load(entry.path);
    render();
  };

  /**
   * Перерисовка дерева. Пока открыто поле ввода имени, её не делаем: `clear`
   * уносит поле из документа, его `blur` закрывает ввод — со стороны это
   * выглядело так, будто «Новый файл» ничего не делает. Правки git и открытие
   * файлов, случившиеся за это время, применяются следующим проходом после
   * завершения ввода. Сами рисующие вызовы идут через `paint`.
   */
  const render = (): void => {
    if (inlineEdit) return;
    paint();
  };

  const paint = (): void => {
    clear(element);
    const info = deps.workspace.current;

    if (!info) {
      element.appendChild(
        h(
          'div',
          { class: 'empty-note' },
          h('p', {}, 'Проект не открыт'),
          h(
            'button',
            { class: 'btn btn-primary', type: 'button', onClick: () => void deps.commands.execute('workspace.openFolder') },
            'Открыть папку',
          ),
        ),
      );
      return;
    }

    element.appendChild(
      h(
        'div',
        { class: 'panel-header' },
        // Вместо слова «Проект» — имя папки: заголовок говорит, что открыто,
        // а полный путь лежит в подсказке, чтобы длинное имя не резало кнопки.
        h('span', { class: 'panel-title', title: `${info.name} · ${info.root}` }, info.name),
        h('div', { class: 'panel-actions' },
          h('button', { class: 'icon-btn', type: 'button', title: 'Новый файл', onClick: () => startCreate('file') }, svgIcon('filePlus', 15)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Новая папка', onClick: () => startCreate('directory') }, svgIcon('folderPlus', 15)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Свернуть все папки', onClick: () => { expanded.clear(); render(); } }, svgIcon('collapse', 15)),
          h('button', { class: 'icon-btn', type: 'button', title: 'Обновить', onClick: () => void deps.commands.execute('workspace.refresh') }, svgIcon('refresh', 14)),
        ),
      ),
    );

    const tree = h('div', { class: 'tree' });
    tree.addEventListener('contextmenu', (event) => openMenu(null, event));
    element.appendChild(tree);

    const entries = children.get(info.root);
    if (!entries) {
      tree.appendChild(
        h('div', { class: 'tree-loading' }, failed.has(info.root) ? 'Не удалось прочитать папку' : 'Читаю папку…'),
      );
      if (!failed.has(info.root)) void load(info.root).then(render);
      return;
    }

    // Поле ввода для создания в корне проекта: строка корня в дереве не рисуется
    // (рисуются только её дети), поэтому создание «в никуда» не показывало поля —
    // со стороны это выглядело так, будто кнопка ничего не делает.
    if (inlineEdit?.kind === 'create' && inlineEdit.parent === info.root) {
      const edit = inlineEdit;
      tree.appendChild(inlineInput(0, '', (value) => void commitCreate(edit, value)));
    }
    renderRows(tree, entries, 0, info.root);
  };

  /**
   * Перечитывает уже прочитанные папки. Раскрытые папки и выделение остаются
   * на месте: это и есть отличие обновления от повторного открытия проекта.
   */
  const refresh = async (): Promise<void> => {
    const info = deps.workspace.current;
    if (!info) return;
    const dirs = [info.root, ...[...expanded].filter((dir) => children.has(dir))];
    children.clear();
    failed.clear();
    for (const dir of dirs) await load(dir);
    render();
  };

  const scheduleRefresh = debounce(() => void refresh(), 250);

  const reveal = (target: string): void => {
    const info = deps.workspace.current;
    if (!info || !target.startsWith(info.root)) return;

    const segments = target.slice(info.root.length + 1).split('/');
    segments.pop();
    let current = info.root;
    for (const segment of segments) {
      current = `${current}/${segment}`;
      expanded.add(current);
      if (!children.has(current)) void load(current).then(render);
    }
    selected = target;
    render();
    element.querySelector<HTMLElement>(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  deps.workspace.onDidChange(() => {
    const next = deps.workspace.root;
    // Та же папка — это обновление («Обновить», повторное открытие того же
    // проекта): раскрытые папки, выделение и поле ввода имени остаются.
    if (next === root) {
      void refresh();
      return;
    }
    root = next;
    expanded.clear();
    children.clear();
    pending.clear();
    failed.clear();
    selected = null;
    inlineEdit = null;
    render();
  });

  deps.openEditors.onDidChange(render);
  // Пометки git меняются и без правок в дереве — например после коммита.
  // Сохранение меняет и набор несохранённых, поэтому подпись обновляем тихо.
  deps.git.onDidChange(() => {
    dirtySignature = deps.documents
      .dirty()
      .map((document) => document.path)
      .sort()
      .join('\n');
    render();
  });
  // Первая правка делает файл «грязным», откат и сохранение — снова чистым:
  // дерево должно показывать это без ручного обновления.
  deps.documents.onDidChange(syncDirty);
  deps.documents.onDidClose(syncDirty);

  render();

  return {
    element,
    render,
    scheduleRefresh,
    reveal,
    startCreate,
    startRename,
    expandedPaths: () => [...expanded],
    restoreExpanded(paths) {
      expanded.clear();
      const root = deps.workspace.root;
      // Раскрываем только то, что лежит в текущем проекте: сессия другого
      // проекта или переименованная папка не должна ломать дерево.
      for (const item of paths) {
        if (!root) break;
        if (item === root || item.startsWith(`${root}/`)) expanded.add(item);
      }
      // Отрисовка сама подтянет корень и раскрытые уровни (см. `paint`).
      render();
    },
    applySettings(next) {
      options = next;
      // Плотность строк — атрибут-переключатель: CSS читает его и берёт свою высоту.
      element.dataset.rows = next.rowDensity;
      render();
    },
  };
}

/** Расширение без точки: по нему сортируем дерево «по типу». */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Совпадение имени с шаблоном из настроек: `*.min.js`, `dist`, `**
 * /generated/*`.
 * Полноценный glob тут не нужен — шаблоны задаёт человек руками, поэтому
 * поддерживаем `*`, `?` и `**` и сверяем и имя, и путь от корня проекта.
 */
function matchesGlob(name: string, relative: string, pattern: string): boolean {
  const source = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '.*');
  const regexp = new RegExp(`^(?:${source})$`, 'i');
  return regexp.test(name) || regexp.test(relative);
}

function basename(target: string): string {
  const index = target.lastIndexOf('/');
  return index < 0 ? target : target.slice(index + 1);
}

function dirname(target: string): string {
  const index = target.lastIndexOf('/');
  return index <= 0 ? '/' : target.slice(0, index);
}

/** Есть ли активное создание внутри указанной папки. */
function isCreateTarget(
  edit: InlineEdit | null,
  path: string,
): edit is Extract<InlineEdit, { kind: 'create' }> {
  return edit?.kind === 'create' && edit.parent === path;
}
