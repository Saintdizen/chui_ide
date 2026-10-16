import {
  type ConflictBlock,
  type ConflictChoice,
  conflictEdit,
  hasConflicts,
  parseConflicts,
} from '../../shared/conflicts';
import type { TextEdit } from '../../shared/edits';
import type { OwnDiffHandle } from '../editor/host/diff-editor';
import type { GitModel } from '../core/git-model';
import { languageFromPath } from '../core/languages';
import { clear, h, svgIcon } from './dom';

export interface ConflictViewDeps {
  /** Фабрика сравнения: движок приходит извне, здесь только тексты. */
  createDiff: (container: HTMLElement) => OwnDiffHandle;
  git: GitModel;
  /** Текущий текст файла в рабочем дереве: в нём и лежат маркеры конфликта. */
  readText: (path: string) => Promise<string>;
  /** Применить правки к документу (через app: документ и редактор вместе, с undo). */
  applyEdits: (path: string, edits: readonly TextEdit[]) => Promise<void>;
  /** Сохранить файл и отметить конфликт решённым (`git add`). */
  finish: (path: string) => Promise<void>;
  openInEditor: (path: string) => void;
  /** Сообщение человеку: ошибка применения или итог разрешения. */
  notify?: (message: string, kind?: 'info' | 'error') => void;
}

export interface ConflictView {
  element: HTMLElement;
  /** Показать конфликты файла. Возвращает false, если конфликтов в файле нет. */
  open(path: string): Promise<boolean>;
  close(): void;
  readonly isOpen: boolean;
}

const CHOICES: ReadonlyArray<{ choice: ConflictChoice; label: string }> = [
  { choice: 'ours', label: 'Наше' },
  { choice: 'theirs', label: 'Их' },
  { choice: 'both', label: 'Оба' },
];

/**
 * Экран разрешения конфликта слияния.
 *
 * Показывает обе стороны (наше против их) и список блоков: у каждого видно, что
 * с одной стороны и что с другой, и есть три кнопки — что оставить. Выбор
 * применяется правками в документ, а «решённым» конфликт становится только после
 * `git add` — до этого git держит файл в состоянии «не слит». Ручной разбор
 * тоже возможен: маркеры правятся в обычном редакторе (кнопка «Открыть»).
 *
 * Экран — не вкладка: он поверх редактора и закрывается кнопкой или Escape,
 * как и просмотр сравнения.
 */
