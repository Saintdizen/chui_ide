/**
 * Переход к строке по номеру и к файлу по пути (Ctrl+G).
 *
 * Маленькая панель с одним полем: человек помнит «ошибка на 412-й строке» или
 * держит в буфере обмена `src/main.ts:412` из лога — и хочет там оказаться, а не
 * листать и не открывать файл руками. Поэтому поле принимает и номер, и путь с
 * номером, и подсказывает имена файлов проекта по мере набора (как Sublime).
 *
 * Ввод номера разбирается прощающе: пробелы по краям не мешают, а номер за концом
 * файла прижимается к последней строке. Ошибкой это не считается — человек хотел
 * ближе к концу, а не «получил отказ».
 */

import { completionQuery, parseGotoInput } from '../../../shared/goto-target';
import { rankFiles } from '../../core/quick-open-rank';
import type { TextBuffer } from '../core/text-buffer';
import type { EditorController } from '../input/editor-controller';
import type { EditorView } from '../view/editor-view';

/** Сколько имён файлов показывать в подсказке: дальше всё равно придётся набирать. */
const MAX_SUGGESTIONS = 8;

export interface GotoLineWidgetDeps {
  /** Файлы проекта относительными путями — по ним набирается путь. */
  projectFiles?: () => Promise<readonly string[]>;
  /** Открыть файл и встать на строку: делает приложение (вкладки, история). */
  openPath?: (path: string, line: number, column: number) => void;
}

export class GotoLineWidget {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private readonly deps: GotoLineWidgetDeps;
  private buffer: TextBuffer;
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly hint: HTMLElement;
  private readonly list: HTMLElement;
  private visible = false;

  /** Файлы проекта — грузим один раз за жизнь виджета. */
  private files: readonly string[] | null = null;
  private loading: Promise<void> | null = null;
  private suggestions: readonly string[] = [];
  /** Выбранная строка в списке; `-1` — выбор не сделан, Enter переходит. */
  private picked = -1;

  /** Куда вернуть фокус после закрытия — задаёт тот, кто виджет создал. */
  onClose: (() => void) | null = null;

  constructor(view: EditorView, controller: EditorController, buffer: TextBuffer, deps: GotoLineWidgetDeps = {}) {
    this.view = view;
    this.controller = controller;
    this.buffer = buffer;
    this.deps = deps;

    this.root = document.createElement('div');
    this.root.className = 'own-editor-goto';
    this.root.hidden = true;

    const label = document.createElement('span');
    label.className = 'own-editor-goto-label';
    label.textContent = 'Строка:';

    this.input = document.createElement('input');
    this.input.className = 'own-editor-goto-input';
    this.input.type = 'text';
    this.input.setAttribute('aria-label', 'Путь и номер строки');
    this.input.setAttribute('autocomplete', 'off');
    this.input.spellcheck = false;

    this.hint = document.createElement('span');
    this.hint.className = 'own-editor-goto-hint';

    this.list = document.createElement('div');
    this.list.className = 'own-editor-goto-list';
    this.list.hidden = true;
    this.list.setAttribute('role', 'listbox');

    this.root.append(label, this.input, this.hint, this.list);
    view.element.append(this.root);

    this.input.addEventListener('keydown', this.onKeyDown);
    // Обёртка, а не голый метод: в `addEventListener` метод вызывается на элементе,
    // и `this` внутри перестаёт быть виджетом (проба это и поймала).
    this.input.addEventListener('input', () => this.onInput());
    // Клик по подсказке: тот же переход, что Enter по выбранной строке.
    this.list.addEventListener('mousedown', (event) => {
      const row = (event.target as HTMLElement | null)?.closest('[data-path]');
      if (!(row instanceof HTMLElement)) return;
      // `mousedown` без `preventDefault` уводит фокус из поля, и панель
      // закрылась бы раньше, чем сработает выбор.
      event.preventDefault();
      this.pick(row.dataset.path ?? '');
    });
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Новый документ: прежний номер строки к нему не относится, панель прячем. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    if (this.visible) this.hide();
  }

  /** Что сейчас в поле — для проб: живой ввод идёт через событие `input`. */
  setValue(value: string): void {
    this.input.value = value;
    this.onInput();
  }

  /** Список подсказок, как он сейчас показан. */
  get suggestionList(): readonly string[] {
    return this.suggestions;
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    this.input.value = String(this.buffer.lineAt(this.controller.caret));
    this.updateHint();
    this.input.focus();
    this.input.select();
    // Файлы грузим загодя: пока человек набирает номер, список уже готов.
    void this.loadFiles();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.list.hidden = true;
    this.suggestions = [];
    this.picked = -1;
    this.onClose?.();
  }

