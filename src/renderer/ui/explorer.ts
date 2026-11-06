import type { DirEntry, ExplorerSettings, GitChange, WorkspaceInfo } from '../../shared/api';
import type { WorkspaceRoot } from '../../shared/workspace-roots';
import { submoduleStateLabel, type GitSubmodule } from '../../shared/git-submodules';
import { maskToRegExp } from '../../shared/glob';
import { plural } from '../../shared/review';
import { countExcluded, excludedLabel } from '../core/excluded-notes';
import { emptyReasonFor, emptyState, type EmptyReason } from '../core/empty-state';
import { chainDepth, folderChain, type FolderChain } from '../core/folder-chain';
import { isInsidePath, joinPath, nameOf, parentOf, pathAfter, separatorOf, splitPath } from '../../shared/paths';
import {
  alreadyThereNotice,
  dropKind,
  dropTargetDir,
  dropVerdict,
  movedTo,
  skippedSource,
} from '../../shared/drop-guard';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { GitInsideChange, GitModel } from '../core/git-model';
import type { OpenEditors } from '../core/open-editors';
import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import { entryIsDirectory, entryIsFile, entryIsSymlink, symlinkLabel } from '../../shared/entry-kind';
import { pairFromSelection } from '../core/file-compare';
import { effectiveNestingRules, nestEntries } from '../core/file-nesting';
import { checkName } from '../../shared/name-check';
import { groupByKind } from '../core/tree-group';
import { packageAncestorDirs, topLevelPackages } from '../../shared/monorepo';
import type { ProjectPackagesModel } from '../core/project-packages';
import {
  FILE_LABEL_IDS,
  fileLabelName,
  labelOf,
  sanitizeLabels,
  setLabel,
  type FileLabelId,
  type FileLabelRecord,
} from '../../shared/file-labels';
import { isFavorite, normalizeFavorites, toggleFavorite } from '../../shared/favorites';
import { addressName, parseFsAddress } from '../../shared/fs-address';
import { badgeFor, badgeTitle } from '../../shared/icon-badges';
import { isPinned, normalizePins, togglePin } from '../core/tree-pins';
import { sortTree } from '../core/tree-sort';
import { computeWindow } from '../core/tree-window';
import { filterTreePaths, matchName, withNestedHosts, type NestedRowInfo } from '../core/tree-filter';
import { internalSkip, movePlan, type InternalSkip } from '../core/tree-move';
import {
  clickSelection,
  EMPTY_SELECTION,
  normalizeSelection,
  type TreeClickMode,
  type TreeSelection,
} from '../core/tree-selection';
import { walkTree, type WalkAction, type WalkKey, type WalkRow } from '../core/tree-walk';
import { ariaPositions, type AriaPosition } from '../core/tree-aria';
import { treeRowId } from '../core/list-nav';
import { EMPTY_TYPEAHEAD, typeaheadPress, typeaheadTarget } from '../core/tree-typeahead';
import { ancestorsAt, breadcrumbChanged, type Breadcrumb } from '../core/tree-crumbs';
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
  /**
   * Увести фокус в дерево — вход с клавиатуры. Ставим его на выделенную строку,
   * а если выделения нет — на первую: без этого после команды фокус оставался
   * в пустоте, и следующая стрелка уходила в чужое место.
   */
  focus(): void;
  scheduleRefresh(): void;
  reveal(path: string): void;
  /** Создание с инлайн-вводом имени: цель — выбранная папка или её родитель. */
  startCreate(entryKind: 'file' | 'directory'): void;
  startRename(path: string): void;
  /** Раскрытые папки — сохраняются в сессии проекта. */
  expandedPaths(): string[];
  /**
   * Раскрыть ещё не раскрытую папку без клика — для проб и для тех, кто ставит
   * набор до первой отрисовки. Путь уже раскрыт или его нет в дереве — тихо ничего.
   */
  expand(path: string): void;
  /** Вернуть раскрытые папки прошлой сессии: чужие пути игнорируются. */
  restoreExpanded(paths: readonly string[]): void;
  /** Где стояла прокрутка дерева, px — часть места работы. */
  scrollTop(): number;
  /** Вернуть прокрутку прошлой сессии: дальше видимой части дерево не прокручивается. */
  restoreScroll(top: number): void;
  /** Вид и поведение дерева: значки, сортировка, фильтры, клик. */
  applySettings(settings: ExplorerSettings): void;
  /** Закреплённые файлы и папки — блоком сверху; хранятся в сессии проекта. */
  pinnedPaths(): string[];
  restorePinned(paths: readonly string[]): void;
  /** Закрепить или открепить путь (пункт меню дерева). */
  togglePin(path: string): void;
  /** Показать скрытые или спрятать их снова, не заходя в настройки. */
  toggleHidden(): void;
  /**
   * Показать только изменённое по git и обратно. Не настройка: переключатель
   * в настройках пережил бы сам взгляд (см. `onlyChanged`).
   */
  toggleOnlyChanged(): void;
  /** Включён ли сейчас режим «только изменённые» (нужно подписи кнопки и команде). */
  isOnlyChanged(): boolean;
  /**
   * «Избранное»: постоянный список мест. Живёт в настройках IDE и переживает смену
   * проекта — в отличие от закрепления, которое принадлежит сессии проекта
   * (см. `shared/favorites.ts`).
   */
  favorites(): string[];
  setFavorites(paths: readonly string[]): void;
  /** Добавить путь в избранное или убрать его (пункт меню дерева). */
  toggleFavorite(path: string): void;
  /** Метки файлов в дереве: цветные ярлыки; хранятся в сессии проекта. */
  labels(): FileLabelRecord[];
  restoreLabels(records: unknown): void;
  /** Поставить файлу метку, заменить прежнюю или снять (`null`). */
  setFileLabel(path: string, label: FileLabelId | null): void;
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
  // Автораскрытие — включено: так ведёт себя Zed, и без него файл из вкладки
  // приходится искать глазами по всему дереву.
  revealActiveFile: true,
  confirmDelete: true,
  exclude: [],
  fileNesting: false,
  compactFolders: true,
  nestingRules: [],
  updateImportsOnRename: true,
  groupByType: false,
  groupByPackage: false,
  byRoot: {},
  badges: [],
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
  /** Избранное изменилось — список надо записать в настройки IDE. */
  onFavoritesChange?: () => void;
  /**
   * Удалённые папки рабочего места: адреса SSH/WSL/контейнера. Не задано — блока
   * в дереве нет (как и у прочих необязательных возможностей).
   */
  remoteRoots?: () => string[];
  /** Убрать адрес из списка удалённых папок (настройки правит вызывающий). */
  removeRemoteRoot?: (address: string) => void;
  /** Открыть файл удалённой папки: у него свой просмотр (см. `ui/remote-file-modal.ts`). */
  openRemoteFile?: (address: string) => void;
  /** Метка файла изменилась — рабочее место стоит сохранить (см. сессию). */
  onLabelsChange?: () => void;
  /**
   * Папка раскрыта или свёрнута — то же самое: без этого в сессии остался бы
   * вчерашний набор раскрытых папок (всё пишется один раз, при закрытии окна).
   */
  onExpandedChange?: () => void;
  /**
   * Прокрутка дерева сдвинулась — тоже повод сохранить сессию. Событие идёт потоком,
   * поэтому сессия и пишет его в глубокую запись, после паузы.
   */
  onScrollChange?: () => void;
  /** Пакеты проекта: по ним дерево в монорепо показывает проекты строками. */
  packages?: ProjectPackagesModel;
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
  /** Сказать человеку, почему перетаскивание не сработало. Не задано — молчим. */
  notify?: (message: string, kind?: 'info' | 'error') => void;
  /**
   * Разделить редактор СЕЙЧАС — под `Ctrl+Enter` на файле. Не задано —
   * `Ctrl+Enter` открывает как обычный `Enter`: тихо терять клавишу хуже, чем
   * открыть не туда.
   */
  splitEditor?: () => void;
  /**
   * Автораскрытие: активный файл подсвечивается и прокручивается в дереве сам.
   * По умолчанию включено — так же, как в Zed (`auto_reveal_entries`).
   */
  autoReveal?: () => boolean;
}

/**
 * Проводник: скруглённые строки, инлайн-переименование
 * и контекстное меню. Папки читаются лениво и кэшируются.
 */