export function createConflictView(deps: ConflictViewDeps): ConflictView {
  const title = h('span', { class: 'diff-title' });
  const subtitle = h('span', { class: 'diff-subtitle' });
  const diffBody = h('div', { class: 'conflict-diff' });
  const blocksHost = h('div', { class: 'conflict-blocks' });

  const applyButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void applyChosen() },
    'Применить выбор',
  );
  const finishButton = h(
    'button',
    { class: 'btn', type: 'button', onClick: () => void finishFile() },
    'Отметить решённым',
  );
  const footer = h('div', { class: 'conflict-footer' }, applyButton, finishButton);

  const openButton = h(
    'button',
    { class: 'btn', type: 'button', title: 'Править маркеры вручную', onClick: () => openInEditor() },
    'Открыть в редакторе',
  );

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 14),
  );
  const header = h('div', { class: 'diff-header' }, svgIcon('file', 14), title, subtitle, openButton, closeButton);
  const element = h('div', { class: 'conflict-view' }, header, diffBody, blocksHost, footer);
  element.hidden = true;

  let handle: OwnDiffHandle | null = null;
  let open = false;
  let path: string | null = null;
  let blocks: readonly ConflictBlock[] = [];
  const choices = new Map<number, ConflictChoice>();
  let busy = false;

  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') close();
  });

  function close(): void {
    open = false;
    element.hidden = true;
    handle?.dispose();
    handle = null;
    path = null;
    blocks = [];
    choices.clear();
  }

  function openInEditor(): void {
    if (path) deps.openInEditor(path);
  }

  async function applyChosen(): Promise<void> {
    if (!path || busy || choices.size === 0) return;
    busy = true;
    try {
      const text = await deps.readText(path);
      const current = parseConflicts(text);
      // Правки — по исходному тексту: номера строк блока из него же, поэтому
      // несколько выбранных блоков применяются в один проход и не мешают друг другу.
      const edits = current.flatMap((block) => {
        const choice = choices.get(block.index);
        return choice ? [conflictEdit(text, block, choice)] : [];
      });
      if (edits.length === 0) return;
      await deps.applyEdits(path, edits);
    } catch (error) {
      deps.notify?.(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
    await render(path);
  }

  async function finishFile(): Promise<void> {
    if (!path || busy) return;
    busy = true;
    try {
      await deps.finish(path);
      deps.notify?.(`Конфликт разрешён: ${path.split('/').pop() ?? path}`);
      close();
    } catch (error) {
      deps.notify?.(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  /** Список блоков: у каждого — обе стороны и три кнопки выбора. */
  function renderBlocks(text: string): void {
    clear(blocksHost);
    if (blocks.length === 0) {
      blocksHost.appendChild(
        h(
          'p',
          { class: 'conflict-empty' },
          hasConflicts(text) ? 'В файле есть маркеры, но разобрать их не удалось' : 'Маркеров конфликта в файле нет',
        ),
      );
      return;
    }

    for (const block of blocks) {
      const buttons = CHOICES.map(({ choice, label }) => {
        const active = choices.get(block.index) === choice;
        return h(
          'button',
          {
            class: `btn conflict-choice${active ? ' is-active' : ''}`,
            type: 'button',
            onClick: () => {
              choices.set(block.index, choice);
              // Подсветка выбора — тут же, без пересборки списка.
              for (const node of row.querySelectorAll('.conflict-choice')) node.classList.remove('is-active');
              for (const [index, button] of buttons.entries()) {
                const on = CHOICES[index]!.choice === choice;
                button.classList.toggle('is-active', on);
              }
            },
          },
          label,
        );
      });

      const oursLabel = block.oursLabel || 'наше';
      const theirsLabel = block.theirsLabel || 'их';
      const row = h(
        'div',
        { class: `conflict-block${choices.has(block.index) ? ' is-chosen' : ''}` },
        h(
          'div',
          { class: 'conflict-head' },
          h('span', { class: 'conflict-index' }, `Блок ${block.index + 1}`),
          h('span', { class: 'conflict-lines' }, `строки ${block.startLine}–${block.endLine}`),
          ...buttons,
        ),
        h(
          'div',
          { class: 'conflict-side' },
          h('span', { class: 'conflict-side-label' }, oursLabel),
          h('pre', { class: 'conflict-side-text' }, block.ours || '(пусто)'),
        ),
        h(
          'div',
          { class: 'conflict-side' },
          h('span', { class: 'conflict-side-label' }, theirsLabel),
          h('pre', { class: 'conflict-side-text' }, block.theirs || '(пусто)'),
        ),
      );
      blocksHost.appendChild(row);
    }
  }

  async function render(next: string): Promise<void> {
    const text = await deps.readText(next);
    blocks = parseConflicts(text);
    // Выбор по блокам, которых уже нет (после применения), не храним.
    for (const index of [...choices.keys()]) {
      if (!blocks.some((block) => block.index === index)) choices.delete(index);
    }

    const name = next.split('/').pop() ?? next;
    title.textContent = `${name} — конфликт слияния`;
    title.title = next;
    const remaining = blocks.length;
    subtitle.textContent = remaining === 0 ? 'маркеров не осталось' : `блоков: ${remaining}`;
    subtitle.title = remaining === 0 ? 'Сохраните файл и отметьте решённым' : 'Выберите сторону для каждого блока';

    // Стороны для сравнения берём из индекса: это и есть две конфликтующие версии.
    const parts = await deps.git.conflictParts(next).catch(() => null);
    if (parts) {
      if (!handle) handle = deps.createDiff(diffBody);
      handle.set({ language: languageFromPath(next), original: parts.ours, modified: parts.theirs });
    }

    renderBlocks(text);
    // «Применить» нужно, только когда есть что применять; «Отметить решённым» —
    // когда маркеров не осталось (иначе в индекс ушёл бы файл с маркерами).
    applyButton.disabled = choices.size === 0;
    finishButton.disabled = blocks.length > 0;
  }

  return {
    element,
    get isOpen() {
      return open;
    },
    close,
    async open(next: string): Promise<boolean> {
      const text = await deps.readText(next);
      if (!hasConflicts(text)) return false;
      path = next;
      choices.clear();
      open = true;
      element.hidden = false;
      await render(next);
      return true;
    },
  };
}
