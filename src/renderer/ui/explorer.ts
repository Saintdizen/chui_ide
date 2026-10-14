import type { DirEntry, ExplorerSettings, GitChange, WorkspaceInfo } from '../../shared/api';
import type { WorkspaceRoot } from '../../shared/workspace-roots';
import { submoduleStateLabel, type GitSubmodule } from '../../shared/git-submodules';
import { isInsidePath, joinPath, nameOf, parentOf, pathAfter, separatorOf, splitPath } from '../../shared/paths';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { GitInsideChange, GitModel } from '../core/git-model';
import type { OpenEditors } from '../core/open-editors';
import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import { entryIsDirectory, entryIsFile, entryIsSymlink, symlinkLabel } from '../../shared/entry-kind';
import { pairFromSelection } from '../core/file-compare';
import { effectiveNestingRules, nestEntries } from '../core/file-nesting';
import { isPinned, normalizePins, togglePin } from '../core/tree-pins';
import { sortTree } from '../core/tree-sort';
import { computeWindow } from '../core/tree-window';
import { movePlan } from '../core/tree-move';
import {
  clickSelection,
  EMPTY_SELECTION,
  normalizeSelection,
  type TreeClickMode,
  type TreeSelection,
} from '../core/tree-selection';
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
  /** Закреплённые файлы и папки — блоком сверху; хранятся в сессии проекта. */
  pinnedPaths(): string[];
  restorePinned(paths: readonly string[]): void;
  /** Закрепить или открепить путь (пункт меню дерева). */
  togglePin(path: string): void;
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
  recentChanges: true,
  recentWindowHours: 24,
  dimIgnored: true,
  openOnSingleClick: false,
  confirmDelete: true,
  exclude: [],
  fileNesting: false,
  nestingRules: [],
  updateImportsOnRename: true,
};

import { isRecentlyModified, recentLabel } from '../core/tree-recent';

/** Где показать просмотр файла: прямоугольник строки (или точка меню) в системе окна. */
export interface PeekAnchorPoint {
  left: number;
  top: number;
  bottom: number;
}

/** Точка меню как якорь просмотра: копия встанет под курсором. */
function menuAnchor(event: MouseEvent): PeekAnchorPoint {
  return { left: event.clientX, top: event.clientY, bottom: event.clientY + 1 };
}

export interface ExplorerDeps {
  workspace: WorkspaceModel;
  rpc: RpcClient;
  commands: CommandRegistry;
  openEditors: OpenEditors;
  git: GitModel;
  /** Документы: по ним видно несохранённые правки — git их ещё не знает. */
  documents: DocumentStore;
  /** Закрепление изменилось — рабочее место стоит сохранить (см. сессию). */
  onPinsChange?: () => void;
  /**
   * Просмотр файлов без открытия (peek): пути и точка, у которой показать копию.
   * Не задано — пункта «Просмотр» в меню и клавиши «пробел» нет.
   */
  peekFiles?: (paths: readonly string[], anchor: PeekAnchorPoint) => void;
  /**
   * Клавиши показанной копии просмотра (Esc, Enter, стрелки с Alt): фокус сейчас
   * в дереве, и до ввода редактора событие не дойдёт. Не задано — копия клавиш не берёт.
   */
  peekKey?: (event: KeyboardEvent) => boolean;
}

/**
 * Проводник как в PyCharm: скруглённые строки, инлайн-переименование
 * и контекстное меню. Папки читаются лениво и кэшируются.
 */
