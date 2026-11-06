import type { CommandDescriptor } from '../core/commands';
import { rankCommandMatches } from '../core/palette-rank';
import { QUICK_MODES, parseQuickPrefix, type QuickMode } from '../core/quick-prefix';
import { rankFiles } from '../core/quick-open-rank';
import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import { clear, dialogOverlay, h, svgIcon, type IconName } from './dom';
import { focusOwner, returnFocus } from './focus-return';

/** Место в файле — символ или совпадение по тексту. */
export interface QuickPlace {
  /** Абсолютный путь. */
  path: string;
  line: number;
  column: number;
  /** Что показывать в списке. */
  label: string;
  /** Подпись справа: вид символа, путь файла, начало строки. */
  detail?: string;
}

export interface QuickOpenView {
  element: HTMLElement;
  /**
   * Открыть список. Файлы читаются один раз и держатся до смены проекта.
   * `initialQuery` — начальный отбор или готовый префикс: `> ` открывает сразу
   * в режиме команд.
   */
  open(initialQuery?: string): Promise<void>;
  /**
   * Выбрать файл, не открывая его: тем же списком и тем же отбором. Обещание
   * разрешается абсолютным путём или `null`, если выбор отменили (Escape).
   */
  pick(title: string): Promise<string | null>;
  close(): void;
}

/** Строка списка: вид зависит от режима, а не от того, кто её нарисовал. */
type Row =
  | { kind: 'file'; path: string }
  | {
      kind: 'command';
      id: string;
      title: string;
      category: string;
      enabled: boolean;
      positions: readonly number[];
    }
  | { kind: 'place'; place: QuickPlace; icon: IconName };

/**
 * Один ввод вместо двух окон (`Ctrl+P`).
 *
 * Префикс решает, что ищется: `>` — команды, `@` — символы текущего файла,
 * `#` — текст по проекту, без префикса — файлы. Режим виден в подвале окна:
 * иначе `>` выглядит опечаткой, а `#` — будто поиск сломался.
 *
 * Список файлов по-прежнему отдаёт main одним вызовом; остальные режимы
 * приходят от хоста (`symbols`, `search`) — окно не знает, откуда они.
 */
