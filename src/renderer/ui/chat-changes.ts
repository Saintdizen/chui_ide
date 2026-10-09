import type { ToolFileChange } from '../../shared/api';
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
}

export interface ChangesPanelDeps {
  /** Показать файл в редакторе (клик по чипу). */
  reveal(path: string, line: number, column: number): void;
  /** Откатить правки агента — кнопка «Отменить» в шапке панели. */
  onRevert(): void;
}

export interface ChangesPanelView {
  element: HTMLElement;
  /** Отрисовать по текущему состоянию беседы. */
  render(source: ChangesSource): void;
}

export function createChangesPanel(deps: ChangesPanelDeps): ChangesPanelView {
  const summary = h('span', { class: 'changes-summary' });
  const stat = h('span', { class: 'changes-stat' });
  // Файлы показываем списком в попапе: чипы в строке ломались переносом и при
  // десятке правок занимали пол-композера.
  const list = h('div', { class: 'changes-list' });
  // «Отменить» — в попапе: это действие над его содержимым, а в шапке кнопка
  // спорила со счётчиком и отнимала место в узкой панели.
  // Правки уходят на диск сразу (см. applyAgentEdits в chat.ts), поэтому
  // сохранять вручную нечего — остаётся только откат к состоянию до правок.
  const content = h(
    'div',
    { class: 'changes-popover' },
    list,
    h(
      'div',
      { class: 'changes-popover-actions' },
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

  /** Строка списка: значок, имя, папка и хвост — счётчик правок или вид операции. */
  function row(target: string, tail: Node, title = target): HTMLElement {
    const { name, dir } = shortPath(target);
    return h(
      'button',
      {
        class: 'changes-row',
        type: 'button',
        title,
        onClick: () => {
          popover.close();
          deps.reveal(target, 1, 1);
        },
      },
      fileIcon(target, 14),
      h('span', { class: 'changes-row-name' }, name),
      dir ? h('span', { class: 'changes-row-dir' }, dir) : null,
      tail,
    );
  }

  /** Подпись файловой операции. */
  function fileLabel(change: ToolFileChange): string {
    if (change.kind === 'created') return 'создан';
    if (change.kind === 'deleted') return 'удалён';
    if (change.kind === 'modified') return 'заменено';
    return 'перенос';
  }

  function render(source: ChangesSource): void {
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

    clear(list);
    for (const [target, entry] of source.touched) {
      list.appendChild(
        row(
          target,
          h(
            'span',
            { class: 'chip-stat' },
            h('span', { class: 'stat-add' }, `+${entry.added}`),
            h('span', { class: 'stat-del' }, `−${entry.removed}`),
          ),
        ),
      );
    }

    // Файловые операции: они уже на диске, но человеку важно видеть и их.
    for (const file of source.files) {
      const title = file.from ? `${file.from} → ${file.path}` : file.path;
      list.appendChild(row(file.path, h('span', { class: `chip-kind chip-kind-${file.kind}` }, fileLabel(file)), title));
    }

    syncPanel();
  }

  syncPanel();
  return { element, render };
}
