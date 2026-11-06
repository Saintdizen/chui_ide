import {
  type ConflictBlock,
  type ConflictChoice,
  conflictChoiceResult,
  conflictEdit,
  hasConflicts,
  parseConflicts,
} from '../../shared/conflicts';
import type { GitConflictParts } from '../../shared/api/git';
import type { TextEdit } from '../../shared/edits';
import { diffAgainstBase, type AnnotatedLine } from '../../shared/merge-diff';
import type { OwnDiffHandle } from '../core/diff-handle';
import type { GitModel } from '../core/git-model';
import { languageFromPath } from '../core/languages';
import { clear, h, svgIcon } from './dom';
import { errorText } from '../core/file-errors';

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
  /** Вернуть стороны и маркеры (`git checkout -m`); `force` — согласие потерять правку. */
  remerge: (path: string, force: boolean) => Promise<void>;
  /** Спросить человека, если пере-слияние затрёт его правку. */
  confirm?: (message: string) => Promise<boolean>;
  openInEditor: (path: string) => void;
  /** Сообщение человеку: ошибка применения или итог разрешения. */
  notify?: (message: string, kind?: 'info' | 'warn' | 'error') => void;
}

/** Привести тон сообщения к тому, что умеет тост: предупреждения отдельного вида нет. */
export function toastKindFor(kind: 'info' | 'warn' | 'error' = 'info'): 'info' | 'error' {
  return kind === 'error' ? 'error' : 'info';
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
  /**
   * Пере-слияние нужно ИМЕННО после отметки: до неё оно ничего не меняет.
   *
   * `git add` убивает стадии 1–3 — и вместе с ними любую возможность переиграть.
   * Кнопка возвращает маркеры и стороны, а `force` (второй шаг) — согласие
   * потерять то, что дописали после отметки.
   */
  const remergeButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      title: 'Вернуть маркеры и стороны заново',
      onClick: () => void remergeFile(false),
    },
    'Пере-слить',
  );
  const footer = h('div', { class: 'conflict-footer' }, applyButton, finishButton, remergeButton);

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
  /**
   * Текущий результат — вместо сравнения сторон, когда сравнивать уже неча.
   *
   * После «отметить решённым» маркеров нет и разбирать нечего: вместо трёх колонок
   * надо показать то, что легло в индекс. Без этого результат видели только открыв
   * файл целиком — потому пере-слияние и было нужно вслепую.
   */
  let resultText: string | null = null;

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

      // § «оба»: когда обе стороны правили ОДНУ строку, склейка — догадка, а не
      // результат слияния. Молчать нельзя: `a += 1` и `a += 2` рядом выглядят как
      // готовый код. Файл не сохраняем молча — редактор открыт, и решает человек.
      const guessed = current.filter((block) => {
        const choice = choices.get(block.index);
        return choice === 'both' && conflictChoiceResult(block, choice).ambiguous;
      });

      if (guessed.length > 0) {
        deps.notify?.(`Оба: стороны легли на одну строку (блок ${guessed[0]!.index + 1}) — проверь результат`, 'warn');
      }
    } catch (error) {
      deps.notify?.(errorText(error), 'error');
    } finally {
      busy = false;
    }
    await render(path);
  }

  /**
   * Отметить решённым — но НЕ закрывать экран.
   *
   * Раньше здесь был `close()`, и увидеть, что получилось, было негде: файл
   * уходил в индекс, вкладка закрывалась, и результат человек читал в файле
   * целиком. Теперь экран остаётся открытым и показывает то, что легло в индекс.
   */
  async function finishFile(): Promise<void> {
    if (!path || busy) return;
    busy = true;
    try {
      await deps.finish(path);
      deps.notify?.(`Конфликт разрешён: ${path.split('/').pop() ?? path}`);
      await render(path);
    } catch (error) {
      deps.notify?.(errorText(error), 'error');
    } finally {
      busy = false;
    }
  }

  /**
   * Вернуть маркеры и стороны заново (`git checkout -m`).
   *
   * Второй шаг (`force`) — только после отказа main: там правка, которую потеряем.
   * Согласие спрашиваем сами: молча терять работу человека нельзя.
   */
  async function remergeFile(force: boolean): Promise<void> {
    if (!path || busy) return;
    busy = true;
    try {
      await deps.remerge(path, force);
      choices.clear();
      deps.notify?.(`Пере-слито: ${path.split('/').pop() ?? path}`);
      await render(path);
    } catch (error) {
      const message = errorText(error);
      if (force || !/(затрёт|потеряется|lost)/i.test(message)) {
        deps.notify?.(message, 'error');
      } else if (deps.confirm) {
        const agreed = await deps.confirm(`${message}. Всё равно пере-слить?`);
        await render(path);
        if (agreed) {
          busy = false;
          await remergeFile(true);
          return;
        }
      } else {
        deps.notify?.(message, 'error');
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Разметка стороны по базе — своя для КАЖДОГО блока.
   *
   * Сверяем блок отдельно: жадный проход по всему файлу легко цепляет одинаковую
   * строку из соседнего блока, и тогда подсказка уезжает на чужое место. Внутри
   * блока такой ошибки быть не может — там всего одна спорная правка.
   */
  function annotationFor(
    parts: GitConflictParts | null,
    block: ConflictBlock,
  ): { ours: AnnotatedLine[]; theirs: AnnotatedLine[] } {
    if (!parts || !parts.base) return { ours: [], theirs: [] };
    const [hunk] = diffAgainstBase(block.ours, block.theirs, parts.base);
    return hunk ?? { ours: [], theirs: [] };
  }

  /**
   * Сторона блока: `<pre>` из строк, где вытеснавшие базу строки помечены.
   *
   * Без разметки — тот же `<pre>` одним куском: пустой `pre` на месте пустой
   * стороны читается как поломка, поэтому пишем «(пусто)», как и раньше.
   */
  function sidePres(lines: readonly AnnotatedLine[], text: string): HTMLElement {
    const pre = h('pre', { class: 'conflict-side-text' });
    if (lines.length === 0) {
      pre.textContent = text || '(пусто)';
      return pre;
    }
    for (const line of lines) {
      pre.appendChild(h('span', { class: `conflict-line is-${line.state}` }, line.text || ' '));
      pre.appendChild(h('span', { class: 'conflict-eol' }, '\n'));
    }
    return pre;
  }

  /** Список блоков: у каждого — обе стороны и три кнопки выбора. */
  function renderBlocks(text: string, parts: GitConflictParts | null): void {
    clear(blocksHost);
    // Отмечено решённым: блоков нет не потому, что нечего разбирать, а потому что
    // разобрали. Молчать об этом нельзя — иначе «пусто» читается как поломка.
    if (blocks.length === 0 && resultText !== null) {
      const pre = h('pre', { class: 'conflict-result-text' });
      pre.textContent = resultText === '' ? '(файл пуст)' : resultText;
      blocksHost.appendChild(
        h(
          'div',
          { class: 'conflict-result' },
          h('p', { class: 'conflict-result-head' }, 'В индексе сейчас:'),
          pre,
          h(
            'p',
            { class: 'conflict-result-hint' },
            'Не то? «Пере-слить» вернёт стороны и маркеры — разбор можно переиграть.',
          ),
        ),
      );
      return;
    }
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
          sidePres(annotationFor(parts, block).ours, block.ours),
        ),
        h(
          'div',
          { class: 'conflict-side' },
          h('span', { class: 'conflict-side-label' }, theirsLabel),
          sidePres(annotationFor(parts, block).theirs, block.theirs),
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
    resultText = blocks.length === 0 && parts?.worktree !== undefined ? (parts.worktree ?? '') : null;
    if (parts) {
      if (!handle) handle = deps.createDiff(diffBody);
      handle.set({ language: languageFromPath(next), original: parts.ours, modified: parts.theirs });
    }
    diffBody.hidden = resultText !== null;

    renderBlocks(text, parts);
    // «Применить» нужно, только когда есть что применять; «Отметить решённым» —
    // когда маркеров не осталось (иначе в индекс ушёл бы файл с маркерами).
    applyButton.disabled = choices.size === 0;
    finishButton.disabled = blocks.length > 0;
    // Пере-слияние имеет смысл только там, где стороны ещё есть в индексе:
    // без стадий 1–3 `git checkout -m` гарантированно откажет.
    remergeButton.disabled = parts?.conflicted === false;
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