export function createExplorer(deps: ExplorerDeps): ExplorerView {
  const element = h('div', { class: 'explorer' });
  const expanded = new Set<string>();
  /**
   * Раскрыть или свернуть папку — единственное место, где меняется набор: там же и
   * единственный повод сказать сессии, что рабочее место изменилось.
   * Возвращает `true`, если набор действительно сменился: по этому признаку внешний
   * код знает, что надо дождаться перерисовки (проба ждёт, а не спит).
   */
  const setExpanded = (path: string, open: boolean): boolean => {
    if (open === expanded.has(path)) return false;
    if (open) expanded.add(path);
    else expanded.delete(path);
    deps.onExpandedChange?.();
    return true;
  };
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
   * Дерево НЕ в фокусе: выделение в нём есть, но клавиши уйдут не сюда — поэтому
   * обе его подсветки бледнеют. Так видно, куда уйдёт `Enter`: «выбранных» строк
   * в окне бывает две (дерево и палитра, два дерева рядом), и без этого признака
   * они выглядят равноправными.
   *
   * Держим событийно, а не по `document.activeElement` на каждой строке: строк в
   * дереве тысячи, а фокус меняется раз в клик.
   */
  let treeFocused = false;

  const treeHasFocus = (): boolean => treeFocused;
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
   * там событие приходит от скрытой textarea редактора, и отличить его сложно.
   */
  const onTreeKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    // Поле ввода живёт внутри дерева (создание, переименование) — там клавиши чужие.
    if (target?.closest('input, textarea, select') || target?.isContentEditable) return;
    // Ctrl+F в дереве — фильтр по нему самому, а не поиск по всему проекту.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      filterInput?.focus();
      filterInput?.select();
      return;
    }
    // Показанная копия забирает свои клавиши первой: она видна, а фокус — в дереве.
    if (deps.peekKey?.(event)) {
      event.preventDefault();
      return;
    }
    // Типизированный поиск: буква без модификаторов — прыжок к строке на неё.
    // Стоит ДО `Enter`/`F2`: там свои сочетания, а сюда попадает только одиночный
    // печатный символ. Ctrl/Alt уже разобраны выше, поэтому не конфликтует с ними.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeahead = typeaheadPress(typeahead, event.key, Date.now());
      const rows = walkRows();
      const hit = typeaheadTarget(
        rows.map((row) => ({ path: row.path, name: nameOf(row.path) })),
        selected,
        typeahead.buffer,
      );
      if (hit) {
        event.preventDefault();
        applyWalk({ kind: 'move', path: hit });
        return;
      }
    }

    // Ход по дереву стрелками: до этого их не было вовсе — до файла можно было
    // добраться только мышью. Строки знают свою глубину и раскрыты ли они, поэтому
    // правило живёт в `core/tree-walk.ts`, а здесь только применение.
    // «*» приходит как `event.key === '*'` и на русской раскладке тоже (там это
    // та же клавиша): сверяем по `key`, а не по коду, — так же, как остальные.
    const walkKey = event.key === '*' ? 'Star' : event.key;
    // `Shift+↑/↓` — не ход, а выделение диапазона. Правило «от якоря до курсора» уже
    // есть в `core/tree-selection.ts` для мыши (`clickSelection(..., 'range')`); с
    // клавиатуры в него не было входа вовсе — `tree-walk` про модификатор не знает
    // и знать не должен: он решает «куда ведёт клавиша», а не «как ложится
    // выделение». Поэтому сначала двигаем курсор обычным ходом, потом тянем
    // диапазон до него — от прежнего якоря, как при клике с `Shift`.
    if (event.shiftKey && (walkKey === 'ArrowUp' || walkKey === 'ArrowDown')) {
      const action = walkTree(walkRows(), selected, walkKey as WalkKey);
      if (action && action.kind === 'move') {
        event.preventDefault();
        selection = clickSelection(
          selection.anchor ? selection : { paths: [action.path], anchor: action.path },
          walkRows().map((row) => row.path),
          action.path,
          'range',
        );
        selected = action.path;
        paint();
        return;
      }
    }
    if (WALK_KEYS.has(walkKey)) {
      const action = walkTree(walkRows(), selected, walkKey as WalkKey);
      if (action) {
        event.preventDefault();
        applyWalk(action);
        return;
      }
      // Край списка или файл без детей — нажатие не наше, дальше его не трогаем.
    }

    // Ниже — клавиши, которым нужна выделенная строка. Все они живут в
    // `tree-walk.ts` рядом со стрелками: правило одно, мышью и клавишей
    // приходят в одни и те же `applyWalk`-ветки.
    const selectedWalkKey = walkKey === ' ' ? 'Space' : walkKey;
    if (SELECTION_KEYS.has(selectedWalkKey)) {
      const action = walkTree(walkRows(), selected, selectedWalkKey as WalkKey);
      if (action) {
        event.preventDefault();
        applyWalk(action, event);
      }
      return;
    }
  };
  let selected: string | null = null;
  /** Закреплённые пути (блок «Закреплённые» сверху); порядок закрепления сохраняем. */
  let pinned: string[] = [];
  /** Избранные пути (блок «Избранное» над деревом); список живёт в настройках IDE. */
  let favorites: string[] = [];
  /** Раскрытые строки блока удалённых папок: адрес → прочитанное содержимое. */
  const remoteExpanded = new Set<string>();
  const remoteChildren = new Map<string, DirEntry[]>();
  /**
   * Что сейчас читается и что прочитать не удалось. Без этого пустая папка и папка,
   * которая ещё читается (или уже отказала), выглядели бы одинаково — а по ssh чтение
   * занимает секунды, и «папка пуста» на них было бы прямой ложью.
   */
  const remoteLoading = new Set<string>();
  const remoteFailed = new Set<string>();
  /** Метки файлов (цветные ярлыки в строках); живут в сессии проекта. */
  let labels: FileLabelRecord[] = [];
  /** Выделенные строки (Ctrl/Shift) и якорь диапазона; порядок — как в дереве. */
  let selection: TreeSelection = EMPTY_SELECTION;
  /**
   * Показывать только изменённое по git. Это НЕ настройка: взгляд «что я трогал»
   * живёт минуты, а переключатель в настройках его бы пережил и потом удивлял.
   */
  let onlyChanged = false;
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

  /**
   * Добавить путь в избранное или убрать его. Список сохраняется в настройки IDE:
   * он общий для всех проектов (см. `onFavoritesChange`).
   */
  const setFavorite = (path: string): void => {
    favorites = toggleFavorite(favorites, path);
    deps.onFavoritesChange?.();
    render();
  };

  /** Лежит ли путь внутри какого-нибудь корня области. */
  const isInsideRoots = (path: string): boolean => deps.workspace.roots.some((item) => isInsidePath(item.root, path));

  /**
   * Клик по избранному: файл открываем, папку внутри области показываем в дереве, а
   * папку ВНЕ области поднимаем корнем — ради этого избранное и живёт вне сессии
   * проекта: сюда кладут чужие репозитории, которые правят заодно.
   */
  const openFavorite = (path: string, isDirectory: boolean): void => {
    if (!isDirectory) {
      void deps.commands.execute('file.open', path);
      return;
    }
    if (isInsideRoots(path)) {
      reveal(path);
      return;
    }
    void deps.workspace.addRoot(path).catch(() => undefined);
  };

  /** Метка файла по пути или `null`. */
  const labelFor = (path: string): FileLabelId | null => labelOf(labels, path);

  /** Поставить метку, заменить прежнюю или снять её («Снять метку» в меню). */
  const setFileLabel = (path: string, label: FileLabelId | null): void => {
    if (labelFor(path) === label) return;
    labels = setLabel(labels, path, label);
    deps.onLabelsChange?.();
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

  const peekAnchor = (path: string, event?: Event): PeekAnchorPoint => {
    if (event) return rowAnchor(path, event);
    // С клавиатуры события строки нет: берём прямоугольник строки прямо из неё.
    const row = element.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    const box = row?.getBoundingClientRect();
    if (!box) return { left: 0, top: 0, bottom: 1 };
    return { left: box.left, top: box.top, bottom: box.bottom };
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

  /**
   * Блок удалённых папок: адреса SSH/WSL/контейнера из настроек рабочего места.
   *
   * Папки читаются тем же `remote.readDir`, что и локальные — `workspace.readDir`:
   * содержимое приходит обычными `DirEntry`, а путь внутри адреса остаётся адресом
   * (`ssh://host/srv/app/src`). Отдельный блок, а не корень области, намеренно:
   * корень участвует в git, поиске, запуске и наблюдении — а это всё локальные
   * вещи (`main/workspace/remote-fs.ts`). Файл открывается своим окном.
   */
  const remoteBlock = (): HTMLElement => {
    const header = h('div', { class: 'tree-remote-head' }, svgIcon('server', 12), h('span', {}, 'Удалённые папки'));
    const roots = deps.remoteRoots?.() ?? [];
    // Адрес убрали из списка — забываем и его содержимое, и отметки о нём: держать
    // чужое незачем, а вернув адрес обратно, человек получит свежее чтение.
    pruneRemote(roots);
    const rows = roots.map((address) => remoteTree(address, 0));
    return h('div', { class: 'tree-remote' }, header, ...rows);
  };

  /** Забыть данные адресов, которых больше нет в списке (вместе с их подкаталогами). */
  const pruneRemote = (roots: readonly string[]): void => {
    if (remoteChildren.size === 0 && remoteExpanded.size === 0 && remoteFailed.size === 0) return;
    const alive = (key: string): boolean => roots.some((root) => key === root || key.startsWith(`${root}/`));
    for (const key of [...remoteChildren.keys()]) if (!alive(key)) remoteChildren.delete(key);
    for (const key of [...remoteExpanded]) if (!alive(key)) remoteExpanded.delete(key);
    for (const key of [...remoteFailed]) if (!alive(key)) remoteFailed.delete(key);
    for (const key of [...remoteLoading]) if (!alive(key)) remoteLoading.delete(key);
  };

  /** Строка удалённой папки и (если раскрыта) её содержимое. */
  const remoteTree = (address: string, depth: number): HTMLElement => {
    const parsed = parseFsAddress(address);
    const name = parsed ? addressName(parsed) : address;
    const isExpanded = remoteExpanded.has(address);
    const kids = remoteChildren.get(address) ?? [];
    const row = h(
      'div',
      { class: `tree-row is-remote${isExpanded ? ' is-expanded' : ''}`, title: address, dataset: { path: address } },
      h('span', { class: `tree-twisty${isExpanded ? ' is-open' : ''}` }, svgIcon('chevron', 12)),
      svgIcon('server', 15),
      h('span', { class: 'tree-name' }, name),
    );
    row.style.paddingLeft = `${8 + depth * options.indent}px`;
    row.addEventListener('click', () => void toggleRemote(address));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(
        [
          { label: 'Обновить', onSelect: () => void reloadRemote(address) },
          {
            label: 'Копировать адрес',
            onSelect: () => void navigator.clipboard?.writeText(address).catch(() => undefined),
          },
          { separator: true as const },
          { label: 'Убрать из списка', danger: true, onSelect: () => deps.removeRemoteRoot?.(address) },
        ],
        event.clientX,
        event.clientY,
      );
    });

    const rows: HTMLElement[] = [row];
    if (!isExpanded) return h('div', { class: 'tree-remote-node' }, ...rows);
    for (const entry of kids) {
      if (entry.kind === 'directory') {
        rows.push(remoteTree(entry.path, depth + 1));
        continue;
      }
      const fileRow = h(
        'button',
        { class: 'tree-row is-remote-file', type: 'button', title: entry.path, dataset: { path: entry.path } },
        h('span', { class: 'tree-twisty' }),
        svgIcon('file', 15),
        h('span', { class: 'tree-name' }, entry.name),
      );
      fileRow.style.paddingLeft = `${8 + (depth + 1) * options.indent}px`;
      fileRow.addEventListener('click', () => deps.openRemoteFile?.(entry.path));
      rows.push(fileRow);
    }
    // Три разных состояния — тремя разными словами: читается, не прочиталось, пусто.
    if (remoteLoading.has(address)) {
      rows.push(h('div', { class: 'tree-empty-note' }, 'Читаю…'));
    } else if (remoteFailed.has(address)) {
      rows.push(h('div', { class: 'tree-empty-note is-error' }, 'Не удалось прочитать — проверьте адрес и доступ'));
    } else if (kids.length === 0) {
      rows.push(h('div', { class: 'tree-empty-note' }, 'Папка пуста'));
    }
    return h('div', { class: 'tree-remote-node' }, ...rows);
  };

  /** Раскрыть/свернуть удалённую папку: содержимое читаем при первом раскрытии. */
  const toggleRemote = async (address: string): Promise<void> => {
    if (remoteExpanded.has(address)) {
      remoteExpanded.delete(address);
      render();
      return;
    }
    remoteExpanded.add(address);
    render();
    // Отказ прошлого чтения не запоминаем: раскрытие снова пробует адрес.
    if (!remoteChildren.has(address) && !remoteLoading.has(address)) await reloadRemote(address);
  };

  const reloadRemote = async (address: string): Promise<void> => {
    if (remoteLoading.has(address)) return;
    remoteLoading.add(address);
    remoteFailed.delete(address);
    render();
    try {
      remoteChildren.set(address, await deps.rpc.request('remote.readDir', { address }));
    } catch (error) {
      remoteChildren.delete(address);
      remoteFailed.add(address);
      console.error('[chui] не удалось прочитать удалённую папку', address, error);
    } finally {
      remoteLoading.delete(address);
    }
    render();
  };

  /**
   * Блок «Избранное» над деревом. Рисуется по абсолютным путям, как и закреплённые:
   * путь может вести и за пределы области. Удалённую папку из списка не выкидываем
   * молча — клик по ней скажет, что открыть нечего.
   */
  const favoritesBlock = (): HTMLElement => {
    const header = h('div', { class: 'tree-favorites-head' }, svgIcon('star', 12), h('span', {}, 'Избранное'));
    const rows = favorites.map((path) => {
      const entry = findEntry(path);
      // Про путь вне области дерево ничего не знает: считаем его папкой — в избранное
      // кладут места, а не отдельные файлы, и раскрытие осмысленно всегда.
      const isDirectory = entry ? entryIsDirectory(entry) : true;
      const row = h(
        'div',
        { class: 'tree-row is-favorite', title: path, dataset: { path } },
        h('span', { class: 'tree-twisty' }),
        options.icons ? (isDirectory ? folderIcon(nameOf(path), true) : fileIcon(nameOf(path))) : svgIcon('file', 15),
        h('span', { class: 'tree-name' }, nameOf(path)),
        h(
          'button',
          {
            class: 'icon-btn tree-unfavorite',
            type: 'button',
            title: 'Убрать из избранного',
            onClick: (event: Event) => {
              event.stopPropagation();
              setFavorite(path);
            },
          },
          svgIcon('close', 12),
        ),
      );
      row.addEventListener('click', () => openFavorite(path, isDirectory));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(
          [
            { label: 'Убрать из избранного', onSelect: () => setFavorite(path) },
            isDirectory
              ? {
                  label: isInsideRoots(path) ? 'Показать в дереве' : 'Добавить как папку области',
                  onSelect: () => openFavorite(path, true),
                }
              : { label: 'Открыть', onSelect: () => void deps.commands.execute('file.open', path) },
          ],
          event.clientX,
          event.clientY,
        );
      });
      return row;
    });
    return h('div', { class: 'tree-favorites' }, header, ...rows);
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
  /**
   * То же, что `visible`, но говорит и сколько отсеяно.
   *
   * Исключённое раньше пропадало молча: файл есть на диске, а в дереве его нет, и
   * причину приходилось выуживать из настроек. Теперь папка показывает, скольких она
   * не показывает, — но только ИСКЛЮЧЁННЫХ: скрытое точкой — это не «исключение», а
   * обычная тишина, и считать его в ту же строку значило бы врать цифрой.
   */
  /**
   * Папки, в которых человек попросил «показать исключённое» на этот раз.
   *
   * Именно на раз: переживёт перерисовку (иначе строка исчезла бы вместе с
   * кликом), но не перезапуск — настройку не трогает, чужой проект не портит.
   * Смена настроек чистит набор: правило поменяли — смотреть надо заново.
   */
  const peekExcluded = new Set<string>();

  const visibleSplit = (
    entries: readonly DirEntry[],
    dir: string,
  ): { shown: DirEntry[]; excluded: number; patterns: string[] } => {
    // С несколькими корнями «относительно текущего проекта» не годится: путь берём
    // от того корня, которому папка принадлежит (файл из второй папки — к ней).
    const owner = deps.workspace.ownerOf(dir);
    const prefix = owner && dir !== owner.root ? pathAfter(owner.root, dir) : '';
    const relativeOf = (entry: { name: string }): string => (prefix ? `${prefix}/${entry.name}` : entry.name);
    // «Показать на раз» — папка без исключений, и счётчик у неё честно нулевой.
    const hiding = peekExcluded.has(dir) ? [] : options.exclude;
    const counted = countExcluded(
      entries,
      hiding,
      relativeOf,
      (entry) => !options.showHidden && entry.name.startsWith('.'),
    );
    const hidden = new Set<string>();
    if (counted.count > 0) {
      for (const entry of entries) {
        if (!options.showHidden && entry.name.startsWith('.')) continue;
        if (matchesExclude(entry.name, relativeOf(entry), hiding)) hidden.add(entry.name);
      }
    }
    const shown = sortEntries(
      entries.filter((entry) => {
        if (!options.showHidden && entry.name.startsWith('.')) return false;
        if (hidden.has(entry.name)) return false;
        // «Только изменённые»: папку пропускаем — есть ли правка вглубь, тут
        // не видно; решает раскрытая ветка (там тот же фильтр).
        if (onlyChanged && !entryIsDirectory(entry) && !isChanged(entry.path)) return false;
        return true;
      }),
    );
    return { shown, excluded: counted.count, patterns: [...counted.patterns] };
  };

  /**
   * Есть ли у пути правка по git. Спрашиваем модель точечно, а не перебираем
   * весь статус: `visibleSplit` зовётся на каждую раскрытую папку и на каждую
   * перерисовку, а изменённых в большом репозитории немало.
   * Неотслеживаемый новый файл — тоже правка: просто её ещё не видно в
   * `git status` без `-u`. Файл вне git правкой не считается — иначе режим без
   * репозитория прятал бы всё подряд и выглядел сломанным.
   */
  const isChanged = (path: string): boolean => deps.git.statusOf(path) !== undefined;

  /** Путь от корня, которому принадлежит файл: по нему работают маски значков. */
  const relativeOf = (path: string): string => {
    const owner = deps.workspace.ownerOf(path);
    if (!owner || path === owner.root) return nameOf(path);
    return pathAfter(owner.root, path) || nameOf(path);
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

  /**
   * Проверить имя до похода в main.
   *
   * Без этого занятое имя или пробел в конце доходили до файловой системы и
   * возвращались молчанием: дерево просто не менялось. Причина должна быть
   * видна там, где её вводят.
   */
  const checkNameIn = (dir: string, name: string, original?: string): string | null => {
    const siblings = (children.get(dir) ?? []).map((entry) => entry.name);
    const result = checkName(name, {
      siblings,
      original,
      windows: (window.chui?.platform ?? '') === 'win32',
    });
    return result.ok ? null : (result.reason ?? 'Имя не подходит');
  };

  const inlineInput = (
    depth: number,
    initial: string,
    commit: (value: string) => void,
    check?: (value: string) => string | null,
  ): HTMLElement => {
    const input = h('input', { class: 'tree-input', type: 'text', value: initial, spellcheck: false });
    const hint = h('div', { class: 'tree-input-hint' });
    const row = h(
      'div',
      { class: 'tree-row is-editing', style: { paddingLeft: `${8 + depth * options.indent}px` } },
      input,
      hint,
    );

    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      inlineEdit = null;
      if (value) commit(value);
      else render();
    };

    const tell = (reason: string | null): boolean => {
      hint.textContent = reason ?? '';
      input.classList.toggle('is-invalid', reason !== null);
      return reason === null;
    };

    input.addEventListener('input', () => tell(null));

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        // Не trim: пробел в конце — это ошибка имени, а не то, что можно тихо убрать.
        const reason = check?.(input.value) ?? null;
        if (!tell(reason)) return;
        finish(input.value);
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
        setExpanded(target, true);
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
          // Переименование — над ОДНОЙ строкой (у папки при этом переедет и
          // содержимое). На группе честнее сказать словами, чем переименовать
          // первую молча: человек ждал другого.
          effective.length > 1
            ? {
                label: `Переименовать… (только ${entry.name})`,
                hint: 'F2',
                onSelect: () => startRename(entry.path),
              }
            : { label: 'Переименовать…', hint: 'F2', onSelect: () => startRename(entry.path) },
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
          {
            label: isFavorite(favorites, entry.path) ? 'Убрать из избранного' : 'В избранное',
            onSelect: () => setFavorite(entry.path),
          },
          // Метка — подменю: один ярлык на файл, текущий отмечен галкой.
          {
            label: 'Метка',
            submenu: [
              ...FILE_LABEL_IDS.map((id) => ({
                label: fileLabelName(id),
                checked: labelFor(entry.path) === id,
                onSelect: () => setFileLabel(entry.path, id),
              })),
              { separator: true as const },
              {
                label: 'Снять метку',
                checked: labelFor(entry.path) === null,
                onSelect: () => setFileLabel(entry.path, null),
              },
            ],
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
          // Скрытое прячет настройка (и точка в имени, и `files.exclude`), а не
          // сам дерево: значит, и показать его — отсюда, без похода в настройки.
          {
            label: options.showHidden ? 'Скрыть скрытые файлы' : 'Показать скрытые файлы',
            checked: options.showHidden,
            onSelect: () => void deps.commands.execute('explorer.toggleHidden'),
          },
          { label: 'Обновить', onSelect: () => void deps.commands.execute('workspace.refresh') },
        ];

    showContextMenu(items, event.clientX, event.clientY);
  };

  const startCreateIn = (parent: string, entryKind: 'file' | 'directory'): void => {
    setExpanded(parent, true);
    inlineEdit = { kind: 'create', parent, entryKind };
    // Папку дочитываем до перерисовки: поле имени рисуется только у папки, чей
    // список детей уже есть (иначе на её месте строка «Читаю папку…», и поля нет),
    // а `render` после дочитки молчит, пока открыт ввод. Без ожидания создание в
    // ещё не открытой папке не показывало поля вообще.
    const ready = children.has(parent) ? Promise.resolve() : load(parent);
    // Рисуем ровно один раз и уже после перечитывания папок: лишняя перерисовка
    // заменила бы поле ввода только что созданным, а подмена узла закрывает ввод.
    void ready.then(refresh).then(paint);
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
    flags: { nested: boolean; deleted: boolean; chain?: string } = { nested: false, deleted: false },
    index?: number,
  ): HTMLElement | null => {
    const isDirectory = entryIsDirectory(entry);
    const isLink = entryIsSymlink(entry);
    const linkLabel = symlinkLabel(entry);
    const isDeleted = flags.deleted;
    const isExpanded = expanded.has(entry.path);
    const isActive = deps.openEditors.active?.path === entry.path;
    const isSelected = selection.paths.includes(entry.path);

    if (inlineEdit?.kind === 'rename' && inlineEdit.path === entry.path) {
      const renaming = inlineEdit;
      return inlineInput(
        depth,
        renaming.currentName,
        (value) => void commitRename(entry.path, value),
        (value) => checkNameIn(dir, value, renaming.currentName),
      );
    }

    const classes = ['tree-row'];
    if (isActive) classes.push('is-active');
    if (isSelected) classes.push('is-selected');
    // Фокус ушёл из дерева — клавиши здесь больше не сработают; подсветка
    // гаснет, чтобы не спорить с той, что сейчас живая.
    if (!treeHasFocus()) classes.push('is-unfocused');
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
    // Метка — личный ярлык на файле; у удалённого её не показываем (его нет на диске).
    const label = isDeleted ? null : labelFor(entry.path);
    // Значок от стороннего набора: чужую пометку проекта IDE придумать не может,
    // её приносит человек или набор значков (`explorer.badges`).
    const badge = options.badges.length > 0 ? badgeFor(entry.path, relativeOf(entry.path), options.badges) : null;

    const place = ariaPlace(entry.path);
    const row = h(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        draggable: 'true',
        // Папка — кнопка, которая раскрывает содержимое: сказать об этом читалке
        // обязательно, иначе «папка» и «файл» звучат одинаково.
        //
        // Роль `treeitem` раньше НЕ ставилась намеренно: она обещает ход стрелками,
        // а хода не было — объявить роль значило бы соврать читалке. Теперь ход есть
        // (`core/tree-walk.ts`), поэтому и роль, и уровень, и положение в наборе
        // говорятся честно.
        role: 'treeitem',
        // Имя строки — адрес для `aria-activedescendant`: фокус живёт на дереве,
        // и без имени читалка не знает, какая строка текущая. Берём номер
        // в наборе видимых строк: строки пересоздаются, узел не годится.
        ...(index === undefined ? {} : { id: treeRowId(index) }),
        'aria-level': String(place.level),
        'aria-posinset': String(place.posInSet),
        'aria-setsize': String(place.setSize),
        ...(isDirectory ? { 'aria-expanded': isExpanded ? 'true' : 'false' } : {}),
        ...(selected === entry.path ? { 'aria-selected': 'true' } : { 'aria-selected': 'false' }),
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
      // Цепочка — одна строка на весь путь `a/b/c`; полный путь в подсказке,
      // иначе по склеенной подписи не понять, где она кончается.
      // Подсветка — по тому имени, которое видно: у сжатой вложенности это цепочка.
      h('span', { class: 'tree-name' }, ...nameWithHits(flags.chain ?? entry.name)),
      // Метка — цветной ярлык: первая среди правых отметок, если она есть.
      label ? h('span', { class: `tree-label is-${label}`, title: `Метка: ${fileLabelName(label)}` }) : null,
      badge
        ? h('span', { class: `tree-badge is-custom is-${badge.color}`, title: badgeTitle(badge) }, badge.badge ?? '')
        : null,
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
      // а файл — по настройке: двойным кликом или одинарным.
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
      // Внешний перенос: берём то, что бросили из окна, а не наши строки.
      if (dragging.length === 0) {
        const types = [...(event.dataTransfer?.types ?? [])];
        if (!dropVerdict((event.dataTransfer?.files.length ?? 0) > 0, types).accept) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = copyDrag(event) ? 'copy' : 'move';
        row.classList.add('is-drop-target');
        return;
      }
      if (movePlan(dragging, dropDir).length === 0) return;
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
      if (moving.length === 0) {
        void acceptExternal(event, entry.path, isDirectory);
        return;
      }
      // Бросок, который ничего не сделает, обязан сказать ПОЧЕМУ. Иначе папка,
      // брошенная в свою же подпапку, просто «не перетаскивается» — и это
      // выглядит как поломка, а не как запрет.
      const skip = internalSkip(moving, dropDir);
      if (skip) {
        deps.notify?.(skipNotice(skip.why, nameOf(skip.first)), 'error');
        return;
      }
      void deps.commands.execute(copyDrag(event) ? 'file.copyInto' : 'file.moveInto', moving, dropDir);
    });
    return row;
  };

  /**
   * Файлы, брошенные в окно извне (проводник ОС, другая программа).
   *
   * Путь у `File` в renderer пустой — его знает только preload (`pathForFile`).
   * Без моста (тесты, браузер) путей нет, и перетаскивание честно не срабатывает.
   */
  const externalPaths = (event: DragEvent): string[] => {
    const pathForFile = window.chui?.pathForFile;
    if (!pathForFile) return [];
    const paths: string[] = [];
    for (const file of [...(event.dataTransfer?.files ?? [])]) {
      const path = pathForFile(file);
      if (path) paths.push(path);
    }
    return paths;
  };

  /**
   * Почему бросок отменён — словами, которые называют виновника.
   *
   * Три причины, и все три человек может встретить нарочно: папку в свою
   * подпапку, папку вместе с тем, что внутри неё, и файл туда, где он лежит.
   * Последняя безобидна, но и её нельзя объяснять молчанием: Ctrl+бросок в
   * свою папку — это осознанное «сделай копию рядом», и ответ «ничего» врёт.
   */
  const skipNotice = (why: InternalSkip, name: string): string => {
    if (why === 'inside-itself') return `«${name}» нельзя положить в свою же папку`;
    if (why === 'under-selected') return `«${name}» уже едет вместе с папкой, которая его содержит`;
    return `«${name}» уже лежит в этой папке`;
  };

  /** Внешний перенос в папку: проверяем, копируем или переносим, говорим, что мешает. */
  const acceptExternal = async (event: DragEvent, path: string, isDirectory: boolean): Promise<void> => {
    const sources = externalPaths(event);
    const types = [...(event.dataTransfer?.types ?? [])];
    const verdict = dropVerdict(sources.length > 0, types);
    if (!verdict.accept) {
      if (verdict.reason) deps.notify?.(verdict.reason, 'info');
      return;
    }
    const dir = dropTargetDir(path, isDirectory);
    const kind = dropKind(true, types, copyDrag(event));
    const moving: string[] = [];
    for (const source of sources) {
      const skip = skippedSource(source, dir);
      if (skip === 'inside-itself') {
        // Молчать нельзя: человек увидел бы, что перетаскивание «не сработало».
        // Текст берём из общего места — иначе внешний бросок и внутренний
        // объясняют одну и ту же беду разными словами.
        deps.notify?.(skipNotice('inside-itself', nameOf(source)), 'error');
        continue;
      }
      if (skip === 'same-dir') continue;
      // Занятое имя не перезаписываем: две копии с одним именем исчезли бы без следа.
      const taken = await deps.rpc.request('workspace.stat', { path: movedTo(source, dir) }).catch(() => null);
      if (taken) {
        deps.notify?.(alreadyThereNotice(movedTo(source, dir)), 'error');
        continue;
      }
      moving.push(source);
    }
    if (moving.length === 0) return;
    await deps.commands.execute(kind === 'copy' ? 'file.copyInto' : 'file.moveInto', moving, dir);
  };

  /**
   * Строка дерева в визуальном порядке: запись, строка корня области, поле ввода
   * имени или сообщение о чтении папки. Список плоский, а не рекурсивная отрисовка:
   * по нему считаем окно (виртуализация) и работает выделение диапазоном.
   */
  type FlatRow =
    | {
        kind: 'entry';
        entry: DirEntry;
        depth: number;
        dir: string;
        nested: boolean;
        deleted: boolean;
        /** Подпись для строки-цепочки (`a/b/c`); нет поля — обычное имя. */
        chain?: string;
      }
    | { kind: 'group'; label: string; count: number; depth: number }
    | { kind: 'package'; name: string; dir: string; relative: string; depth: number }
    | { kind: 'root'; root: WorkspaceRoot; active: boolean; collapsed: boolean }
    | { kind: 'create'; parent: string; depth: number }
    | { kind: 'loading'; dir: string }
    /**
     * «Ещё N исключено» в хвосте папки.
     *
     * Нужна, чтобы дерево не врало перечнем: файл на диске есть, но его не
     * показывают. `patterns` — какие маски это сделали: по ним человек поймёт,
     * что править, не открывая настройки наугад.
     */
    | { kind: 'excluded'; dir: string; depth: number; count: number; patterns: string[] }
    /**
     * Пустое место с объяснением и действием.
     *
     * Отдельная строка, а не текст внутри списка: у неё есть кнопка, а кнопка
     * должна попадать в окно виртуализации наравне с прочими строками.
     */
    | { kind: 'empty'; dir: string; depth: number; reason: EmptyReason; patterns: string[] };

  /** Сам список, его хозяин и высота строки: нужны окну отрисовки. */
  let treeEl: HTMLElement | null = null;
  let rowsHost: HTMLElement | null = null;
  let flatRows: FlatRow[] = [];
  /**
   * Запрос фильтра дерева. Пусто — показываем всё. Фильтр не трогает свёрнутость
   * и раскрытие: он лишь решает, какие строки попадут в `flatRows`, поэтому
   * очистка запроса возвращает дерево ровно в то состояние, в каком оно было.
   */
  let filterQuery = '';

  /**
   * Имя с подсветкой совпадений фильтра — видно, ПОЧЕМУ строка осталась.
   *
   * Без этого запрос `*.test.ts` оставлял на экране десяток похожих имён, и
   * приходилось вчитываться, чтобы понять, что именно совпало. Подсветка —
   * ответ на этот вопрос, и она же показывает, что папка осталась только ради
   * потомка: её собственное имя не подсвечено.
   */
  function nameWithHits(text: string): (Node | string)[] {
    if (filterQuery.trim() === '') return [text];
    const { ranges } = matchName(text, filterQuery);
    if (ranges.length === 0) return [text];
    const parts: (Node | string)[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
      if (start > at) parts.push(text.slice(at, start));
      parts.push(h('mark', {}, text.slice(start, end)));
      at = end;
    }
    if (at < text.length) parts.push(text.slice(at));
    return parts;
  }
  /** Поле фильтра — нужно, чтобы Ctrl+F из дерева ставил в него фокус. */
  let filterInput: HTMLInputElement | null = null;
  /** Высота строки в пикселях: меряется по отрисованной строке (зависит от плотности). */
  let rowStride = 0;
  /** Прокрутка: сохраняется между перерисовками — дерево пересобирается целиком. */
  let savedScroll = 0;
  /** Путь, к которому просили прокрутить: строка может появиться позже (папка читается). */
  let revealTarget: string | null = null;

  /**
   * Высота дерева на прошлой перерисовке окна строк. Высоту меняют окно, нижний док и
   * переключатели панелей, а окно строк считают ПО НЕЙ (см. `renderWindow`): без
   * пересчёта оно осталось бы посчитанным при старой высоте — а в момент, когда
   * раскладка ещё не встала, `clientHeight` равен нулю, и строк было бы видно мало.
   *
   * Живёт ОДНА на всё дерево, а не заводится заново в каждой отрисовке. Иначе
   * получалось так: `paint` рисовал новые строки и заводил НОВЫЙ наблюдатель, а
   * прежний продолжал следить за уже отброшенным узлом — у него высота ноль, — и
   * пересобирал строки ещё раз. Пересборка уничтожала только что открытое поле ввода
   * имени: фокус терялся, `blur` отменял ввод, и создание/переименование не работало.
   */
  let lastViewport = -1;
  const syncViewport = (): void => {
    const height = treeEl?.clientHeight ?? 0;
    if (height === lastViewport) return;
    lastViewport = height;
    renderWindow();
  };
  /** Наблюдатель один: в `paint` он переводится на новый узел дерева (см. `syncViewport`). */
  const treeResize = new ResizeObserver(syncViewport);
  window.addEventListener('resize', syncViewport);

  /**
   * Применить запрос фильтра к собранным строкам. Фильтру не нужны группы,
   * пакеты и виртуальные узлы — только пути, поэтому отдаём ему проекцию
   * «имя + путь + родитель», а оставшиеся пути возвращаем как есть.
   *
   * Родитель считается по пути, а не по глубине: строка вложенного файла
   * должна поднять из списка свою папку, даже если та нарисована на другом
   * уровне (пакеты монорепо, несколько корней).
   */
  const filtered = (rows: FlatRow[]): FlatRow[] => {
    if (filterQuery.trim() === '') return rows;
    const pathOf = (row: FlatRow): string | null => {
      if (row.kind === 'entry') return row.kind === 'entry' ? row.entry.path : null;
      if (row.kind === 'package') return row.dir;
      return null;
    };
    const nameOfRow = (row: FlatRow): string | null => {
      if (row.kind === 'entry') return row.entry.name;
      if (row.kind === 'package') return row.name;
      return null;
    };
    const projected: { name: string; path: string; parent: string }[] = [];
    for (const row of rows) {
      const path = pathOf(row);
      const name = nameOfRow(row);
      if (path === null || name === null) continue;
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      projected.push({ name, path, parent });
    }
    const keep = withNestedHosts(
      rows.flatMap((row): NestedRowInfo[] =>
        row.kind === 'entry'
          ? [
              {
                path: row.entry.path,
                nested: row.nested,
                dir: row.dir,
                depth: row.depth,
              },
            ]
          : [],
      ),
      filterTreePaths(projected, filterQuery),
    );
    return rows.filter((row) => {
      const path = pathOf(row);
      // Строки без пути (группы, разделители) не фильтруются: они держат
      // оформление списка и не несут содержимого.
      return path === null ? true : keep.has(path);
    });
  };

  /**
   * Видимые строки дерева в порядке отображения: раскрытые папки, их дети и
   * свёрнутые спутники. Порядок тот же, что узлов на экране, — по нему работает
   * выделение диапазоном (`Shift`) и прокрутка к строке.
   */
  /**
   * Сбросить фильтр дерева — общий путь для Escape и кнопки в пустом месте.
   *
   * Одному и тому же действию одно тело: иначе Escape и кнопка разойдутся, и
   * одно из двух перестанет сбрасывать список.
   */
  const clearFilter = (): void => {
    filterQuery = '';
    const input = treeEl?.querySelector<HTMLInputElement>('.tree-filter-input');
    if (input) input.value = '';
    // Перестраивает и перерисовывает `render`: у него уже есть свежий `info`,
    // а заводить второй источник правды здесь значило бы их рассинхронить.
    render();
  };

  const buildFlat = (info: WorkspaceInfo): FlatRow[] => {
    const rows: FlatRow[] = [];
    // Склеенные цепочки — на один проход сборки дерева, а не на кадр: дерево
    // пересобирается и при раскрытии папки, а карта прочитанных папок живёт долго.
    const chains = new Map<string, FolderChain>();

    const pushDir = (dir: string, depth: number, skip?: ReadonlySet<string>): void => {
      const entries = children.get(dir);
      if (!entries) {
        // Читаем папку и перерисуем, когда ответ придёт; пока показываем сообщение.
        if (!failed.has(dir)) void load(dir).then(render);
        rows.push({ kind: 'loading', dir });
        return;
      }
      const split = visibleSplit(entries, dir);
      const list = split.shown;
      const nest = options.fileNesting
        ? nestEntries(
            list.map((item) => item.name),
            effectiveNestingRules(options.nestingRules),
          )
        : null;
      // Поле создания имени — первым ребёнком папки: строка «появляется» под ней.
      if (isCreateTarget(inlineEdit, dir)) rows.push({ kind: 'create', parent: dir, depth });

      // Одна запись и её спутники (вложенные строки идут сразу под родителем).
      const pushEntry = (entry: DirEntry): void => {
        // Цепочку склеиваем только у настоящих каталогов: строка-имя со спутниками
        // (вложенный файл) — это не путь, и удлинять её не за что.
        // Склейка подчиняется настройке: при выключенной каждая папка — своя строка.
        const chain =
          options.compactFolders && entryIsDirectory(entry) ? folderChain(entry, children, '/', chains) : null;
        const deeper = chain ? chainDepth(chain) : 1;
        rows.push(
          chain && deeper > 1
            ? { kind: 'entry', entry, depth, dir, nested: false, deleted: false, chain: chain.label }
            : { kind: 'entry', entry, depth, dir, nested: false, deleted: false },
        );
        for (const name of nest?.children.get(entry.name) ?? []) {
          const child = list.find((item) => item.name === name);
          // Класс `is-nested` — метка спутника: по ней видно вложение, и на неё
          // смотрит проба (строка в дереве есть, но отдельной не считается).
          if (child) rows.push({ kind: 'entry', entry: child, depth: depth + 1, dir, nested: true, deleted: false });
        }
        if (entryIsDirectory(entry) && expanded.has(entry.path)) pushDir(chain?.path ?? entry.path, depth + deeper);
      };

      // Обычно содержимое папки — один список. С группировкой файлы разбиваются
      // по назначению под подписями, а папки остаются сверху (группировка — про файлы).
      const sections: Array<{ label: string | null; list: DirEntry[] }> = options.groupByType
        ? [
            { label: null, list: list.filter((entry) => entryIsDirectory(entry)) },
            ...groupByKind(
              list.filter((entry) => !entryIsDirectory(entry)),
              (entry) => entry.name,
            ).map((group) => ({ label: group.label, list: group.entries })),
          ]
        : [{ label: null, list }];

      for (const section of sections) {
        const shown = section.list.filter((entry) => !nest?.hidden.has(entry.name));
        if (section.label && shown.length > 0) {
          rows.push({ kind: 'group', label: section.label, count: shown.length, depth });
        }
        for (const entry of shown) {
          // Каталог, который заменяет строка пакета (сам пакет или звено к нему), не рисуем.
          if (skip && entryIsDirectory(entry) && skip.has(entry.path)) continue;
          pushEntry(entry);
        }
      }

      // Пустое место объясняет себя: какой из пяти случаев перед нами и что нажать.
      // Порядок проверок живёт в `core/empty-state.ts`: пропавший корень важнее
      // пустоты (иначе человек пойдёт создавать файл в папку, которой нет), а
      // исключённое важнее пустоты (иначе он поверит, что папка пуста, хотя полна).
      const reason = emptyReasonFor({
        isLoading: false,
        failed: false,
        hasFilter: filterQuery.trim() !== '',
        total: entries.length,
        shown: split.excluded > 0 ? 0 : list.length,
        excluded: split.excluded,
        isRoot: deps.workspace.ownerOf(dir)?.root === dir,
      });
      if (reason !== null) {
        rows.push({ kind: 'empty', dir, depth, reason, patterns: split.patterns });
      }

      // Исключённое показываем счётчиком в хвосте папки: файл на диске есть, и
      // молчать о нём значит врать перечнем. Только при раскрытой папке — у
      // свёрнутой нет «хвоста», а цифра без места выглядела бы обрывком.
      if (split.excluded > 0) {
        rows.push({ kind: 'excluded', dir, depth, count: split.excluded, patterns: split.patterns });
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

    // Монорепо: пакеты идут строками верхнего уровня, а промежуточные каталоги
    // (`packages`) скрыты — пакет это проект, а каталог лишь место на диске.
    const monorepo = options.groupByPackage && info.roots.length <= 1 && deps.packages?.isMonorepo === true;
    if (info.roots.length <= 1) {
      if (monorepo) {
        const packages = topLevelPackages(deps.packages?.all ?? []);
        const skip = new Set([...packageAncestorDirs(deps.packages?.all ?? []), ...packages.map((item) => item.path)]);
        const absolute = new Set([...skip].map((relative) => joinPath(info.root, relative)));
        for (const item of packages) {
          const dir = joinPath(info.root, item.path);
          rows.push({ kind: 'package', name: item.name, dir, relative: item.path, depth: 1 });
          if (expanded.has(dir)) pushDir(dir, 2);
        }
        pushDir(info.root, 0, absolute);
        return filtered(rows);
      }
      pushDir(info.root, 0);
      return filtered(rows);
    }
    for (const item of info.roots) {
      const active = item.root === info.root;
      const collapsed = collapsedRoots.has(item.root);
      rows.push({ kind: 'root', root: item, active, collapsed });
      if (!collapsed) pushDir(item.root, 2);
    }
    return filtered(rows);
  };

  /** Собрать узел строки. `null` — строка себя не показывает (её рисует поле ввода). */
  const buildRow = (row: FlatRow): HTMLElement | null => {
    if (row.kind === 'root') return rootRow(row.root, row.active, row.collapsed);
    if (row.kind === 'group') return groupRow(row.label, row.count, row.depth);
    if (row.kind === 'package') return packageRow(row.name, row.dir, row.relative);
    if (row.kind === 'loading') {
      return h('div', { class: 'tree-loading' }, failed.has(row.dir) ? 'Не удалось прочитать папку' : 'Читаю папку…');
    }
    if (row.kind === 'create') {
      const edit = inlineEdit;
      if (edit?.kind !== 'create') return null;
      return inlineInput(
        row.depth,
        '',
        (value) => void commitCreate(edit, value),
        (value) => checkNameIn(edit.parent, value),
      );
    }
    if (row.kind === 'excluded') return excludedRow(row.dir, row.depth, row.count, row.patterns);
    if (row.kind === 'empty') return emptyRow(row.dir, row.depth, row.reason, row.patterns);
    return renderRow(
      row.entry,
      row.depth,
      row.dir,
      {
        nested: row.nested,
        deleted: row.deleted,
        ...(row.chain ? { chain: row.chain } : {}),
      },
      // Номер строки в наборе: по нему дерево называет текущую строку читалке
      // (`aria-activedescendant`). `indexOf` — потому что `buildRow` получает уже
      // готовую строку, а номер нужен только тем строкам, что попадают в набор.
      flatRows.indexOf(row),
    );
  };

  /**
   * Пустое место: что случилось и что нажать.
   *
   * Действие берётся из текста состояния (`core/empty-state.ts`), а исполняется
   * здесь: `excluded-only` показывает папку на этот раз, остальные гоняют
   * команду. Так текст остаётся чистым, а знание о кнопках — в одном месте.
   */
  const emptyRow = (dir: string, depth: number, reason: EmptyReason, patterns: readonly string[]): HTMLElement => {
    const state = emptyState(reason, patterns);
    const action = state.action;
    const button =
      action === null
        ? null
        : h(
            'button',
            {
              class: 'tree-empty-action',
              type: 'button',
              onClick: () => {
                if (reason === 'excluded-only') {
                  peekExcluded.add(dir);
                  render();
                  return;
                }
                if (reason === 'filter-empty') {
                  clearFilter();
                  return;
                }
                if (action.command) void deps.commands.execute(action.command);
              },
            },
            action.label,
          );
    const row = h(
      'div',
      { class: 'tree-empty-state', style: { paddingLeft: `${12 + depth * options.indent}px` } },
      h('div', { class: 'tree-empty-title' }, state.title),
      h('div', { class: 'tree-empty-hint' }, state.hint),
      ...(button ? [button] : []),
    );
    return row;
  };

  /**
   * Хвост папки: «Ещё 3 исключено настройкой».
   *
   * Клик — показать один раз. Не переключатель в настройках: человек чаще хочет
   * ЗАГЛЯНУТЬ, чем менять правило навсегда, и одно нажатие не должно оставлять
   * след в чужом проекте. Маски перечислены прямо в подсказке — по ним читатель
   * найдёт в настройках то, что его прячет.
   */
  const excludedRow = (dir: string, depth: number, count: number, patterns: readonly string[]): HTMLElement => {
    const label = excludedLabel(count, plural);
    const note = patterns.length === 0 ? '' : ` (${patterns.join(', ')})`;
    const row = h(
      'div',
      {
        class: 'tree-excluded-note',
        title: `Скрыто настройкой explorer.exclude${note}. Щелчок покажет их на один раз.`,
        onClick: () => {
          // Один клик — папка показывает всех, кого прятала. Строка-счётчик после
          // этого исчезает сама: исключённых больше нет, и показывать нечего.
          peekExcluded.add(dir);
          render();
        },
      },
      h('span', { class: 'tree-excluded-label' }, label),
      ...(note ? [h('span', { class: 'tree-excluded-patterns' }, note)] : []),
    );
    row.style.paddingLeft = `${8 + depth * options.indent}px`;
    return row;
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
  /**
   * Липкая шапка: папки, внутри которых стоит первая видимая строка.
   *
   * Дерево виртуализировано — в монорепо папки над окном давно уехали за край, и
   * по одним файлам не понять, где ты. Шапка стоит над прокруткой (`position:
   * sticky`), поэтому видна всегда, но текст в ней меняется от прокрутки.
   *
   * Пересоздаём узлы только по факту смены пути (`breadcrumbChanged`): событие
   * `scroll` приходит десятки раз на секунду, а разметка на каждый кадр — это
   * работа ради ничего.
   */
  let crumbShown: Breadcrumb[] | null = null;
  const crumbsEl = h('div', { class: 'tree-crumbs', 'aria-hidden': 'true' });

  /** Строка списка в том виде, в каком её читает шапка. */
  const crumbRowOf = (row: FlatRow): { depth: number; name?: string; dir?: string } => {
    if (row.kind === 'entry') return { depth: row.depth, name: row.entry.name, dir: row.dir };
    if (row.kind === 'group') return { depth: row.depth, name: row.label };
    if (row.kind === 'package') return { depth: row.depth, name: row.name, dir: row.dir };
    if (row.kind === 'root') return { depth: 0, name: row.root.name, dir: row.root.root };
    if (row.kind === 'create') return { depth: row.depth, dir: row.parent };
    // Строка загрузки каталога: глубины у неё нет, и в шапку она не идёт.
    return { depth: 0 };
  };

  const renderCrumbs = (paintedFrom: number): void => {
    const index = paintedFrom;
    const root = deps.workspace.roots[0]?.root ?? '';
    // Строки кладём в вид, который понимает шапка: `name` есть не у всех (группа
    // `kind: 'group'` зовёт его `label`, загрузка имени не имеет вовсе), поэтому
    // берём имя отдельно, а не полагаемся на совпадение полей.
    // Пустой список — не «ничего не поменялось», а «показывать нечего»: на корне
    // проекта предков нет, и `[] === []` оставляло в шапке прежние куски.
    // Поэтому `null` и пустота различаются: первое — «ещё не рисовали».
    const next = ancestorsAt(flatRows.map(crumbRowOf), index, root);
    if (crumbShown !== null && !breadcrumbChanged(crumbShown, next)) return;
    crumbShown = next;
    crumbsEl.replaceChildren(
      ...next.map((crumb) => h('span', { class: 'tree-crumb', title: crumb.path }, crumb.label)),
    );
    // Шапка без кусков занимает место и ловит клики — убираем её с экрана целиком.
    crumbsEl.hidden = next.length === 0;
  };

  /** Строка набора, за которой стоит файл `path`: по ней строится имя для читалки. */
  const rowIsPath =
    (path: string) =>
    (row: FlatRow): boolean =>
      row.kind === 'entry' && row.entry.path === path;

  const renderWindow = (): void => {
    const host = rowsHost;
    const scroller = treeEl;
    if (!host || !scroller) return;
    // Таблицу мест считаем ЗДЕСЬ: строки рисуются из `flatRows`, и место строки
    // в наборе зависит от всего набора, а не от окна (`renderWindow` рисует лишь
    // видимую часть).
    ariaPlaces = ariaTable();

    const total = flatRows.length;
    const viewport = scroller.clientHeight;

    // Текущая строка меняется вместе с набором: назвать читалке строку, которой
    // уже нет (её свернули или отфильтровали), — хуже, чем не назвать никакой.
    const selectedIndex = selected === null ? -1 : flatRows.findIndex(rowIsPath(selected));
    scroller.setAttribute('aria-activedescendant', selectedIndex < 0 ? '' : treeRowId(selectedIndex));

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
    renderCrumbs(window.first);
  };

  /** Раскрыть или свернуть каталог строкой пакета (как обычной папкой дерева). */
  const toggleDir = (dir: string): void => {
    if (expanded.has(dir)) {
      setExpanded(dir, false);
      render();
      return;
    }
    setExpanded(dir, true);
    if (!children.has(dir)) void load(dir).then(render);
    render();
  };

  const onClick = async (entry: DirEntry, preview = false, side = false): Promise<void> => {
    // Ссылка ведёт себя как то, на что указывает: на папку — раскрывается, на файл —
    // открывается. Битую ссылку не читаем: цель не найдена, открывать нечего.
    if (entryIsDirectory(entry)) {
      if (expanded.has(entry.path)) {
        setExpanded(entry.path, false);
        render();
        return;
      }
      setExpanded(entry.path, true);
      if (!children.has(entry.path)) await load(entry.path);
      revealChildrenOf = entry.path;
      render();
      return;
    }
    if (entryIsSymlink(entry) && (entry.symlink === undefined || entry.symlink.broken)) return;
    // `Ctrl+Enter` — в соседнюю панель: сначала делим, потом открываем, чтобы файл
    // ушёл уже в правую половину (так же делает выбор символа, `ui/symbol-picker.ts`).
    if (side) deps.splitEditor?.();
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

  /**
   * Заголовок полки при группировке по назначению («Тесты», «Стили»). Только подпись
   * и число: строка не выбирается, не перетаскивается и в порядок выделения не идёт.
   * Высоту держит ту же, что у строки, — иначе поехало бы окно виртуализации.
   */
  const groupRow = (label: string, count: number, depth: number): HTMLElement => {
    const row = h(
      'div',
      { class: 'tree-group', style: { paddingLeft: `${8 + depth * options.indent}px` } },
      h('span', { class: 'tree-group-label' }, label),
      h('span', { class: 'tree-group-count' }, String(count)),
    );
    row.setAttribute('aria-hidden', 'true');
    return row;
  };

  /**
   * Строка пакета монорепо: имя проекта, путь от корня и раскрытие. Место на диске
   * показано подписью — из строки не видно, где пакет лежит (промежуточный каталог скрыт).
   */
  const packageRow = (name: string, dir: string, relative: string): HTMLElement => {
    const isOpen = expanded.has(dir);
    const row = h(
      'button',
      {
        class: `tree-row is-package${isOpen ? ' is-open' : ''}`,
        type: 'button',
        title: `${relative} — пакет проекта`,
        dataset: { path: dir },
      },
      h('span', { class: `tree-twisty${isOpen ? ' is-open' : ''}` }, svgIcon('chevron', 12)),
      options.icons ? folderIcon(name, isOpen) : svgIcon('folder', 15),
      h('span', { class: 'tree-name' }, name),
      h('span', { class: 'tree-package-path' }, relative),
    );
    row.addEventListener('click', () => toggleDir(dir));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu([{ label: 'Показать в дереве', onSelect: () => reveal(dir) }], event.clientX, event.clientY);
    });
    return row;
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
          { label: 'Настройки папки…', onSelect: () => void deps.commands.execute('explorer.rootSettings', item.root) },
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
            'Открыть проект',
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
        {
          class: 'panel-header',
        },
        // Проект в этой шапке не показан: его имя и переключение живут в шапке
        // окна (см. ui/project-select.ts) — переключать проект нужно и с закрытым
        // проводником.
        // Поле фильтра живёт в шапке, а не отдельной строкой: дерево начинается
        // сразу под шапкой, и лишняя строка съедала бы высоту списка.
        h('input', {
          class: 'field-input tree-filter',
          type: 'search',
          placeholder: 'Фильтр: имя, *шаблон, слова через пробел',
          title: 'Фильтр по дереву (Ctrl+F): имя, *любой хвост, ?один символ, слова через пробел',
          value: filterQuery,
          onInput: (event: Event) => {
            const next = (event.target as HTMLInputElement).value;
            if (next === filterQuery) return;
            filterQuery = next;
            // Перерисовываем только список: заголовок и закреплённые строки от
            // запроса не зависят, а их пересборка на каждый символ заметна.
            flatRows = buildFlat(info);
            visibleNow = [];
            for (const row of flatRows) {
              if (row.kind === 'entry' && !row.deleted) visibleNow.push(row.entry.path);
            }
            host.replaceChildren();
            renderWindow();
          },
          onKeydown: (event: Event) => {
            if ((event as KeyboardEvent).key === 'Escape') {
              event.stopPropagation();
              clearFilter();
            }
          },
        }),
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
              // Кнопка — режим, а не действие: вид вкл/выкл задаёт is-active, а не
              // другой класс. Подписи нет — в шапке 25-px квадраты, поэтому
              // состояние говорит title и aria-pressed (для читалки).
              class: onlyChanged ? 'icon-btn is-active tree-only-changed' : 'icon-btn tree-only-changed',
              type: 'button',
              title: onlyChanged ? 'Показать все файлы' : 'Показать только изменённые (git)',
              'aria-pressed': onlyChanged ? 'true' : 'false',
              onClick: () => toggleOnlyChanged(),
            },
            svgIcon('eye', 15),
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
    const tree = h('div', {
      class: 'tree',
      tabindex: '-1',
      role: 'tree',
      'aria-label': 'Файлы проекта',
      // Какая строка текущая — называет САМО дерево: фокус живёт здесь, а строки
      // пересоздаются на каждую отрисовку. Пусто — ни одна строка не выбрана.
      'aria-activedescendant': '',
    });
    // Ссылку на поле фильтра берём после сборки: `h` не умеет `ref`.
    filterInput = element.querySelector<HTMLInputElement>('.tree-filter');
    treeEl = tree;
    const host = h('div', { class: 'tree-rows', role: 'group' });
    rowsHost = host;
    // Избранное — выше закреплённых: это постоянный список, к нему возвращаются чаще.
    if (favorites.length > 0) tree.appendChild(favoritesBlock());
    // Удалённые папки — над локальным деревом: они о рабочем месте, а не о проекте.
    if ((deps.remoteRoots?.() ?? []).length > 0) tree.appendChild(remoteBlock());
    if (pinned.length > 0) tree.appendChild(pinnedBlock());
    // Шапка — перед строками и внутри прокрутки: sticky работает только от
    // прокручиваемого предка, а вне его она уехала бы вместе с содержимым.
    tree.appendChild(crumbsEl);
    tree.appendChild(host);
    tree.addEventListener('contextmenu', (event) => openMenu(null, event));
    tree.addEventListener('keydown', (event) => onTreeKey(event));
    // Фокус входа/выхода — событие по самому дереву: строки пересоздаются, а оно
    // живёт постоянно. Перерисовка нужна только для того, чтобы побледнеть или
    // снова загореться.
    const onFocusChange = (): void => {
      const next = document.activeElement === tree;
      if (next === treeFocused) return;
      treeFocused = next;
      // Окно забыло прежний набор, а окно то же:
      visibleNow = [];
      renderWindow();
    };
    tree.addEventListener('focusin', onFocusChange);
    tree.addEventListener('focusout', onFocusChange);
    // Прокрутили — рисуем другое окно строк. Полную перерисовку не делаем: иначе
    // на каждой прокрутке пересобирались бы заголовок панели и закреплённые строки.
    tree.addEventListener('scroll', () => {
      savedScroll = tree.scrollTop;
      renderWindow();
      deps.onScrollChange?.();
    });
    // Высоту панели меняют окно, нижний док и переключатели панелей — а окно строк
    // считают по ВЫСОТЕ в момент отрисовки (см. `renderWindow`). Без пересчёта окно,
    // посчитанное при маленькой или НУЛЕВОЙ высоте (раскладка в тот момент ещё не
    // встала, и `clientHeight` равен нулю), таким и оставалось бы: строк видно мало,
    // а ниже — пустота на всю панель. Высота сравнивается с прошлой: иначе замена
    // строк в `renderWindow` зациклила бы наблюдателя.
    // Высоту панели меняют окно, нижний док и переключатели панелей — а окно строк
    // считают по ВЫСОТЕ (см. `renderWindow`). Переводим на этот узел единственный
    // наблюдатель: свой на каждую отрисовку оставил бы прежний следить за уже
    // отброшенным узлом (высота ноль) — и тот пересобирал бы строки зря, гася
    // открытое поле ввода имени (см. `syncViewport`).
    treeResize.disconnect();
    treeResize.observe(tree);
    // Сброс мимо строк — в корень области: так файл уезжает «наверх», к проекту.
    tree.addEventListener('dragover', (event) => {
      const root = deps.workspace.root;
      if (!root || event.target !== tree) return;
      if (dragging.length === 0) {
        // Извне — в корень области, как и свои строки.
        const types = [...(event.dataTransfer?.types ?? [])];
        if (!dropVerdict((event.dataTransfer?.files.length ?? 0) > 0, types).accept) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = copyDrag(event) ? 'copy' : 'move';
        return;
      }
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
      if (moving.length === 0) {
        void acceptExternal(event, root, true);
        return;
      }
      if (movePlan(moving, root).length > 0) {
        void deps.commands.execute(copyDrag(event) ? 'file.copyInto' : 'file.moveInto', moving, root);
      }
    });
    element.appendChild(tree);

    // Плоский список видимых строк: по нему считаем окно и обходим выделение.
    flatRows = buildFlat(info);
    // `paint` пересоздаёт строки, а `renderWindow` рисует только при смене
    // диапазона в `visibleNow`. При перерисовке без пересборки дерева (фокус,
    // пометки git) строки уже новые, а `visibleNow` помнит старые — и окно не
    // перерисуется, если у них совпал диапазон. Сбрасываем: соберём заново.
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
    // Перечитываем все корни области, а не только активный: в дереве видны они все,
    // и создание/переименование в папке соседнего корня рисовалось бы иначе без
    // прочитанного родителя (строка «Читаю папку…» вместо поля имени).
    const dirs = [...info.roots.map((item) => item.root), ...[...expanded].filter((dir) => children.has(dir))];
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

  /** Набранное для прыжка к строке; сбрасывается паузой (`core/tree-typeahead.ts`). */
  let typeahead = EMPTY_TYPEAHEAD;

  /** Клавиши хода по дереву: те, что разбирает `core/tree-walk.ts`. */
  const WALK_KEYS: ReadonlySet<string> = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Enter',
    'Star',
  ]);

  /** Клавиши строки: без выделения им нечего делать, поэтому в ход не идут. */
  const SELECTION_KEYS: ReadonlySet<string> = new Set(['Space', 'F2', 'Delete', 'ContextMenu']);

  /**
   * Видимые строки с тем, что нужно для хода: глубина (по ней ищется родитель)
   * и раскрыт ли каталог. `loading`/`deleted` в ход не входят — это не строки
   * файлов, и стрелка не должна на них застревать.
   */
  const walkRows = (): WalkRow[] => {
    const rows: WalkRow[] = [];
    for (const row of flatRows) {
      if (row.kind !== 'entry' || row.deleted) continue;
      const directory = entryIsDirectory(row.entry);
      rows.push({
        path: row.entry.path,
        depth: row.depth,
        directory,
        expanded: directory && expanded.has(row.entry.path),
      });
    }
    return rows;
  };

  /**
   * Место строки в наборе для читалки. Считается по ВИДИМОМУ дереву на кадр и
   * запоминается: у строки спрашивают трижды за отрисовку, а собрать таблицу
   * на весь набор — один проход.
   */
  const ariaTable = (): Map<string, AriaPosition> =>
    ariaPositions(
      flatRows.flatMap((row) =>
        row.kind === 'entry' && !row.deleted ? [{ path: row.entry.path, depth: row.depth }] : [],
      ),
    );
  let ariaPlaces = new Map<string, AriaPosition>();
  const ariaPlace = (path: string): AriaPosition => ariaPlaces.get(path) ?? { level: 1, posInSet: 1, setSize: 1 };

  /**
   * Режим «только изменённые». Переключается полной перерисовкой (`render`), а не
   * `renderWindow`: `buildFlat` перебирает только раскрытые папки из `children` и
   * зовёт `visibleSplit` тогда же — строки получаются ДРУГИЕ, а не те же с другим
   * классом, и окном их не пересобрать.
   * Кэш прочитанных папок при этом цел: фильтр читается в момент сборки списка,
   * а не при чтении папки — с диска ничего не перечитывается.
   * Выделение снимаем: спрятанная режимом строка осталась бы выделенной невидимо.
   */
  const toggleOnlyChanged = (): void => {
    onlyChanged = !onlyChanged;
    if (onlyChanged) selection = EMPTY_SELECTION;
    render();
  };

  const applyWalk = (action: WalkAction, event?: KeyboardEvent): void => {
    switch (action.kind) {
      case 'move': {
        selected = action.path;
        selection = { paths: [action.path], anchor: action.path };
        revealTarget = action.path;
        render();
        // Прокрутку заказываем номером строки: если она вне окна, в DOM её ещё нет,
        // и `querySelector` вернул бы пусто (`reveal` делает так же).
        element
          .querySelector<HTMLElement>(`[data-path="${CSS.escape(action.path)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
        return;
      }
      case 'expand':
        if (!expanded.has(action.path)) toggleDir(action.path);
        return;
      case 'toggle':
        // `Enter` на папке — поведение раскрытия/сворачивания, как в списках
        // JetBrains и Zed. Повторный `Enter` закрывает: человек не ищет
        // отдельную клавишу, чтобы спрятать ветку обратно.
        toggleDir(action.path);
        return;
      case 'collapse':
        if (expanded.has(action.path)) toggleDir(action.path);
        return;
      case 'open': {
        const entry = [...children.values()].flat().find((item) => item.path === action.path);
        // Модификатор читается здесь, а не в `tree-walk`: раскладка клавиш — забота
        // вида, а правило «куда ведёт открытие» — забота дерева.
        const side = Boolean(event && (event.ctrlKey || event.metaKey));
        if (entry) void onClick(entry, false, side);
        return;
      }
      case 'peek': {
        // Пробел — посмотреть, не открывая вкладку. Ветку не раскрывает:
        // «глазом» смотрят, не трогая дерево. На выделении смотрим всё выделенное:
        // так же, как это уже делает `Space` в обработчике клавиш.
        const paths = peekablePaths();
        const target = paths.includes(action.path) ? paths : [action.path];
        deps.peekFiles?.(target, peekAnchor(target[0]!, event));
        return;
      }
      case 'rename':
        startRename(action.path);
        return;
      case 'delete':
        // Выделено несколько — удаляем выделенное, а не одну строку под
        // клавишей: `Delete` после выделения мышью адресуется выделению.
        deleteTargets(selection.paths.length > 1 ? selection.paths : action.paths);
        return;
      case 'menu': {
        // Меню — то же, что правый щелчок по строке: через тот же `openMenu`,
        // чтобы пункты не разъехались с мышиными.
        const row = element.querySelector<HTMLElement>(`[data-path="${CSS.escape(action.path)}"]`);
        if (!row) return;
        const box = row.getBoundingClientRect();
        openMenu(findEntry(action.path) ?? null, {
          preventDefault: () => {},
          stopPropagation: () => {},
          clientX: box.left + 12,
          clientY: box.top + box.height,
        } as unknown as MouseEvent);
        return;
      }
      case 'expandAll':
        // Всем папкам на одном уровне с текущей — раскрыться («*» по APG).
        for (const path of action.paths) if (!expanded.has(path)) setExpanded(path, true);
        render();
        return;
    }
  };

  const reveal = (target: string): void => {
    const info = deps.workspace.current;
    if (!info || !isInsidePath(info.root, target)) return;

    // Раскрываем папки пути по очереди: сегменты режем по обоим разделителям,
    // а собираем обратно тем, что у корня (путь уходит дальше в main).
    const segments = splitPath(pathAfter(info.root, target));
    segments.pop();
    let current = info.root;
    // Есть ли среди папок пути непрочитанная: тогда строка появится только
    // ПОСЛЕ ответа main. Раньше просьба о прокрутке ставилась до этой загрузки —
    // первая перерисовка искала строку, не находила её и просьбу НЕ снимала,
    // но `scrollIntoView` ниже уже ничего не мог, а `render` из `.then` просьбу
    // не уточнял. Открытый из поиска файл в свёрнутой ветке подсвечивался, но
    // оставался за краем экрана.
    let loading = false;
    for (const segment of segments) {
      current = joinPath(current, segment);
      expanded.add(current);
      if (!children.has(current)) {
        loading = true;
        void load(current).then(render);
      }
    }
    selected = target;
    selection = { paths: [target], anchor: target };
    // Прокрутку заказываем номером строки: если она вне окна, в DOM её ещё нет.
    revealTarget = target;
    render();
    // Строка уже нарисована — прокручиваем сразу. Папки ещё читаются — прокрутку
    // доведёт та перерисовка (`revealTarget` живёт до первой удачной).
    if (!loading) {
      element.querySelector<HTMLElement>(`[data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  /**
   * Раскрыть папку без клика (публичный `expand`).
   *
   * Родители раскрываются — как в `reveal`, — но свою папку `reveal` бы ещё и
   * ВЫДЕЛИЛ. А выделенная папка при следующем клике норовит переключиться, да и
   * само выделение шло через тот же путь: у пробы выходило «раскрыл — и тут же
   * свернулось». Здесь ровно раскрытие: набор, догрузка, перерисовка.
   */
  const expandPublic = (path: string): void => {
    const root = deps.workspace.root;
    if (!root) return;
    const relativePath = deps.workspace.relative(path);
    if (!relativePath || relativePath.startsWith('..')) return;
    let current = root;
    let loading = false;
    for (const segment of relativePath.split('/').filter(Boolean)) {
      current = joinPath(current, segment);
      expanded.add(current);
      if (!children.has(current)) {
        loading = true;
        void load(current).then(render);
      }
    }
    deps.onExpandedChange?.();
    // Папки ещё читаются — их ответ перерисует сам (`load(...).then(render)`).
    if (!loading) render();
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
  /**
   * Автораскрытие: сменилась активная вкладка — дерево само уводит к её файлу.
   *
   * Реагируем именно на СМЕНУ пути, а не на каждое событие: `onDidChange` зовётся
   * и при смене «грязности» или порядка вкладок, и `reveal` на каждое такое событие
   * раскрывал бы папки против воли человека.
   */
  let lastActivePath: string | null = deps.openEditors.active?.path ?? null;
  deps.openEditors.onDidChange(() => {
    const path = deps.openEditors.active?.path ?? null;
    if (path === lastActivePath) return;
    lastActivePath = path;
    if (!path) return;
    if (deps.autoReveal && !deps.autoReveal()) return;
    // Файл вне проекта (`reveal` сам молча выйдет): проверяем заранее, чтобы не дёргать
    // загрузку папок зря.
    reveal(path);
  });
  // Список пакетов перечитали (появился манифест) — строки пакетов могли измениться.
  deps.packages?.onDidChange(render);
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
    // Внутри дерева фокус живёт на самом контейнере (`tabindex=-1`), а строку
    // выбирает изнутри `aria-activedescendant`: строки пересоздаются каждый
    // paint, и держать фокус на них — значит терять его на каждой перерисовке.
    focus() {
      if (!selected && flatRows.length > 0) {
        const first = flatRows.find((row) => row.kind === 'entry' && !row.deleted);
        if (first && first.kind === 'entry') {
          selected = first.entry.path;
          selection = { paths: [selected], anchor: selected };
          render();
        }
      }
      treeEl?.focus();
    },
    render,
    scheduleRefresh,
    reveal,
    expand: expandPublic,
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
    // `treeEl` — прокручиваемый узел; он пересоздаётся отрисовкой, потому берём его в момент зова.
    scrollTop: () => treeEl?.scrollTop ?? savedScroll,
    /**
     * Прокрутка прошлой сессии. Дерево к этому времени может быть выше прежнего
     * (файлы добавились) или ниже (папки исчезли) — браузер сам обрежет лишнее,
     * поэтому дальше проверки на разумность не идём.
     */
    restoreScroll(top) {
      if (!Number.isFinite(top) || top <= 0) return;
      savedScroll = top;
      if (treeEl) treeEl.scrollTop = top;
    },
    pinnedPaths: () => [...pinned],
    restorePinned(paths) {
      // Чужие пути (из другого проекта) отбрасываем: открывать по ним нечего.
      pinned = normalizePins(paths, deps.workspace.root);
      render();
    },
    togglePin: setPinned,
    toggleOnlyChanged,
    isOnlyChanged: () => onlyChanged,
    /** Скрытые — только в слое дерева: настройку пишет команда `explorer.toggleHidden`. */
    toggleHidden() {
      options = { ...options, showHidden: !options.showHidden };
      render();
    },
    favorites: () => [...favorites],
    setFavorites(paths) {
      // Чужие и повторные пути отбрасываем тем же разбором, что у модели списка.
      favorites = normalizeFavorites(paths);
      render();
    },
    toggleFavorite: setFavorite,
    labels: () => [...labels],
    restoreLabels(records) {
      // Чужие пути и неизвестные цвета отбрасываем: рисовать по ним нечего.
      labels = sanitizeLabels(records, deps.workspace.root);
      render();
    },
    setFileLabel,
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
      peekExcluded.clear();
      render();
    },
  };
}

/**
 * Совпадение имени с шаблоном из настроек: `*.min.js`, `dist`, `generated/*`.
 * Полноценный glob тут не нужен — шаблоны задаёт человек руками, поэтому
 * поддерживаем `*`, `?` и `**` и сверяем и имя, и путь от корня проекта.
 *
 * Маску собираем ОДИН раз на набор, а не на каждую строку папки: в каталоге на
 * несколько тысяч файлов с тремя шаблонами это тысячи `new RegExp` на каждое
 * чтение папки. Ключ кеша — сам массив шаблонов из настроек: поменяется он —
 * пересоберём.
 */
let matcherCache: { patterns: readonly string[]; regexps: RegExp[] } | null = null;

function excludeMatchers(patterns: readonly string[]): RegExp[] {
  if (matcherCache?.patterns === patterns) return matcherCache.regexps;
  const regexps = patterns.map((pattern) => maskToRegExp(pattern));
  matcherCache = { patterns, regexps };
  return regexps;
}

function matchesExclude(name: string, relative: string, patterns: readonly string[]): boolean {
  for (const regexp of excludeMatchers(patterns)) {
    if (regexp.test(name) || regexp.test(relative)) return true;
  }
  return false;
}

/* Имя и родителя пути считает shared/paths: разделитель там берётся из пути. */

/** Есть ли активное создание внутри указанной папки. */
function isCreateTarget(edit: InlineEdit | null, path: string): edit is Extract<InlineEdit, { kind: 'create' }> {
  return edit?.kind === 'create' && edit.parent === path;
}
