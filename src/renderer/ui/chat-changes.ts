import type { ToolFileChange } from '../../shared/api';
import { fileWord } from './chat-text';
import { basename, clear, h, svgIcon } from './dom';

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
  const files = h('div', { class: 'changes-files', hidden: true });
  /** Список файлов раскрыт по умолчанию: он и есть содержимое панели. */
  let expanded = true;

  const toggle = h(
    'button',
    { class: 'changes-toggle', type: 'button', 'aria-expanded': 'true' },
    svgIcon('chevronDown', 12),
    summary,
    stat,
  );

  const element = h(
    'div',
    { class: 'composer-changes is-open', hidden: true },
    toggle,
    h(
      'div',
      { class: 'changes-actions' },
      // Правки уходят на диск сразу (см. applyAgentEdits в chat.ts), поэтому
      // сохранять вручную нечего — остаётся только откат к состоянию до правок.
      h('button', { class: 'btn btn-small', type: 'button', onClick: () => deps.onRevert() }, 'Отменить'),
    ),
    files,
  );

  function syncPanel(): void {
    files.hidden = !expanded;
    element.classList.toggle('is-open', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.title = expanded ? 'Скрыть список файлов' : 'Показать список файлов';
  }

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    syncPanel();
  });

  /** Подпись и значок файловой операции. */
  function fileLabel(change: ToolFileChange): { label: string; icon: 'trash' | 'filePlus' | 'file' } {
    if (change.kind === 'created') return { label: 'создан', icon: 'filePlus' };
    if (change.kind === 'deleted') return { label: 'удалён', icon: 'trash' };
    if (change.kind === 'modified') return { label: 'заменено', icon: 'file' };
    return { label: 'перенос', icon: 'file' };
  }

  function render(source: ChangesSource): void {
    const total = source.touched.size + source.files.length;
    if (total === 0) {
      element.hidden = true;
      files.hidden = true;
      clear(files);
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

    clear(files);
    for (const [target, entry] of source.touched) {
      files.appendChild(
        h(
          'button',
          { class: 'chip', type: 'button', title: target, onClick: () => deps.reveal(target, 1, 1) },
          svgIcon('file', 12),
          h('span', { class: 'chip-name' }, basename(target)),
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
      const { label, icon } = fileLabel(file);
      const title = file.from ? `${file.from} → ${file.path}` : file.path;
      files.appendChild(
        h(
          'button',
          { class: 'chip', type: 'button', title, onClick: () => deps.reveal(file.path, 1, 1) },
          svgIcon(icon, 12),
          h('span', { class: 'chip-name' }, basename(file.path)),
          h('span', { class: `chip-kind chip-kind-${file.kind}` }, label),
        ),
      );
    }

    syncPanel();
  }

  syncPanel();
  return { element, render };
}