export function createExplorer(deps: ExplorerDeps): ExplorerView {
  const element = h('div', { class: 'explorer' });
  const expanded = new Set<string>();
  const children = new Map<string, readonly DirEntry[]>();
  /** Пути, про которые git уже сказал: игнорируемые (по ответу) и спрошенные. */
  const ignored = new Set<string>();
  const ignoreAsked = new Set<string>();
  /** Пути, которые сейчас видны в дереве: про них и спрашиваем (для них и рисуем). */
  let visibleNow: string[] = [];
  /** Подмодули проекта по АБСОЛЮТНОМУ пути: их папки в дереве помечаются значком. */
  let submodules = new Map<string, GitSubmodule>();
  /** Корень, для которого собраны наборы игнорируемых: с новым проектом их надо сбросить. */
  let ignoreRoot: string | null = null;
  /* Незавершённые чтения папок и те, что прочитать не удалось. */
  const pending = new Map<string, Promise<void>>();
  const failed = new Set<string>();
  let inlineEdit: InlineEdit | null = null;
  /** Просьба вернуть фокус дереву на ближайшей отрисовке (см. обработчик клика). */
  let refocusTreeOnce = false;
  /**
   * Папка, раскрытая кликом: её прямые дети «выезжают» из-под родителя вниз, а не
   * возникают на месте: движение идёт туда, откуда элемент пришёл. Живёт
   * до конца одной отрисовки — на следующих перерисовках
   * строки появляются уже без движения, иначе дерево дёргалось бы на каждом
   * обновлении git и сохранении.
   */
  let revealChildrenOf: string | null = null;

  /**
   * Клавиши дерева. Слушаем на самом дереве, а не глобально: `Delete` в общей
   * привязке удалял бы выбранный файл, пока человек набирает текст в редакторе —
   * там событие приходит от скрытой textarea Monaco, и отличить его сложно.
   */
  const onTreeKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    // Поле ввода живёт внутри дерева (создание, переименование) — там клавиши чужие.
    if (target?.closest('input, textarea, select') || target?.isContentEditable) return;
    // Показанная копия забирает свои клавиши первой: она видна, а фокус — в дереве.
    if (deps.peekKey?.(event)) {
      event.preventDefault();
      return;
    }
    if (!selected) return;

    if (event.key === 'F2') {
      event.preventDefault();
      startRename(selected);
      return;
    }
    if (event.key === ' ' && deps.peekFiles) {
      // Пробел — быстрый просмотр: показываем выделенные файлы, вкладок не открывая.
      const paths = peekablePaths();
      if (paths.length > 0) {
        event.preventDefault();
        deps.peekFiles(paths, rowAnchor(paths[0]!, event));
      }
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      deleteTargets(selection.paths.length > 0 ? selection.paths : [selected]);
    }
  };
  let selected: string | null = null;
  /** Закреплённые пути (блок «Закреплённые» сверху); порядок закрепления сохраняем. */
  let pinned: string[] = [];
  /** Выделенные строки (Ctrl/Shift) и якорь диапазона; порядок — как в дереве. */
  let selection: TreeSelection = EMPTY_SELECTION;
  /** Пути текущего перетаскивания: их и переносим при сбросе на папку. */
  let dragging: string[] = [];
  /** Ctrl (на macOS — Alt) во время протяжки: не перенос, а копирование. */
  const copyDrag = (event: DragEvent): boolean => event.ctrlKey || event.altKey;
  let root: string | null = null;
  let options: ExplorerSettings = FALLBACK_SETTINGS;
  /** Свёрнутые КОРНИ рабочей области (только когда их несколько). */
  const collapsedRoots = new Set<string>();

  /** Закрепить или открепить путь и попросить сохранить рабочее место. */
  const setPinned = (path: string): void => {
    pinned = togglePin(pinned, path);
    deps.onPinsChange?.();
    render();
  };

  /** Файлы выделения (или под курсором) для просмотра: папки не показываем. */
  const peekablePaths = (): string[] => {
    const list = selection.paths.length > 0 ? [...selection.paths] : selected ? [selected] : [];
    return list.filter((path) => {
      const found = findEntry(path);
      return found !== undefined && entryIsFile(found);
    });
  };

  /** Прямоугольник строки пути (в дереве) — у него показывать просмотр. */
  const rowAnchor = (path: string, event: Event): PeekAnchorPoint => {
    const host = event.currentTarget as HTMLElement | null;
    const row = host?.querySelector?.(`[data-path="${CSS.escape(path)}"]`);
    const box = row?.getBoundingClientRect();
    if (!box) return { left: 0, top: 0, bottom: 1 };
    return { left: box.left, top: box.top, bottom: box.bottom };
  };

  /**
   * Блок закреплённых сверху. Путь может лежать глубоко и его папка быть свёрнутой —
   * поэтому строка рисуется прямо по пути, без похода в дерево. Удалённый файл не
   * выкидываем молча: клик по нему скажет, что файла нет.
   */
  const pinnedBlock = (): HTMLElement => {
    const header = h('div', { class: 'tree-pins-head' }, svgIcon('pin', 12), h('span', {}, 'Закреплённые'));
    const rows = pinned.map((path) => {
      const entry = findEntry(path);
      const isDirectory = entry ? entryIsDirectory(entry) : false;
      const row = h(
        'div',
        { class: 'tree-row is-pinned', title: path, dataset: { path } },
        h('span', { class: 'tree-twisty' }),
        options.icons ? (isDirectory ? folderIcon(nameOf(path), true) : fileIcon(nameOf(path))) : svgIcon('file', 15),
        h('span', { class: 'tree-name' }, nameOf(path)),
        h(
          'button',
          {
            class: 'icon-btn tree-unpin',
            type: 'button',
            title: 'Открепить',
            onClick: (event: Event) => {
              event.stopPropagation();
              setPinned(path);
            },
          },
          svgIcon('close', 12),
        ),
      );
      row.addEventListener('click', () => {
        if (isDirectory) reveal(path);
        else void deps.commands.execute('file.open', path);
      });
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(
          [
            { label: 'Открепить', onSelect: () => setPinned(path) },
            {
              label: isDirectory ? 'Показать в дереве' : 'Открыть',
              onSelect: () => (isDirectory ? reveal(path) : void deps.commands.execute('file.open', path)),
            },
          ],
          event.clientX,
          event.clientY,
        );
      });
      return row;
    });
    return h('div', { class: 'tree-pins' }, header, ...rows);
  };

  /** Удаление в корзину: одну строку — обычной командой, группу — пачкой с одним вопросом. */
  const deleteTargets = (paths: readonly string[]): void => {
    if (paths.length === 1) void deps.commands.execute('file.delete', paths[0]);
    else if (paths.length > 1) void deps.commands.execute('file.deleteMany', [...paths]);
  };

  /**
   * Что показывать из содержимого папки: скрытое и исключённое отсеиваем до
   * отрисовки. Фильтр — часть вида, поэтому его результат не кешируем: смена
   * настройки должна применяться сразу.
   */
  const visible = (entries: readonly DirEntry[], dir: string): DirEntry[] => {
    // С несколькими корнями «относительно текущего проекта» не годится: путь берём
    // от того корня, которому папка принадлежит (файл из второй папки — к ней).
    const owner = deps.workspace.ownerOf(dir);
    const prefix = owner && dir !== owner.root ? pathAfter(owner.root, dir) : '';
    return sortEntries(
      entries.filter((entry) => {
        if (!options.showHidden && entry.name.startsWith('.')) return false;
        if (options.exclude.length === 0) return true;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return !options.exclude.some((pattern) => matchesGlob(entry.name, relative, pattern));
      }),
    );
  };

  const sortEntries = (entries: readonly DirEntry[]): DirEntry[] =>
    // Порядок считает чистый модуль (`core/tree-sort.ts`): режимов четыре, и
    // проверяются они тестами, а не глазом на дереве.
    sortTree(entries, {
      foldersFirst: options.foldersFirst,
      sort: options.sort,
      changeOf: (path) => deps.git.statusOf(path)?.change,
    });

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
    const target = joinPath(edit.parent, name);
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
    // Новый путь — тот же каталог с новым именем. Родителя и соединение считает
    // shared/paths: с жёстким «/» переименование на Windows дало бы «/имя».
    const next = joinPath(parentOf(path), name);
    if (name && next !== path) {
      await deps.commands.execute('file.rename', path, next).catch(() => undefined);
    }
    await refresh();
  };

  /* ── контекстное меню ──────────────────────────────────────────────────── */

  const openMenu = (entry: DirEntry | null, event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    // Правый клик по уже выделенной строке сохраняет всю группу, по другой —
    // выделяет только её: иначе «удалить выделенное» тронуло бы не то.
    if (!entry || !selection.paths.includes(entry.path)) {
      selection = entry ? { paths: [entry.path], anchor: entry.path } : EMPTY_SELECTION;
      selected = entry?.path ?? null;
    }
    render();

    const parent = entry ? (entryIsDirectory(entry) ? entry.path : parentOf(entry.path)) : (deps.workspace.root ?? '');
    // Операции над группой идут по всему выделению, а не по одной строке под курсором.
    const effective = selection.paths.length > 0 ? [...selection.paths] : entry ? [entry.path] : [];
    // Сравнить можно только файлы: папки экран различий не показывает.
    const files = effective.filter((path) => {
      const found = findEntry(path);
      return found !== undefined && entryIsFile(found);
    });
    const pair = pairFromSelection(files);
    // Две папки сравниваются своим экраном — списком различий.
    const dirs = effective.filter((path) => {
      const found = findEntry(path);
      return found !== undefined && entryIsDirectory(found);
    });
    const dirPair = pairFromSelection(dirs);
    const items = entry
      ? [
          { label: 'Новый файл…', onSelect: () => startCreateIn(parent, 'file') },
          { label: 'Новая папка…', onSelect: () => startCreateIn(parent, 'directory') },
          { separator: true as const },
          { label: 'Переименовать…', hint: 'F2', onSelect: () => startRename(entry.path) },
          {
            label: effective.length > 1 ? `Удалить (${effective.length})` : 'Удалить',
            hint: 'Del',
            danger: true,
            onSelect: () => deleteTargets(effective),
          },
          { separator: true as const },
          {
            label: effective.length > 1 ? `Копировать ${effective.length} путей` : 'Копировать путь',
            onSelect: () => {
              void navigator.clipboard.writeText(effective.join('\n')).catch(() => undefined);
            },
          },
          ...(pair
            ? [
                {
                  label: `Сравнить: ${nameOf(pair.left)} ↔ ${nameOf(pair.right)}`,
                  onSelect: () => void deps.commands.execute('diff.compareFiles', pair.left, pair.right),
                },
                { separator: true as const },
              ]
            : dirPair
              ? [
                  {
                    label: `Сравнить папки: ${nameOf(dirPair.left)} ↔ ${nameOf(dirPair.right)}`,
                    onSelect: () => void deps.commands.execute('folder.compare', dirPair.left, dirPair.right),
                  },
                  { separator: true as const },
                ]
              : entryIsFile(entry)
                ? [
                    {
                      label: 'Сравнить с…',
                      onSelect: () => void deps.commands.execute('file.compareWith', entry.path),
                    },
                    { separator: true as const },
                  ]
                : []),
          ...(entryIsFile(entry)
            ? [
                ...(deps.peekFiles
                  ? [
                      {
                        label: 'Просмотр',
                        onSelect: () => deps.peekFiles?.([entry.path], menuAnchor(event)),
                      },
                    ]
                  : []),
                {
                  label: 'Локальная история',
                  onSelect: () => void deps.commands.execute('file.history', entry.path),
                },
              ]
            : []),
          {
            label: isPinned(pinned, entry.path) ? 'Открепить' : 'Закрепить сверху',
            onSelect: () => setPinned(entry.path),
          },
          { separator: true as const },
          // Открытие вне IDE: файл — программой системы, папка — в системном
          // проводнике, а терминал поднимается в той папке, где лежит выбранное.
          {
            label: 'Открыть в системном проводнике',
            onSelect: () => void deps.commands.execute('file.revealInOS', entry.path),
          },
          {
            label: entryIsDirectory(entry) ? 'Открыть папку внешней программой' : 'Открыть внешней программой',
            onSelect: () => void deps.commands.execute('file.openExternal', entry.path),
          },
          {
            label: 'Открыть терминал в папке',
            onSelect: () => void deps.commands.execute('terminal.openIn', parent),
          },
          {
            label: 'Открыть терминал системы',
            onSelect: () => void deps.commands.execute('terminal.openExternal', parent),
          },
          { separator: true as const },
          {
            label: 'Добавить в .gitignore',
            onSelect: () => void deps.commands.execute('git.ignore', entry.path),
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
      const parent = entry !== undefined && entryIsDirectory(entry) ? entry.path : parentOf(selected);
      startCreateIn(parent, entryKind);
      return;
    }
    startCreateIn(root, entryKind);
  };

  const startRename = (path: string): void => {
    const entry = findEntry(path);
    inlineEdit = { kind: 'rename', path, currentName: entry?.name ?? nameOf(path) };
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
    // С жёстким «/» несохранённые файлы внутри папок не считались бы на Windows.
    for (const document of deps.documents.dirty()) {
      if (!isInsidePath(path, document.path)) continue;
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

  const renderRow = (
    entry: DirEntry,
    depth: number,
    dir: string,
    flags: { nested: boolean; deleted: boolean } = { nested: false, deleted: false },
  ): HTMLElement | null => {
    const isDirectory = entryIsDirectory(entry);
    const isLink = entryIsSymlink(entry);
    const linkLabel = symlinkLabel(entry);
    const isDeleted = flags.deleted;
    const isExpanded = expanded.has(entry.path);
    const isActive = deps.openEditors.active?.path === entry.path;
    const isSelected = selection.paths.includes(entry.path);

    if (inlineEdit?.kind === 'rename' && inlineEdit.path === entry.path) {
      return inlineInput(depth, inlineEdit.currentName, (value) => void commitRename(entry.path, value));
    }

    const classes = ['tree-row'];
    if (isActive) classes.push('is-active');
    if (isSelected) classes.push('is-selected');
    if (flags.nested) classes.push('is-nested');
    // Удалённый файл: строки на диске нет, но правка есть — помечаем зачёркнутым.
    if (isDeleted) classes.push('is-deleted');
    // Дети только что раскрытой папки въезжают вниз, из-под родителя.
    if (dir === revealChildrenOf) classes.push('is-entering');
    // Символическая ссылка: значок-стрелка и приглушение битой (её читать нечем).
    if (isLink) classes.push('is-symlink');
    if (entry.symlink?.broken) classes.push('is-broken-link');

    // Пометка git из дерева не ходит в репозиторий: модель уже разложила статус по путям.
    const gitChange = isDeleted ? ('deleted' as GitChange) : deps.git.statusOf(entry.path)?.change;
    // Несохранённый документ git ещё не видит, но правка уже есть.
    const unsaved = !isDirectory && gitChange === undefined && isDirty(entry.path);
    const change = gitChange ?? (unsaved ? 'modified' : undefined);
    if (change) classes.push(`is-${change}`);

    // У папки правок быть не может, но внутри — сколько угодно: без пометки
    // свёрнутая папка выглядит чистой, хотя это не так. Класс на строке красит
    // и имя папки — весь путь к правке выделяется, а не только сам файл.
    const inside = !isDeleted && isDirectory ? folderInside(entry.path) : null;
    if (inside) classes.push(`is-${inside.change}`);
    // Игнорируемое git — приглушаем: файл видно и можно открыть, но он не мешает.
    const isIgnored = !isDeleted && options.dimIgnored && ignored.has(entry.path);
    if (isIgnored) classes.push('is-ignored');
    // Свежесть правки: git-пометка говорит «изменён с коммита», а это — «тронут только
    // что». Свежими бывают и файлы без правок git (сохранённый только что), поэтому
    // отметка ставится независимо от пометки. Удалённому она ни к чему — его нет.
    const recent =
      !isDeleted &&
      options.recentChanges &&
      isRecentlyModified(entry.mtimeMs, Date.now(), options.recentWindowHours * 60 * 60 * 1000);
    if (recent) classes.push('is-recent');
    // Папка-подмодуль: это отдельный репозиторий, а не обычная папка проекта.
    const submodule = !isDeleted && isDirectory ? submodules.get(entry.path) : undefined;
    if (submodule) classes.push('is-submodule');
    const insideTitle = inside ? `Правок внутри: ${inside.count}` : undefined;

    const row = h(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        draggable: 'true',
        title: isDeleted
          ? `${entry.path} — удалён, но ещё не закоммичен`
          : linkLabel
            ? `${entry.path} — ${linkLabel}`
            : change
              ? `${entry.path} — ${unsaved ? 'не сохранён' : CHANGE_TITLE[change]}`
              : insideTitle
                ? `${entry.path} — ${insideTitle}`
                : recent
                  ? `${entry.path} — тронут ${recentLabel(entry.mtimeMs, Date.now())}`
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
      isLink
        ? h(
            'span',
            { class: `tree-badge is-symlink${entry.symlink?.broken ? ' is-broken' : ''}`, title: linkLabel ?? '' },
            '↗',
          )
        : null,
      gitChange && (isDeleted || options.gitDecorations)
        ? h('span', { class: `tree-badge is-${gitChange}`, title: CHANGE_TITLE[gitChange] }, CHANGE_LETTER[gitChange])
        : null,
      unsaved && options.gitDecorations ? h('span', { class: 'tree-dot is-modified', title: 'не сохранён' }) : null,
      submodule
        ? h(
            'span',
            { class: `tree-badge is-submodule is-${submodule.state}`, title: submoduleStateLabel(submodule.state) },
            'S',
          )
        : null,
      inside && options.folderChangeDot
        ? h('span', { class: `tree-dot is-${inside.change}`, title: insideTitle })
        : null,
      // Точка свежести — тонкая и справа: она не про состояние git, а про время.
      recent
        ? h('span', { class: 'tree-dot is-recent', title: `Тронут ${recentLabel(entry.mtimeMs, Date.now())}` })
        : null,
    );

    if (isDeleted) {
      // Удалённый файл только показываем: на диске его нет, и операции над ним
      // (открыть, перенести, удалить) бессмысленны. Мышь ведёт к различию —
      // там и видно, что именно исчезло.
      row.addEventListener('click', () => void deps.commands.execute('git.showDiff', entry.path, false));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(
          [
            {
              label: 'Показать различия',
              onSelect: () => void deps.commands.execute('git.showDiff', entry.path, false),
            },
            {
              label: 'Копировать путь',
              onSelect: () => {
                void navigator.clipboard.writeText(entry.path).catch(() => undefined);
              },
            },
          ],
          event.clientX,
          event.clientY,
        );
      });
      return row;
    }

    row.addEventListener('click', (event) => {
      // Ctrl/Cmd — точечно (добавить или снять), Shift — диапазон от якоря,
      // обычный клик — одна строка. Порядок строк — тот, что сейчас на экране.
      const mode: TreeClickMode = event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single';
      selection = clickSelection(selection, visibleNow, entry.path, mode);
      selected = selection.anchor;
      // Перерисовка ниже уничтожит строку вместе с фокусом, а он нужен, чтобы
      // работали F2 и Del. Просим вернуть фокус дереву ровно один раз — на
      // ближайшей отрисовке, а не на каждой (иначе фокус выдёргивался бы из
      // редактора при любом обновлении дерева).
      refocusTreeOnce = true;
      // Папка раскрывается всегда одним кликом (так работает стрелка),
      // а файл — по настройке: PyCharm открывает двойным, VS Code — одинарным.
      // Одиночный клик открывает файл «на посмотреть» (вкладку-предпросмотр):
      // навигация по дереву не должна плодить вкладки. Двойной — «насовсем».
      if (isDirectory || options.openOnSingleClick) void onClick(entry, !isDirectory && options.openOnSingleClick);
      else render();
    });
    row.addEventListener('dblclick', () => {
      if (!isDirectory) void onClick(entry, false);
    });
    row.addEventListener('contextmenu', (event) => openMenu(entry, event));
    // Перетаскивание: путь уходит и в буфер (панель ассистента приложит его
    // к вопросу), и во внутренний список — им дерево переносит файлы в папку.
    row.addEventListener('dragstart', (event) => {
      dragging = isSelected ? [...selection.paths] : [entry.path];
      event.dataTransfer?.setData('text/plain', entry.path);
      event.dataTransfer?.setData('application/x-chui-path', entry.path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
    });
    row.addEventListener('dragend', () => {
      dragging = [];
      row.classList.remove('is-drop-target');
    });
    // Куда встанет перенос: на папку — внутрь неё, на файл — рядом с ним.
    const dropDir = isDirectory ? entry.path : parentOf(entry.path);
    row.addEventListener('dragover', (event) => {
      if (dragging.length === 0 || movePlan(dragging, dropDir).length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = copyDrag(event) ? 'copy' : 'move';
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('is-drop-target');
      const moving = dragging;
      dragging = [];
      if (moving.length === 0) return;
      void deps.commands.execute(copyDrag(event) ? 'file.copyInto' : 'file.moveInto', moving, dropDir);
    });
    return row;
  };

  /**
   * Строка дерева в визуальном порядке: запись, строка корня области, поле ввода
   * имени или сообщение о чтении папки. Список плоский, а не рекурсивная отрисовка:
   * по нему считаем окно (виртуализация) и работает выделение диапазоном.
   */
  type FlatRow =
    | { kind: 'entry'; entry: DirEntry; depth: number; dir: string; nested: boolean; deleted: boolean }
    | { kind: 'root'; root: WorkspaceRoot; active: boolean; collapsed: boolean }
    | { kind: 'create'; parent: string; depth: number }
    | { kind: 'loading'; dir: string };

  /** Сам список, его хозяин и высота строки: нужны окну отрисовки. */
  let treeEl: HTMLElement | null = null;
  let rowsHost: HTMLElement | null = null;
  let flatRows: FlatRow[] = [];
  /** Высота строки в пикселях: меряется по отрисованной строке (зависит от плотности). */
  let rowStride = 0;
  /** Прокрутка: сохраняется между перерисовками — дерево пересобирается целиком. */
  let savedScroll = 0;
  /** Путь, к которому просили прокрутить: строка может появиться позже (папка читается). */
  let revealTarget: string | null = null;

  /**
   * Видимые строки дерева в порядке отображения: раскрытые папки, их дети и
   * свёрнутые спутники. Порядок тот же, что узлов на экране, — по нему работает
   * выделение диапазоном (`Shift`) и прокрутка к строке.
   */
  const buildFlat = (info: WorkspaceInfo): FlatRow[] => {
    const rows: FlatRow[] = [];

    const pushDir = (dir: string, depth: number): void => {
      const entries = children.get(dir);
      if (!entries) {
        // Читаем папку и перерисуем, когда ответ придёт; пока показываем сообщение.
        if (!failed.has(dir)) void load(dir).then(render);
        rows.push({ kind: 'loading', dir });
        return;
      }
      const list = visible(entries, dir);
      const nest = options.fileNesting
        ? nestEntries(
            list.map((item) => item.name),
            effectiveNestingRules(options.nestingRules),
          )
        : null;
      // Поле создания имени — первым ребёнком папки: строка «появляется» под ней.
      if (isCreateTarget(inlineEdit, dir)) rows.push({ kind: 'create', parent: dir, depth });

      for (const entry of list) {
        if (nest?.hidden.has(entry.name)) continue;
        rows.push({ kind: 'entry', entry, depth, dir, nested: false, deleted: false });
        for (const name of nest?.children.get(entry.name) ?? []) {
          const child = list.find((item) => item.name === name);
          // Класс `is-nested` — метка спутника: по ней видно вложение, и на неё
          // смотрит проба (строка в дереве есть, но отдельной не считается).
          if (child) rows.push({ kind: 'entry', entry: child, depth: depth + 1, dir, nested: true, deleted: false });
        }
        if (entryIsDirectory(entry) && expanded.has(entry.path)) pushDir(entry.path, depth + 1);
      }

      // Удалённые, но не закоммиченные файлы: на диске их нет, поэтому в списке
      // папки они не придут — собираем строку сами, чтобы правка была видна.
      for (const gone of deps.git.deletedIn(dir)) {
        rows.push({
          kind: 'entry',
          entry: { name: nameOf(gone.path), path: gone.path, kind: 'file', size: 0, mtimeMs: 0 },
          depth,
          dir,
          nested: false,
          deleted: true,
        });
      }
    };

    if (info.roots.length <= 1) {
      pushDir(info.root, 0);
      return rows;
    }
    for (const item of info.roots) {
      const active = item.root === info.root;
      const collapsed = collapsedRoots.has(item.root);
      rows.push({ kind: 'root', root: item, active, collapsed });
      if (!collapsed) pushDir(item.root, 1);
    }
    return rows;
  };

  /** Собрать узел строки. `null` — строка себя не показывает (её рисует поле ввода). */
  const buildRow = (row: FlatRow): HTMLElement | null => {
    if (row.kind === 'root') return rootRow(row.root, row.active, row.collapsed);
    if (row.kind === 'loading') {
      return h('div', { class: 'tree-loading' }, failed.has(row.dir) ? 'Не удалось прочитать папку' : 'Читаю папку…');
    }
    if (row.kind === 'create') {
      const edit = inlineEdit;
      if (edit?.kind !== 'create') return null;
      return inlineInput(row.depth, '', (value) => void commitCreate(edit, value));
    }
    return renderRow(row.entry, row.depth, row.dir, { nested: row.nested, deleted: row.deleted });
  };

  /** Распорка высотой скрытых строк: она и держит честную длину прокрутки. */
  const gap = (height: number): HTMLElement =>
    h('div', { class: 'tree-gap', style: { height: `${Math.max(0, Math.round(height))}px` } });

  /**
   * Нарисовать окно строк вокруг видимой части. Строки вне окна не создаются —
   * ради этого виртуализация и нужна: в монорепо в одной папке бывают десятки
   * тысяч файлов, и держать все узлы в DOM нельзя. Сверху и снизу — распорки на
   * высоту скрытых строк, чтобы полоса прокрутки и прокрутка остались честными.
   */
  const renderWindow = (): void => {
    const host = rowsHost;
    const scroller = treeEl;
    if (!host || !scroller) return;

    const total = flatRows.length;
    const viewport = scroller.clientHeight;

    const paintRange = (first: number, last: number, stride: number): void => {
      const fragment = document.createDocumentFragment();
      if (stride > 0 && first > 0) fragment.appendChild(gap(first * stride));
      for (let index = first; index < last; index += 1) {
        const node = buildRow(flatRows[index]!);
        if (node) fragment.appendChild(node);
      }
      if (stride > 0 && last < total) fragment.appendChild(gap((total - last) * stride));
      host.replaceChildren(fragment);
    };

    // Высоту строки меряем по отрисованным: она зависит от плотности (настройки)
    // и масштаба интерфейса, а в пикселях её нигде не хранят.
    if (rowStride <= 0) {
      const guess = computeWindow(total, 0, viewport, 24);
      paintRange(0, Math.max(guess.last, 1), 0);
      const samples = host.querySelectorAll('.tree-row');
      const head = samples[0] as HTMLElement | undefined;
      const next = samples[1] as HTMLElement | undefined;
      if (head && next) rowStride = next.getBoundingClientRect().top - head.getBoundingClientRect().top;
      else if (head) rowStride = head.getBoundingClientRect().height;
    }

    const stride = rowStride > 0 ? rowStride : 24;
    // Начало списка внутри прокрутки: над ним — отступ дерева и закреплённые строки.
    const scrolled = Math.max(0, scroller.scrollTop - host.offsetTop);
    const window = computeWindow(total, scrolled, viewport, stride);
    paintRange(window.first, window.last, stride);
  };

  const onClick = async (entry: DirEntry, preview = false): Promise<void> => {
    // Ссылка ведёт себя как то, на что указывает: на папку — раскрывается, на файл —
    // открывается. Битую ссылку не читаем: цель не найдена, открывать нечего.
    if (entryIsDirectory(entry)) {
      if (expanded.has(entry.path)) {
        expanded.delete(entry.path);
        render();
        return;
      }
      expanded.add(entry.path);
      if (!children.has(entry.path)) await load(entry.path);
      revealChildrenOf = entry.path;
      render();
      return;
    }
    if (entryIsSymlink(entry) && (entry.symlink === undefined || entry.symlink.broken)) return;
    await deps.commands.execute('file.open', entry.path, preview ? { preview: true } : {});
  };

  /**
   * Спросить у git, какие из видимых сейчас путей игнорируются. Спрашиваем только
   * про те, о которых ещё не спрашивали: иначе каждая перерисовка слала бы запрос
   * заново. Когда ответ приносит что-то новое — дерево перерисовывается, но
   * повторного запроса не будет (пути уже отмечены спрошенными).
   */
  const askIgnored = async (): Promise<void> => {
    if (!options.dimIgnored || !deps.git.isRepository) return;
    const pending = visibleNow.filter((path) => !ignoreAsked.has(path));
    if (pending.length === 0) return;
    for (const path of pending) ignoreAsked.add(path);
    let found: string[];
    try {
      found = await deps.git.checkIgnore(pending);
    } catch {
      // Git молчит — дерево просто остаётся без приглушения: это подсказка, а не суть.
      return;
    }
    let changed = false;
    for (const path of found) {
      if (!ignored.has(path)) {
        ignored.add(path);
        changed = true;
      }
    }
    if (changed) render();
  };

  /**
   * Прочитать подмодули проекта. Их пути в git относительны корня, а дерево держит
   * абсолютные — переводим сразу: сравнение по строке на каждой строке дешевле.
   */
  const loadSubmodules = async (root: string): Promise<void> => {
    if (!deps.git.isRepository) return;
    let list: GitSubmodule[];
    try {
      list = await deps.git.submodules();
    } catch {
      return;
    }
    const next = new Map<string, GitSubmodule>();
    // Путь подмодуля git печатает через прямой слэш — переводим в разделитель системы.
    for (const item of list) next.set(joinPath(root, item.path.split('/').join(separatorOf(root))), item);
    submodules = next;
    render();
  };

  /** Верхняя строка корня: имя папки, признак активного и действия по правому клику. */
  const rootRow = (item: WorkspaceRoot, isActive: boolean, collapsed: boolean): HTMLElement => {
    const classes = ['tree-row', 'is-root'];
    if (isActive) classes.push('is-active');
    if (collapsed) classes.push('is-collapsed');
    const arrow = svgIcon(collapsed ? 'chevron' : 'chevronDown', 12);
    const row = h(
      'div',
      { class: classes.join(' '), title: item.root, style: { paddingLeft: `${4}px` } },
      arrow,
      folderIcon(item.name, !collapsed),
      h('span', { class: 'tree-name' }, item.name),
      isActive ? h('span', { class: 'tree-root-active', title: 'Активная папка области' }, '•') : null,
    );
    row.addEventListener('click', () => {
      // Клик по корню: делает его активным (туда идут git и поиск) и сворачивает/раскрывает.
      if (collapsed) collapsedRoots.delete(item.root);
      else collapsedRoots.add(item.root);
      if (!isActive) void deps.workspace.setActiveRoot(item.root).catch(() => undefined);
      else render();
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(
        [
          { label: 'Сделать активной', onSelect: () => void deps.workspace.setActiveRoot(item.root) },
          { separator: true as const },
          {
            label: 'Убрать из рабочей области',
            danger: true,
            onSelect: () => void deps.workspace.removeRoot(item.root),
          },
        ],
        event.clientX,
        event.clientY,
      );
    });
    return row;
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
    visibleNow = [];
    const info = deps.workspace.current;

    if (!info) {
      ignoreRoot = null;
      submodules = new Map();
      element.appendChild(
        h(
          'div',
          { class: 'empty-note' },
          h('p', {}, 'Проект не открыт'),
          h(
            'button',
            {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => void deps.commands.execute('workspace.openFolder'),
            },
            'Открыть папку',
          ),
        ),
      );
      return;
    }

    // Другой проект — прежние ответы git к нему не относятся: начинаем с чистого листа.
    if (info.root !== ignoreRoot) {
      const rootChanged = ignoreRoot !== null;
      ignoreRoot = info.root;
      ignored.clear();
      ignoreAsked.clear();
      if (rootChanged || submodules.size === 0) void loadSubmodules(info.root);
    }

    element.appendChild(
      h(
        'div',
        { class: 'panel-header' },
        // Вместо слова «Проект» — имя папки: заголовок говорит, что открыто,
        // а полный путь лежит в подсказке, чтобы длинное имя не резало кнопки.
        h('span', { class: 'panel-title', title: `${info.name} · ${info.root}` }, info.name),
        h(
          'div',
          { class: 'panel-actions' },
          h(
            'button',
            { class: 'icon-btn', type: 'button', title: 'Новый файл', onClick: () => startCreate('file') },
            svgIcon('filePlus', 15),
          ),
          h(
            'button',
            { class: 'icon-btn', type: 'button', title: 'Новая папка', onClick: () => startCreate('directory') },
            svgIcon('folderPlus', 15),
          ),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Добавить папку в рабочую область',
              onClick: () => void deps.commands.execute('workspace.addFolder'),
            },
            svgIcon('plus', 15),
          ),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Свернуть все папки',
              onClick: () => {
                expanded.clear();
                render();
              },
            },
            svgIcon('collapse', 15),
          ),
          h(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Обновить',
              onClick: () => void deps.commands.execute('workspace.refresh'),
            },
            svgIcon('refresh', 14),
          ),
        ),
      ),
    );

    // tabindex -1: дерево можно сфокусировать программно (в мышь и клавиатуру
    // табом оно не попадает). Фокус нужен, чтобы F2 и Del относились к дереву,
    // а не к редактору: глобальная привязка Delete удаляла бы файл при наборе.
    const tree = h('div', { class: 'tree', tabindex: '-1' });
    treeEl = tree;
    const host = h('div', { class: 'tree-rows' });
    rowsHost = host;
    if (pinned.length > 0) tree.appendChild(pinnedBlock());
    tree.appendChild(host);
    tree.addEventListener('contextmenu', (event) => openMenu(null, event));
    tree.addEventListener('keydown', (event) => onTreeKey(event));
    // Прокрутили — рисуем другое окно строк. Полную перерисовку не делаем: иначе
    // на каждой прокрутке пересобирались бы заголовок панели и закреплённые строки.
    tree.addEventListener('scroll', () => {
      savedScroll = tree.scrollTop;
      renderWindow();
    });
    // Сброс мимо строк — в корень области: так файл уезжает «наверх», к проекту.
    tree.addEventListener('dragover', (event) => {
      const root = deps.workspace.root;
      if (!root || dragging.length === 0 || event.target !== tree) return;
      if (movePlan(dragging, root).length === 0) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = copyDrag(event) ? 'copy' : 'move';
    });
    tree.addEventListener('drop', (event) => {
      const root = deps.workspace.root;
      if (!root || event.target !== tree) return;
      event.preventDefault();
      const moving = dragging;
      dragging = [];
      if (moving.length > 0 && movePlan(moving, root).length > 0) {
        void deps.commands.execute(copyDrag(event) ? 'file.copyInto' : 'file.moveInto', moving, root);
      }
    });
    element.appendChild(tree);

    // Плоский список видимых строк: по нему считаем окно и обходим выделение.
    flatRows = buildFlat(info);
    visibleNow = [];
    // Удалённые строки в порядок выделения не берём: файла на диске нет, и массовая
    // операция над ним (Shift-диапазон) споткнулась бы о несуществующий путь.
    for (const row of flatRows) if (row.kind === 'entry' && !row.deleted) visibleNow.push(row.entry.path);
    renderWindow();
    // Прокрутку возвращаем ПОСЛЕ раскладки распорок: до неё высота списка нулевая,
    // и браузер обрезал бы `scrollTop` до нуля. Затем рисуем окно уже на месте.
    if (savedScroll > 0) {
      tree.scrollTop = savedScroll;
      renderWindow();
    }
    // Прокрутка к строке по её номеру: сама строка может быть вне окна, и в DOM
    // её нет — искать `[data-path]` нечего. Просьба живёт до первой удачной прокрутки.
    if (revealTarget) {
      const index = flatRows.findIndex((row) => row.kind === 'entry' && row.entry.path === revealTarget);
      if (index >= 0 && rowStride > 0) {
        tree.scrollTop = Math.max(0, host.offsetTop + index * rowStride - 40);
        savedScroll = tree.scrollTop;
        renderWindow();
        revealTarget = null;
      }
    }
    // Раскрытие отыграно: следующая перерисовка — уже без движения.
    revealChildrenOf = null;

    // Строку перерисовали — возвращаем фокус дереву, если его туда просили
    // (клик по строке). Один раз: иначе фокус выдёргивался бы из редактора при
    // каждом обновлении дерева.
    if (refocusTreeOnce) {
      refocusTreeOnce = false;
      tree.focus();
    }

    // Строки нарисованы — видимый набор известен, спрашиваем про игнорируемые.
    void askIgnored();
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
    // Часть выделенных путей могла исчезнуть (удаление извне) — чистим, чтобы
    // следующая операция не споткнулась о пропавший путь. Пути вне
    // перечитанных папок не трогаем: про них мы сейчас ничего не знаем.
    const reread = new Set(dirs);
    const known = new Set(selection.paths.filter((path) => !reread.has(parentOf(path))));
    for (const entries of children.values()) for (const entry of entries) known.add(entry.path);
    selection = normalizeSelection(selection, known);
    selected = selection.anchor;
    render();
  };

  const scheduleRefresh = debounce(() => void refresh(), 250);

  const reveal = (target: string): void => {
    const info = deps.workspace.current;
    if (!info || !isInsidePath(info.root, target)) return;

    // Раскрываем папки пути по очереди: сегменты режем по обоим разделителям,
    // а собираем обратно тем, что у корня (путь уходит дальше в main).
    const segments = splitPath(pathAfter(info.root, target));
    segments.pop();
    let current = info.root;
    for (const segment of segments) {
      current = joinPath(current, segment);
      expanded.add(current);
      if (!children.has(current)) void load(current).then(render);
    }
    selected = target;
    selection = { paths: [target], anchor: target };
    // Прокрутку заказываем номером строки: если она вне окна, в DOM её ещё нет.
    revealTarget = target;
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
    selection = EMPTY_SELECTION;
    // Другой проект — дерево начинается сверху, прежняя прокрутка к нему не относится.
    savedScroll = 0;
    revealTarget = null;
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
  deps.documents.onDidChangeDirty(syncDirty);
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
        // Разделитель берётся из пути: с шаблоном `${root}/` на Windows папки
        // прошлой сессии не восстанавливались.
        if (isInsidePath(root, item)) expanded.add(item);
      }
      // Отрисовка сама подтянет корень и раскрытые уровни (см. `paint`).
      render();
    },
    pinnedPaths: () => [...pinned],
    restorePinned(paths) {
      // Чужие пути (из другого проекта) отбрасываем: открывать по ним нечего.
      pinned = normalizePins(paths, deps.workspace.root);
      render();
    },
    togglePin: setPinned,
    applySettings(next) {
      const dimChanged = options.dimIgnored !== next.dimIgnored;
      // Плотность строк меняет их высоту — перемерим её на следующей отрисовке.
      if (options.rowDensity !== next.rowDensity) rowStride = 0;
      options = next;
      // Плотность строк — атрибут-переключатель: CSS читает его и берёт свою высоту.
      element.dataset.rows = next.rowDensity;
      // Приглушение включили обратно — про игнорируемые надо спросить заново.
      if (dimChanged) {
        ignored.clear();
        ignoreAsked.clear();
      }
      render();
    },
  };
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

/* Имя и родителя пути считает shared/paths: разделитель там берётся из пути. */

/** Есть ли активное создание внутри указанной папки. */
function isCreateTarget(edit: InlineEdit | null, path: string): edit is Extract<InlineEdit, { kind: 'create' }> {
  return edit?.kind === 'create' && edit.parent === path;
}
