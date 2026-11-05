import type { GitDiffHunk, ToolFileChange } from '../../shared/api';
import { hunkLineRange } from '../../shared/hunk-lines';
import { changeKindLabel } from '../../shared/tool-files';
import { fileWord } from './chat-text';
import { basename, clear, h, svgIcon } from './dom';
import { fileIcon } from './file-icons';
import { createPopover } from './popover';

/**
 * Панель изменений композера: что агент поменял в этой беседе.
 *
 * Два вида правок: правки документов (лежат в `touched`, у них есть счётчики
 * +/-) и файловые операции — создание, удаление, перенос (идут в `files`).
 * Панель только рисует: состояние живёт в беседе, а клик по файлу просит
 * редактор показать его. Раньше это было прямо в chat.ts — вынесено как
 * самостоятельный кусок, чтобы панель не росла.
 */

/** Правка документа: исходный текст и счётчики строк — их пишет `applyAgentEdits`. */
export interface ToggledFile {
  original: string;
  added: number;
  removed: number;
}

/** Что показать: правки документов и файловые операции беседы. */
export interface ChangesSource {
  touched: ReadonlyMap<string, ToggledFile>;
  files: readonly ToolFileChange[];
  /**
   * Сколько правок ещё не записано на диск. Сохранение — решение человека:
   * агент меняет документы в памяти, а файл пишет кнопка «Сохранить». Ноль
   * (или отсутствие) — сохранять нечего, кнопка неактивна.
   */
  unsaved?: number;
}

export interface ChangesPanelDeps {
  /** Показать файл в редакторе (клик по чипу). */
  reveal(path: string, line: number, column: number): void;
  /** Откатить правки агента — кнопка «Отменить» в попапе. */
  onRevert(): void;
  /** Записать правки агента на диск — кнопка «Сохранить». */
  onSave(): void;
  /**
   * Блоки изменений файла против `HEAD`, по требованию: попап открыт и файл
   * развёрнут. Без этого действия с блоками не показываются: пустой список и
   * ошибка не должны выглядеть как «блоков нет».
   */
  hunks?(path: string): Promise<readonly GitDiffHunk[]>;
  /** Отправить в индекс один блок файла. */
  onStageHunk?(path: string, hunk: GitDiffHunk): void;
  /** Вернуть файл к `HEAD` целиком — рядом с блоками, чтобы видеть цену блока. */
  onDiscardFile?(path: string): void;
  /** Подсказки панели: путь в буфер и прочие мелочи без своей кнопки. */
  notify?(message: string, kind?: 'info' | 'error'): void;
  /** Открыть файл в сравнении с `HEAD` — следующий шаг после блоков. */
  openDiff?(path: string): void;
}

export interface ChangesPanelView {
  element: HTMLElement;
  /** Отрисовать по текущему состоянию беседы. */
  render(source: ChangesSource): void;
  /**
   * Открыть список файлов снаружи — из ленты («изменено файлов: 3»).
   *
   * `path` — необязательный адрес: без него просто открывается список, с ним
   * сразу разворачиваются блоки этого файла. Путь из сообщения может устареть
   * (файл откатили позже) — тогда открывается список, а не пустой разворот.
   */
  open(path?: string): void;
}