export function createQuickOpen(deps: {
  rpc: RpcClient;
  workspace: WorkspaceModel;
  /** Открыть файл по абсолютному пути — тот же вход, что у дерева и вкладок. */
  openFile(path: string): void | Promise<void>;
  /**
   * Недавно открытые файлы проекта (относительные пути, свежие сверху). Только
   * чтение: спрашиваем перед каждой отрисовкой, чтобы учитывать и те файлы,
   * которые открыли мимо окна (дерево, переход по ошибке, чат).
   */
  recentFiles?(): readonly string[];
  /** Реестр команд для режима `>`. Нет — режим скажет, что недоступен. */
  commands?: {
    list(): CommandDescriptor[];
    isEnabled(id: string): boolean;
    run(id: string): void;
    /** Перед показом списка: действия редактора живут своей жизнью и меняются. */
    refresh?(): void;
  };
  /** Недавние команды — чтобы `>` начинался с того, что запускали. */
  recentCommands?(): readonly string[];
  /** Символы текущего файла под запрос. */
  symbols?(query: string): Promise<QuickPlace[]>;
  /** Совпадения по тексту проекта под запрос. */
  search?(query: string): Promise<QuickPlace[]>;
  /** Перейти к месту в файле: открыть его и поставить каретку. */
  reveal?(path: string, line: number, column: number): void;
}): QuickOpenView {
  const input = h('input', {
    class: 'palette-input',
    type: 'text',
    placeholder: 'Начните вводить имя файла…',
    spellcheck: false,
  });
  const list = h('div', { class: 'palette-list' });
  const footer = h('div', { class: 'palette-footer' });
  const overlay = dialogOverlay(h('div', { class: 'palette' }, input, list, footer), {
    label: 'Быстрое открытие файла',
  });

  /** Относительные пути: ключ, по которому список перечитывается при смене проекта. */
  let root: string | null = null;
  let files: string[] = [];
  let loading = false;
  /** Причина, по которой список файлов не прочитался: показываем её в списке. */
  let loadError: string | null = null;
  /** Что ищет ввод прямо сейчас. */
  let mode: QuickMode = 'files';
  let rows: Row[] = [];
  let cursor = 0;
  /**
   * Номер текущего запроса. Ответ, пришедший после смены режима или запроса,
   * отбрасывается: иначе старая выдача перетирала бы новую — обычная гонка
   * асинхронного списка.
   */
  let ticket = 0;
  /** Таймер отложенного поиска: по тексту проекта запрос дорогой. */
  let pending: ReturnType<typeof setTimeout> | null = null;
  /** Режим выбора: пока задан, `run` возвращает путь сюда, а не открывает файл. */
  let picking: ((path: string | null) => void) | null = null;
  /** Чей был фокус до открытия: к нему и вернём при закрытии. */
  let owner: HTMLElement | null = null;

  /**
   * Недавние проекта — на момент отрисовки: список мог измениться мимо окна.
   * История хранит абсолютные пути (её пишет `openPath`), а окно работает
   * относительными, как их отдаёт `workspace.listFiles`: переводим здесь.
   */
  function recentFiles(): readonly string[] {
    const projectRoot = deps.workspace.root;
    const history = deps.recentFiles?.() ?? [];
    if (!projectRoot) return [];
    const prefix = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
    return history
      .filter((path) => path.startsWith(prefix) && path.length > prefix.length)
      .map((path) => path.slice(prefix.length));
  }

  async function loadFiles(): Promise<void> {
    const current = deps.workspace.root;
    if (current === root && files.length > 0) return;
    if (!current) {
      // Проекта нет — и списку неоткуда взяться. Причина видна в списке, а не
      // выдаётся за «файлов нет»: это разные вещи.
      files = [];
      root = null;
      loadError = 'Проект не открыт';
      return;
    }
    loadError = null;
    loading = true;
    render();
    try {
      files = await deps.rpc.request('workspace.listFiles');
      root = current;
    } catch (error) {
      // Печатаем и в консоль: тост мельком, а причину пустого списка надо видеть.
      // Причину показываем в самом списке: тост улетает, а пустой список без
      // объяснения читается как «в проекте правда нет файлов».
      loadError = error instanceof Error ? error.message : String(error);
      files = [];
    } finally {
      loading = false;
    }
  }

  /** Выбор строки: файл открывается, команда запускается, место — показывается. */
  function run(row: Row): void {
    if (row.kind === 'file') {
      runFile(row.path);
      return;
    }
    if (row.kind === 'command') {
      if (!row.enabled) return;
      close();
      deps.commands?.run(row.id);
      return;
    }
    close();
    if (deps.reveal) deps.reveal(row.place.path, row.place.line, row.place.column);
    else void deps.openFile(row.place.path);
  }

  function runFile(relative: string): void {
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
  /** Подвал: какие режимы есть и какой сейчас. */
  function renderFooter(): void {
    clear(footer);
    for (const item of QUICK_MODES) {
      footer.appendChild(
        h(
          'span',
          { class: `palette-mode${item.mode === mode ? ' is-active' : ''}` },
          h('kbd', {}, item.marker || 'имя'),
          item.hint,
        ),
      );
    }
  }

  /**
   * Пересобрать список под текущий ввод.
   *
   * Режим берётся из строки, а не из переключателя: человек написал `>`, и
   * список стал командами — без второго окна и без закрытия.
   */
  function render(): void {
    clear(list);
    const parsed = parseQuickPrefix(input.value);
    mode = parsed.mode;
    renderFooter();

    if (loading && mode === 'files') {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Читаю список файлов…'));
      return;
    }

    if (mode === 'files') {
      rows = rankFiles(files, parsed.query, 50, recentFiles()).map((path) => ({ kind: 'file', path }));
      cursor = Math.min(cursor, Math.max(rows.length - 1, 0));
      if (rows.length === 0) {
        list.appendChild(
          h(
            'div',
            { class: 'palette-empty' },
            // Причина важнее вывода: пустой список без объяснения читается как
            // «в проекте правда нет файлов».
            loadError ?? (files.length === 0 ? 'В проекте нет файлов' : 'Ничего не найдено'),
          ),
        );
        return;
      }
      rows.forEach(draw);
      return;
    }

    if (mode === 'commands') {
      renderCommands(parsed.query);
      return;
    }

    // Символы и текст приходят асинхронно: старая выдача остаётся на экране,
    // пока не придёт новая под этот же запрос.
    // Значок символа — `target` (попадание в место), поиска — `search`.
    schedulePlaces(
      parsed.query,
      mode === 'symbols' ? deps.symbols : deps.search,
      mode === 'symbols' ? 'target' : 'search',
    );
  }

  function draw(row: Row, index: number): void {
    if (row.kind === 'file') {
      const slash = row.path.lastIndexOf('/');
      const name = slash < 0 ? row.path : row.path.slice(slash + 1);
      const dir = slash < 0 ? '' : row.path.slice(0, slash);
      bind(
        h(
          'button',
          { class: `palette-item${index === cursor ? ' is-active' : ''}`, type: 'button' },
          svgIcon('file', 13),
          h('span', { class: 'palette-item-title' }, name),
          dir ? h('span', { class: 'palette-item-category' }, dir) : null,
        ),
        row,
        index,
      );
      return;
    }
    if (row.kind === 'command') {
      bind(
        h(
          'button',
          {
            class: `palette-item${index === cursor ? ' is-active' : ''}${row.enabled ? '' : ' is-disabled'}`,
            type: 'button',
            disabled: !row.enabled,
          },
          h('span', { class: 'palette-item-title' }, ...highlight(row.title, row.positions)),
          h('span', { class: 'palette-item-category' }, row.category),
        ),
        row,
        index,
      );
      return;
    }
    bind(
      h(
        'button',
        { class: `palette-item${index === cursor ? ' is-active' : ''}`, type: 'button' },
        svgIcon(row.icon, 13),
        h('span', { class: 'palette-item-title' }, row.place.label),
        row.place.detail ? h('span', { class: 'palette-item-category' }, row.place.detail) : null,
      ),
      row,
      index,
    );
  }
  function renderCommands(query: string): void {
    const registry = deps.commands;
    if (!registry) {
      rows = [];
      list.appendChild(h('div', { class: 'palette-empty' }, 'Реестр команд недоступен'));
      return;
    }
    const ranked = rankCommandMatches(registry.list(), query, deps.recentCommands?.() ?? [], 50) ?? [];
    rows = ranked.map((item) => ({
      kind: 'command',
      id: item.descriptor.id,
      title: item.descriptor.title,
      category: item.descriptor.category,
      enabled: registry.isEnabled(item.descriptor.id),
      positions: item.positions,
    }));
    cursor = Math.min(cursor, Math.max(rows.length - 1, 0));
    if (rows.length === 0) {
      list.appendChild(h('div', { class: 'palette-empty' }, 'Команда не найдена'));
      return;
    }
    rows.forEach(draw);
  }

  /** Название с подсветкой совпавших букв: `свн` → «Свернуть всё». */
  function highlight(title: string, positions: readonly number[]): (Node | string)[] {
    if (positions.length === 0) return [title];
    const hits = new Set(positions);
    const parts: (Node | string)[] = [];
    let plain = '';
    [...title].forEach((char, index) => {
      if (hits.has(index)) {
        if (plain) parts.push(plain);
        plain = '';
        parts.push(h('mark', {}, char));
        return;
      }
      plain += char;
    });
    if (plain) parts.push(plain);
    return parts;
  }

  /**
   * Асинхронная выдача режимов `@` и `#`.
   *
   * Пустой запрос не ищет: `#` без запроса показал бы весь проект, а это не
   * список, а дамп. Текст по проекту ещё и откладывается — запрос дорогой.
   */
  function schedulePlaces(
    query: string,
    source: ((query: string) => Promise<QuickPlace[]>) | undefined,
    icon: IconName,
  ): void {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    const current = ++ticket;
    clear(list);
    if (!source) {
      rows = [];
      list.appendChild(h('div', { class: 'palette-empty' }, 'Режим недоступен'));
      return;
    }
    if (query.trim() === '') {
      rows = [];
      list.appendChild(h('div', { class: 'palette-empty' }, 'Введите запрос'));
      return;
    }
    const ask = (): void => {
      void source(query)
        .then((places) => {
          // Ответ устарел: режим или запрос уже другие.
          if (current !== ticket) return;
          rows = places.slice(0, 50).map((place) => ({ kind: 'place', place, icon }) as Row);
          cursor = Math.min(cursor, Math.max(rows.length - 1, 0));
          clear(list);
          if (rows.length === 0) {
            list.appendChild(h('div', { class: 'palette-empty' }, 'Ничего не найдено'));
            return;
          }
          rows.forEach(draw);
        })
        .catch((error: unknown) => {
          if (current !== ticket) return;
          rows = [];
          clear(list);
          list.appendChild(
            h('div', { class: 'palette-empty' }, error instanceof Error ? error.message : String(error)),
          );
        });
    };
    if (mode === 'text') pending = setTimeout(ask, 120);
    else ask();
  }

  function bind(item: HTMLElement, row: Row, index: number): void {
    item.addEventListener('click', () => run(row));
    item.addEventListener('mousemove', () => {
      if (cursor === index) return;
      cursor = index;
      render();
    });
    list.appendChild(item);
  }
  input.addEventListener('input', () => {
    cursor = 0;
    render();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, rows.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = rows[cursor];
      if (target) run(target);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Первый Escape выходит из режима (к файлам), второй закрывает окно: из
      // `#` закрытие целиком ощущалось бы потерей набранного запроса.
      if (mode !== 'files') {
        input.value = '';
        cursor = 0;
        render();
        return;
      }
      close();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  function close(): void {
    overlay.hidden = true;
    // Отложенный запрос мог остаться в воздухе: его ответ уже не нужен.
    ticket += 1;
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    // Возвращаем фокус тому, кто открыл: иначе после Escape клавиатура
    // начинает обход страницы с начала.
    returnFocus(owner);
    owner = null;
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
      // Владельца берём ДО того, как фокус уйдёт в поле запроса.
      owner = focusOwner();
      overlay.hidden = false;
      input.value = initialQuery;
      cursor = 0;
      deps.commands?.refresh?.();
      await loadFiles();
      render();
      input.focus();
      // Курсор ставим в конец: набранный отбор остаётся, но его видно целиком.
      input.setSelectionRange(initialQuery.length, initialQuery.length);
    },
    pick(title) {
      return new Promise<string | null>((resolve) => {
        picking = resolve;
        void this.open('').then(() => {
          // Заголовок ставим после `open`: он тоже пишет placeholder.
          input.placeholder = title;
        });
      });
    },
    close,
  };
}
