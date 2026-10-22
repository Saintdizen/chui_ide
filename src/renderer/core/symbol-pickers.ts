import { classMembers } from '../editor/complete/member-access';
import { declarationOf, enclosingClassAt, overrideSnippet, paramsOf } from '../editor/complete/override';
import { toOffset } from '../../shared/edits';
import { fetchCallHierarchy, type CallDirection } from './call-hierarchy';
import { fetchTypeHierarchy, type TypeDirection } from './type-hierarchy';
import type { DefineCommand } from './command-args';
import type { EditorWorkspace } from '../editor/host/editor-workspace';
import type { LspFeatures } from '../editor/host/lsp-features';
import type { RpcClient } from './rpc';
import type { WorkspaceModel } from './workspace-model';
import type { Layout } from '../ui/layout';
import type { MeaningSearchView } from '../ui/meaning-search';
import { showPopupMenu } from '../ui/popup-menu';
import { showToast } from '../ui/toast';

/**
 * Списки, которые модель открывает поверх редактора: иерархия вызовов и типов,
 * экспорты модуля, наследование, члены типа, места объявления, переопределения.
 *
 * Все они устроены одинаково: спросить у сервера (или у своего индекса) набор
 * строк, показать попапом, по выбору — перейти. Поэтому переход (`openPath`) и
 * «показать попап» приходят снаружи, а не берутся из `app.ts` напрямую.
 */
export interface SymbolPickersDeps {
  define: DefineCommand;
  lsp: LspFeatures;
  editors: EditorWorkspace;
  workspace: WorkspaceModel;
  rpc: RpcClient;
  layout: Layout;
  /** Открыть файл (и поставить курсор на нужную позицию). */
  openPath(path: string, options?: { preview?: boolean }): Promise<void>;
  /** Поиск по смыслу (агентный) — свой список поверх редактора. */
  meaningSearch: MeaningSearchView;
  /** Пересобрать индекс символов в фоне. */
  refreshSymbolIndex(): void;
}