export function createChangesPanel(deps: ChangesPanelDeps): ChangesPanelView {
  const summary = h('span', { class: 'changes-summary' });
  const stat = h('span', { class: 'changes-stat' });
  // Файл, развёрнутый до блоков. Хранится отдельно от списка: список
  // перерисовывается при каждой правке беседы, а разворот не должен схлопываться.
  let expanded: string | null = null;
  // Блоки получены: `null` — ещё не спрошены, ошибку показываем текстом.
  let hunks: readonly GitDiffHunk[] | null = null;
  let hunksError = false;
  // Последнее отрисованное состояние: разворот блоков асинхронный и перерисовывает
  // список сам, уже без нового вызова `render` от беседы.
  let lastSource: ChangesSource = { touched: new Map(), files: [] };
  // Файлы показываем списком в попапе: чипы в строке ломались переносом и при
  // десятке правок занимали пол-композера.
  const list = h('div', { class: 'changes-list' });
  // Действия — в попапе: это операции над его содержимым, а в шапке кнопки
  // спорили со счётчиком и отнимали место в узкой панели. «Сохранить» пишет
  // правки агента на диск, «Отменить» возвращает к состоянию до них. Пока
  // ничего не изменено, «Сохранить» неактивна — записывать нечего.
  const saveButton = h(
    'button',
    {
      class: 'btn btn-small btn-primary',
      type: 'button',
      onClick: () => {
        popover.close();
        deps.onSave();
      },
    },
    'Сохранить',
  );
  const content = h(
    'div',
    { class: 'changes-popover' },
    list,
    h(
      'div',
      { class: 'changes-popover-actions' },
      saveButton,
      h(
        'button',
        {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            popover.close();
            deps.onRevert();
          },
        },
        'Отменить',
      ),
    ),
  );
  // Прижимаем к левому краю якоря: попап должен остаться внутри панели чата,
  // а не уехать за левый край окна — якорь стоит в её левом нижнем углу.
  const popover = createPopover(content, { width: 340, align: 'start' });
  popover.element.classList.add('popover-changes');

  const toggle = h(
    'button',
    { class: 'changes-toggle', type: 'button', 'aria-expanded': 'false' },
    svgIcon('chevronDown', 12),
    summary,
    stat,
  );

  const element = h('div', { class: 'composer-changes', hidden: true }, toggle);

  /** Состояние шапки повторяет попап: он закрывается и кликом вне, и по Esc. */
  function syncPanel(): void {
    const open = popover.isOpen;
    element.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Скрыть список файлов' : 'Показать список файлов';
  }

  // Следим за атрибутом `hidden` попапа: иначе шапка разъедется с содержимым.
  new MutationObserver(syncPanel).observe(popover.element, { attributes: true, attributeFilter: ['hidden'] });

  toggle.addEventListener('click', () => {
    if (element.hidden) return;
    popover.toggle(toggle);
  });

  /** Имя файла и его папка: полный путь в строке списка не помещается. */
  function shortPath(target: string): { name: string; dir: string } {
    const name = basename(target);
    const parts = target.split(/[/\\]/).filter(Boolean);
    const dir = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';
    return { name, dir };
  }

  /**
   * Положить текст в буфер и сказать об этом тостом.
   *
   * Один хелпер на все кнопки панели: буфер — системный API, и провал там не
   * редкость (окно без фокуса, политика буфера). Молча проглоченный отказ из
   * кнопки «Копировать» — худший из возможных: человек уверен, что скопировал.
   */
  function copyText(text: string, what: string): void {
    void navigator.clipboard.writeText(text).then(
      () => deps.notify?.(`Скопировано: ${what}`),
      () => deps.notify?.('Не удалось скопировать', 'error'),
    );
  }

  /**
   * Кнопка «Копировать путь» в строке файла.
   *
   * Путь был только в `title` строки, а подсказка — это не действие: на тач-экране
   * её нет вовсе, и выделить путь из подсказки нельзя. `stopPropagation` обязателен:
   * клик всплыл бы в строку и заодно раскрыл блоки файла.
   */
  function rowActions(target: string): HTMLElement {
    return h(
      'span',
      { class: 'changes-row-actions' },
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Копировать путь',
          'aria-label': `Копировать путь: ${target}`,
          onClick: (event: Event) => {
            event.stopPropagation();
            copyText(target, 'путь');
          },
        },
        svgIcon('copy', 12),
      ),
    );
  }

  /** Строка списка: значок, имя, папка и хвост — счётчик правок или вид операции. */
  function row(target: string, tail: Node, title = target): HTMLElement {
    const { name, dir } = shortPath(target);
    return h(
      'div',
      { class: 'changes-row', role: 'group', title },
      h(
        'button',
        {
          class: 'changes-row-main',
          type: 'button',
          onClick: () => {
            // Блоки умеем показать — раскрываем строку на месте: человек и так
            // в панели, открывать файл в редакторе ради одного блока — лишний шаг.
            if (!deps.hunks) {
              popover.close();
              deps.reveal(target, 1, 1);
              return;
            }
            void toggleHunks(target);
          },
        },
        fileIcon(target, 14),
        h('span', { class: 'changes-row-name' }, name),
        dir ? h('span', { class: 'changes-row-dir' }, dir) : null,
        tail,
      ),
      // Кнопка — рядом с областью клика, а не внутри: `<button>` в `<button>`
      // браузер разворачивает в два соседних, и раскрытие файла начинает
      // срабатывать на копирование пути.
      rowActions(target),
    );
  }

  /**
   * Развернуть/свернуть блоки файла. Список перерисовывается и приходит новый,
   * поэтому состояние живёт в `expanded`, а не в самом DOM.
   */
  async function toggleHunks(target: string): Promise<void> {
    if (expanded === target) {
      expanded = null;
      hunks = null;
      hunksError = false;
      render(lastSource);
      return;
    }
    expanded = target;
    hunks = null;
    hunksError = false;
    render(lastSource);
    try {
      hunks = (await deps.hunks?.(target)) ?? [];
    } catch {
      hunksError = true;
      hunks = [];
    }
    render(lastSource);
  }

  /**
   * Открыть список из ленты. Якорь — сама шапка: попап должен встать там, где
   * человек видел счётчик, а не в углу экрана.
   *
   * Адрес проверяем по последнему состоянию беседы: файл из старого сообщения
   * мог быть откачен, и раскрывать пустоту хуже, чем показать список.
   */
  function open(path?: string): void {
    if (element.hidden) return;
    if (!popover.isOpen) popover.toggle(toggle);
    if (!path) return;
    const known = lastSource.touched.has(path) || lastSource.files.some((file) => file.path === path);
    if (!known) return;
    // Уже развёрт — не схлопываем повторным кликом: из ленты пришли посмотреть,
    // а не переключить.
    if (expanded !== path) void toggleHunks(path);
  }

  /** Строки блока — так, как человек видит их в редакторе (новые номера). */
  function hunkLabel(hunk: GitDiffHunk): string {
    const { from, to } = hunkLineRange(hunk);
    if (from === to) return `стр. ${from}`;
    return `стр. ${from}–${to}`;
  }

  /** Блоки под развёрнутой строкой: к каждому — индексация, на файл — откат. */
  function hunkRows(target: string): HTMLElement {
    if (hunksError) {
      return h('div', { class: 'changes-hunks-note' }, 'Не удалось получить блоки');
    }
    if (hunks === null) {
      return h('div', { class: 'changes-hunks-note' }, 'Считаем блоки…');
    }
    // Сужение типа не переносится внутрь замыкания `map` — берём длину заранее.
    const count = hunks.length;
    const rows: Node[] = hunks.map((hunk, index) =>
      h(
        'div',
        { class: 'changes-hunk' },
        h(
          'span',
          {
            class: 'changes-hunk-label',
            title: `${hunk.oldStart},${hunk.oldCount} → ${hunk.newStart},${hunk.newCount}`,
          },
          hunkLabel(hunk),
        ),
        h(
          'button',
          {
            class: 'btn btn-small changes-hunk-btn',
            type: 'button',
            onClick: () => {
              popover.close();
              deps.onStageHunk?.(target, hunk);
            },
          },
          'В индекс',
        ),
        h(
          'button',
          {
            class: 'btn btn-small changes-hunk-btn',
            type: 'button',
            title: `Развернуть в редакторе на строке ${hunkLineRange(hunk).from}`,
            onClick: () => {
              popover.close();
              deps.reveal(target, hunkLineRange(hunk).from, 1);
            },
          },
          'Показать',
        ),
        deps.openDiff
          ? h(
              'button',
              {
                class: 'btn btn-small changes-hunk-btn',
                type: 'button',
                title: 'Открыть файл в сравнении с HEAD',
                onClick: () => {
                  popover.close();
                  deps.openDiff?.(target);
                },
              },
              'Сравнить',
            )
          : null,
        index === count - 1
          ? h(
              'button',
              {
                class: 'btn btn-small changes-hunk-btn',
                type: 'button',
                title: 'Вернуть файл к HEAD целиком',
                onClick: () => {
                  popover.close();
                  deps.onDiscardFile?.(target);
                },
              },
              'Откатить файл',
            )
          : null,
      ),
    );
    if (rows.length === 0) {
      rows.push(h('div', { class: 'changes-hunks-note' }, 'Блоков нет: файл не отличается от HEAD'));
    }
    return h('div', { class: 'changes-hunks' }, ...rows);
  }

  function render(source: ChangesSource): void {
    lastSource = source;
    const total = source.touched.size + source.files.length;
    if (total === 0) {
      element.hidden = true;
      popover.close();
      clear(list);
      return;
    }

    let added = 0;
    let removed = 0;
    for (const entry of source.touched.values()) {
      added += entry.added;
      removed += entry.removed;
    }
    for (const file of source.files) added += file.kind === 'created' ? (file.lines ?? 0) : 0;

    element.hidden = false;
    summary.textContent = `Изменён ${total} ${fileWord(total)}`;
    // Знак и число красятся по смыслу: плюсы — зелёные, минусы — красные.
    stat.replaceChildren(
      h('span', { class: 'stat-add' }, `+${added}`),
      h('span', { class: 'stat-del' }, `−${removed}`),
    );

    // «Сохранить» живёт, пока агент правил документы; активна, пока что-то из
    // этого ещё не на диске. Файловые операции (создан/удалён/перенос) уже
    // применены main-инструментами — сохранять их нечем, поэтому и не считаем.
    const unsaved = source.unsaved ?? 0;
    saveButton.hidden = source.touched.size === 0;
    saveButton.disabled = unsaved === 0;
    saveButton.textContent = unsaved > 0 ? `Сохранить (${unsaved})` : 'Сохранить';

    clear(list);
    for (const [target, entry] of source.touched) {
      const box = h('div', { class: 'changes-file' });
      box.appendChild(
        row(
          target,
          h(
            'span',
            { class: 'chip-stat' },
            h('span', { class: 'stat-add' }, `+${entry.added}`),
            h('span', { class: 'stat-del' }, `−${entry.removed}`),
            deps.hunks ? h('span', { class: 'changes-row-caret' }, expanded === target ? '▾' : '▸') : null,
          ),
        ),
      );
      if (expanded === target) box.appendChild(hunkRows(target));
      list.appendChild(box);
    }

    // Файловые операции: они уже на диске, но человеку важно видеть и их.
    for (const file of source.files) {
      const title = file.from ? `${file.from} → ${file.path}` : file.path;
      list.appendChild(
        row(file.path, h('span', { class: `chip-kind chip-kind-${file.kind}` }, changeKindLabel(file.kind)), title),
      );
    }

    syncPanel();
  }

  syncPanel();
  return { element, render, open };
}