  /** Подтянуть список файлов проекта (один раз за жизнь виджета). */
  private async loadFiles(): Promise<void> {
    if (this.files !== null || this.loading !== null) {
      await this.loading;
      return;
    }
    if (!this.deps.projectFiles) return;
    this.loading = (async () => {
      try {
        this.files = (await this.deps.projectFiles?.()) ?? [];
      } catch {
        // Список — подсказка, а не условие перехода: не вышло — не страшно.
        this.files = [];
      } finally {
        this.loading = null;
      }
      // Пока грузили, человек мог уже набрать путь — обновим тогда и список.
      if (this.visible) this.onInput();
    })();
    await this.loading;
  }

  private onInput(): void {
    this.updateHint();
    this.updateSuggestions();
  }

  /** Подсказка внизу поля: что будет, если нажать Enter прямо сейчас. */
  private updateHint(): void {
    const total = this.buffer.lineCount;
    const parsed = parseGotoInput(this.input.value);
    if (parsed.error !== null) {
      this.hint.textContent = parsed.error;
      return;
    }
    if (parsed.query === null) {
      this.hint.textContent = `всего строк: ${total}`;
      return;
    }
    if (parsed.query.path !== null) {
      const where = parsed.query.line === null ? 'с начала' : `строка ${parsed.query.line}`;
      this.hint.textContent = `${parsed.query.path} · ${where}`;
      return;
    }
    // Подсказываем о прижатии: номер за концом файла — не ошибка, но знать о ней стоит.
    const value = parsed.query.line ?? 1;
    this.hint.textContent = value > total ? `из ${total} (последняя)` : `из ${total}`;
  }

  /** Список имён файлов: только когда набирают путь, и только если есть из чего. */
  private updateSuggestions(): void {
    const query = completionQuery(this.input.value);
    this.picked = -1;
    if (query === '' || !this.files || this.files.length === 0) {
      this.suggestions = [];
      this.renderList();
      return;
    }
    this.suggestions = rankFiles(this.files, query, MAX_SUGGESTIONS);
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.suggestions.length === 0) {
      this.list.hidden = true;
      return;
    }
    this.list.hidden = false;
    this.suggestions.forEach((path, index) => {
      const row = document.createElement('div');
      row.className = 'own-editor-goto-item';
      row.dataset.path = path;
      row.setAttribute('role', 'option');
      if (index === this.picked) row.classList.add('is-picked');
      row.textContent = path;
      this.list.append(row);
    });
  }

  /** Передвинуть выбор по списку; Enter затем переходит. */
  private movePick(delta: number): void {
    if (this.suggestions.length === 0) return;
    const count = this.suggestions.length;
    this.picked = (this.picked + delta + count) % count;
    this.renderList();
  }

  /** Взять файл из подсказки: подставить его путь (номер, если был, сохраняем). */
  private pick(path: string): void {
    if (path === '') return;
    const parsed = parseGotoInput(this.input.value);
    const line = parsed.query?.line ?? null;
    this.input.value = line === null ? path : `${path}:${line}`;
    this.onInput();
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  /** Перейти: к строке текущего файла или в другой файл — через приложение. */
  private go(): void {
    // Enter по выбранной подсказке — это выбор файла, а не переход.
    if (this.picked >= 0) {
      const path = this.suggestions[this.picked];
      if (path !== undefined) {
        this.pick(path);
        return;
      }
    }

    const parsed = parseGotoInput(this.input.value);
    if (parsed.query === null) return;
    const query = parsed.query;

    if (query.path !== null) {
      // Чужой файл открывает приложение: у виджета нет ни вкладок, ни истории.
      if (!this.deps.openPath) return;
      this.deps.openPath(query.path, query.line ?? 1, query.column);
      this.hide();
      return;
    }

    const target = Math.max(1, Math.min(query.line ?? 1, this.buffer.lineCount));
    // Столбец — от начала строки, как в `файл:строка:столбец`. `offsetAt` сам
    // прижимает столбец за концом строки к её концу — так же, как клик мимо текста.
    const caret = this.buffer.offsetAt({ line: target, column: Math.max(1, query.column) });
    this.controller.selectRange(caret, caret);
    this.view.revealOffset(caret);
    this.hide();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.movePick(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.movePick(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.go();
    }
  };

  dispose(): void {
    this.root.remove();
  }
}

/**
 * Номер строки из того, что ввели в поле. `null` — там не число (тогда переход не
 * выполняется). Номер прижимается к границам файла: за концом — последняя строка.
 *
 * Чистая функция: разбор ввода проверяется без окна. Разбор `путь:строка` живёт
 * рядом в `shared/goto-target.ts` — здесь остаётся только сам номер.
 */
export function parseLineNumber(input: string, lineCount: number): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (value < 1) return 1;
  return Math.min(value, Math.max(1, lineCount));
}