export function createSymbolPickers(deps: SymbolPickersDeps) {
  const { define, lsp, editors, workspace, rpc, layout, openPath } = deps;
  const { meaningSearch, refreshSymbolIndex } = deps;

  /** Подпись вида экспорта для списка мест: коротко и по-русски. */
  function exportKindLabel(kind: string): string {
    if (kind === 'default') return 'по умолчанию';
    if (kind === 'star') return 'звёздочкой';
    if (kind === 'named') return 'списком';
    return 'объявлением';
  }

  /** Подпись объявления типа для списка: вид и его прямые родители. */
  function describeType(entry: { kind: string; bases: string[] }): string {
    if (entry.bases.length === 0) return entry.kind;
    return `${entry.kind} · ${entry.bases.join(', ')}`;
  }

  /**
   * Иерархия вызовов символа: кто его вызывает или кого вызывает он. Показываем
   * списком — тем же попапом, что и прочие переходы.
   */
  const openCallHierarchy = async (direction: CallDirection): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const position = editors.cursor();
    const result = await fetchCallHierarchy(rpc, path, position, direction).catch(() => null);
    if (!result) {
      showToast('Сервер символов не отвечает: нужен языковой сервер для этого языка', 'error');
      return;
    }
    if (result.calls.length === 0) {
      showToast(
        direction === 'incoming'
          ? `Никто не вызывает ${result.symbol.name}`
          : `${result.symbol.name} ничего не вызывает`,
      );
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    const heading = direction === 'incoming' ? `Вызывают ${result.symbol.name}` : `${result.symbol.name} вызывает`;
    showPopupMenu(
      result.calls.map((target) => ({
        label: target.name,
        hint: `${workspace.relative(target.path)}:${target.line}`,
        onSelect: () => void openPath(target.path).then(() => editors.reveal(target.path, target.line, target.column)),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    showToast(`${heading}: ${result.calls.length}`);
  };

  define(
    { id: 'editor.callers', title: 'Кто вызывает символ', category: 'Навигация' },
    () => void openCallHierarchy('incoming'),
  );
  define(
    { id: 'editor.callees', title: 'Кого вызывает символ', category: 'Навигация' },
    () => void openCallHierarchy('outgoing'),
  );

  /**
   * Иерархия типов символа: от кого наследует и кто наследует от него. Показываем
   * тем же списком, что вызовы: своего дерева у нас нет, а список читается и так.
   */
  const openTypeHierarchy = async (direction: TypeDirection): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const position = editors.cursor();
    const result = await fetchTypeHierarchy(rpc, path, position, direction).catch(() => null);
    if (!result) {
      showToast('Сервер символов не отвечает: нужен языковой сервер для этого языка', 'error');
      return;
    }
    if (result.types.length === 0) {
      showToast(
        direction === 'supertypes'
          ? `У ${result.symbol.name} нет надтипов`
          : `От ${result.symbol.name} никто не наследует`,
      );
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.types.map((target) => ({
        label: target.name,
        hint: target.detail ?? `${workspace.relative(target.path)}:${target.line}`,
        onSelect: () => void openPath(target.path).then(() => editors.reveal(target.path, target.line, target.column)),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    const heading = direction === 'supertypes' ? `Надтипы ${result.symbol.name}` : `Подтипы ${result.symbol.name}`;
    showToast(`${heading}: ${result.types.length}`);
  };

  define(
    { id: 'editor.supertypes', title: 'Иерархия типов: надтипы', category: 'Навигация' },
    () => void openTypeHierarchy('supertypes'),
  );
  define(
    { id: 'editor.subtypes', title: 'Иерархия типов: подтипы', category: 'Навигация' },
    () => void openTypeHierarchy('subtypes'),
  );

  /**
   * Где имя экспортируется: по имени под кареткой обходим проект и показываем файлы, где
   * оно объявлено экспортом. Список — тем же попапом, что и ссылки: у нас нет ни языкового
   * сервера в этом месте (в LSP такого запроса нет), ни дерева разбора — только разбор
   * строк по языку (`shared/symbol-exports.ts`).
   */
  const openFindExports = async (): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    // Имя — из выделения, а если выделения нет, из слова под кареткой.
    const name = editors.selectedText().trim() || editors.wordAtCursor() || '';
    if (!name) {
      showToast('Поставьте курсор на имя', 'info');
      return;
    }

    const result = await rpc.request('workspace.findExports', { name }).catch(() => null);
    if (!result) {
      showToast('Не удалось искать по проекту', 'error');
      return;
    }
    if (result.total === 0) {
      showToast(`${name}: экспортов не найдено`);
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.files.flatMap((file) =>
        file.entries.map((entry) => ({
          label: `${workspace.relative(file.path)}:${entry.line}`,
          hint: exportKindLabel(entry.kind),
          onSelect: () => void openPath(file.path).then(() => editors.reveal(file.path, entry.line, 1)),
        })),
      ),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    showToast(`Экспортов ${name}: ${result.total}`);
  };

  define(
    { id: 'search.findExports', title: 'Где экспортируется', category: 'Поиск', keywords: ['export', 'экспорт'] },
    () => void openFindExports(),
  );

  define(
    {
      id: 'search.meaning',
      title: 'Поиск по смыслу',
      category: 'Поиск',
      keybinding: 'Ctrl+Shift+M',
      keywords: ['смысл', 'словами', 'meaning', 'semantic'],
    },
    () => meaningSearch.open(),
  );

  /**
   * Наследование имени под кареткой по проекту: кто наследует (subtypes) или от кого
   * наследует (supertypes). Тем же списком, что экспорты: свой разбор строк, без сервера
   * (иерархию типов сервер показывает лишь для символа под курсором).
   */
  const openInheritance = async (direction: 'subtypes' | 'supertypes'): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const name = editors.selectedText().trim() || editors.wordAtCursor() || '';
    if (!name) {
      showToast('Поставьте курсор на имя типа', 'info');
      return;
    }

    const result = await rpc.request('workspace.findInheritance', { name, direction }).catch(() => null);
    if (!result) {
      showToast('Не удалось искать по проекту', 'error');
      return;
    }
    const empty = direction === 'subtypes' ? `${name}: наследников не найдено` : `${name}: объявлений не найдено`;
    if (result.total === 0) {
      showToast(empty);
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.files.flatMap((file) =>
        file.entries.map((entry) => ({
          label: `${workspace.relative(file.path)}:${entry.line}`,
          hint: describeType(entry),
          onSelect: () => void openPath(file.path).then(() => editors.reveal(file.path, entry.line, 1)),
        })),
      ),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    showToast(direction === 'subtypes' ? `Наследуют ${name}: ${result.total}` : `${name}: ${result.total}`);
  };

  define(
    { id: 'search.findSubtypes', title: 'Кто наследует тип', category: 'Поиск', keywords: ['наслед', 'subclass'] },
    () => void openInheritance('subtypes'),
  );
  define(
    {
      id: 'search.findSupertypes',
      title: 'От кого наследует тип',
      category: 'Поиск',
      keywords: ['родител', 'superclass'],
    },
    () => void openInheritance('supertypes'),
  );

  /**
   * Что тип умеет: свои методы и поля вместе с унаследованными.
   *
   * Отличие от «кто наследует» выше: там ищут наследников в тексте проекта, а здесь —
   * сам список членов типа с указанием, кто из предков их дал. Считается по карте
   * символов (`index.inherited`), поэтому отвечает без языкового сервера и сразу, а
   * `phase` говорит, стоит ли переспросить пока карта собирается.
   */
  const openTypeMembers = async (): Promise<void> => {
    if (!editors.currentPath) {
      showToast('Откройте файл', 'error');
      return;
    }
    const name = editors.selectedText().trim() || editors.wordAtCursor() || '';
    if (!name) {
      showToast('Поставьте курсор на имя типа', 'info');
      return;
    }

    const result = await rpc.request('index.inherited', { name }).catch(() => null);
    if (!result) {
      showToast('Не удалось спросить карту символов', 'error');
      return;
    }
    if (result.members.length === 0) {
      // Пустой ответ при собирающейся карте — это «ещё не знаю», а не «нет такого».
      showToast(
        result.phase === 'warming'
          ? `${name}: карта символов ещё собирается — повторите через минуту`
          : `${name}: членов не найдено`,
      );
      return;
    }

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      result.members.map((member) => ({
        label: `${member.kind} ${member.name}`,
        // От кого метод: своё объявление — сам тип, унаследованное — предок.
        hint: member.from === name ? 'свой' : `от ${member.from}`,
        onSelect: () => void openPath(member.path).then(() => editors.reveal(member.path, member.line, 1)),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    const inherited = result.members.filter((member) => member.from !== name).length;
    showToast(`${name}: ${result.members.length}, из них унаследовано ${inherited}`);
  };

  define(
    {
      id: 'search.typeMembers',
      title: 'Что умеет тип: свои и унаследованные члены',
      category: 'Навигация',
      keywords: ['методы', 'members', 'унаследованные'],
    },
    () => void openTypeMembers(),
  );

  /**
   * Пересобрать карту символов — аналог «Invalidate Caches / Restart» в больших IDE,
   * только без перезапуска.
   *
   * Нужно, когда карта разошлась с кодом по причине, которую мы не увидели: правка
   * мимо рабочей папки, откат ветки внешним инструментом, чужой `git` в терминале.
   * Обход дешёвый — не изменившиеся файлы берутся из кэша, — поэтому звать можно
   * сколько угодно. Пока идёт сборка, за ней снова следит виджет в полосе состояния.
   */
  const rebuildSymbolIndex = async (): Promise<void> => {
    try {
      const status = await rpc.request('index.rebuild');
      showToast(
        status.phase === 'warming'
          ? `Пересобираю карту символов: ${status.files} файлов в ней`
          : `Карта символов пересобрана: ${status.files} файлов, ${status.decls} объявлений`,
      );
      refreshSymbolIndex();
    } catch {
      showToast('Не удалось пересобрать карту символов', 'error');
    }
  };

  /**
   * Переопределить методы предка: выбрать из списка и получить заготовку.
   *
   * Наследование уже разобрано картой символов (`index.inherited`), поэтому искать
   * предков не нужно: карта знает и цепочку, и членов каждого предка. Открываем её,
   * убираем то, что в этом классе уже объявлено, и на выбранное имя вставляем
   * заготовку — с параметрами предка и вызовом `super`: самое частое, что пишут при
   * переопределении, а забыть его значит получить метод, который молча ничего не делает.
   */
  const overrideMembers = async (): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const text = editors.currentText(path) ?? '';
    const position = editors.cursor();
    const owner = enclosingClassAt(text, toOffset(text, position.line, position.column));
    if (!owner) {
      showToast('Поставьте курсор внутрь класса', 'info');
      return;
    }

    const result = await rpc.request('index.inherited', { name: owner.name }).catch(() => null);
    if (!result) {
      showToast('Не удалось спросить карту символов', 'error');
      return;
    }
    // Своё уже объявлено — переопределять нечего: берём только унаследованное.
    const own = new Set(classMembers(text, 'self').map((member) => member.name));
    const candidates = result.members.filter((member) => member.from !== owner.name && !own.has(member.name));
    if (candidates.length === 0) {
      showToast(
        result.phase === 'warming'
          ? `${owner.name}: карта символов ещё собирается — повторите через минуту`
          : `${owner.name}: переопределять нечего — предков с методами не нашлось`,
      );
      return;
    }

    /** Взять заготовку из предка и вставить её в конец тела класса. */
    const insertOverride = async (name: string, origin: string): Promise<void> => {
      // Параметры — из строки объявления в файле предка: карта хранит только номер
      // строки, а сигнатура нужна целиком (типы, значения по умолчанию).
      const source = await rpc.request('workspace.readFile', { path: origin }).catch(() => null);
      const declaration = source ? declarationOf(source.text, name) : null;
      const params = declaration ? paramsOf(declaration) : '';
      const snippet = overrideSnippet({
        language: owner.language,
        name,
        params,
        // Отступ члена — на ступень глубже класса: у Python четыре пробела, у JS два.
        indent: owner.indent + (owner.language === 'python' ? 4 : 2),
      });

      // Вставляем в конец тела класса, а не в каретку: она могла стоять где угодно
      // внутри класса, а новый метод должен встать рядом с остальными.
      const lines = (editors.currentText(path) ?? text).split('\n');
      const endColumn = (lines[owner.endLine - 1]?.length ?? 0) + 1;
      editors.reveal(path, owner.endLine, endColumn);
      editors.insertAtCursor(snippet);
      showToast(`Переопределён ${name}`);
    };

    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      candidates.map((member) => ({
        label: `${member.kind} ${member.name}`,
        // Одноимённый метод бывает у нескольких предков — важно знать, чей это.
        hint: `от ${member.from}`,
        onSelect: () => void insertOverride(member.name, member.path),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
  };

  define(
    {
      id: 'editor.overrideMembers',
      title: 'Переопределить методы предка',
      category: 'Навигация',
      keywords: ['override', 'переопределить', 'наслед', 'super'],
    },
    () => void overrideMembers(),
  );

  define(
    {
      id: 'index.rebuild',
      title: 'Пересобрать карту символов',
      category: 'Навигация',
      keywords: ['индекс', 'index', 'кэш', 'пересобрать', 'invalidate'],
    },
    () => void rebuildSymbolIndex(),
  );

  /**
   * Моникер символа под курсором: устойчивое имя, по которому символ связывается с тем же
   * символом в других инструментах. Показываем список (схем бывает несколько), а первый
   * сразу копируем в буфер — чаще всего его и нужно вставить в другой инструмент.
   */
  const showMoniker = async (): Promise<void> => {
    const path = editors.currentPath;
    if (!path) {
      showToast('Откройте файл', 'error');
      return;
    }
    const monikers = await lsp.monikers(path, editors.cursor()).catch(() => []);
    if (monikers.length === 0) {
      showToast('Моникер не найден: сервер этого не умеет или символа под курсором нет');
      return;
    }
    const copy = (identifier: string): void => {
      void navigator.clipboard.writeText(identifier).catch(() => undefined);
      showToast('Моникер скопирован');
    };
    const rect = layout.editorHost.getBoundingClientRect();
    showPopupMenu(
      monikers.map((item) => ({
        label: item.identifier,
        hint: `${item.scheme}${item.unique ? ' · уникальный' : ''}`,
        onSelect: () => copy(item.identifier),
      })),
      rect.left + 40,
      rect.top + 40,
      { anchor: layout.editorHost },
    );
    copy(monikers[0]!.identifier);
  };

  define({ id: 'editor.moniker', title: 'Моникер символа', category: 'Навигация' }, () => void showMoniker());
  return {
    openCallHierarchy,
    openTypeHierarchy,
    openFindExports,
    openInheritance,
    openTypeMembers,
    rebuildSymbolIndex,
    overrideMembers,
    showMoniker,
  };
}
