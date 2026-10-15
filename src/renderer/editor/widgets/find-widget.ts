/**
 * Панель поиска и замены внутри редактора.
 *
 * Виджет — только вид: он собирает разметку, слушает нажатия и показывает счётчик.
 * «Что ищется» и «сколько нашлось» живёт в `find/find-state.ts`, а «что делать с
 * найденным» — в контроллере. Так панель можно переставить или переоформить, не
 * трогая логику поиска.
 *
 * Открывается кнопкой в углу редактора и сочетаниями Ctrl+F (поиск) и Ctrl+H
 * (поиск с заменой). Панель стоит поверх текста у правого верхнего края — так её
 * видят все редакторы, и к этому привыкаешь; перекрывать код она не должна, поэтому
 * при показе представление сдвигает содержимое вниз на её высоту.
 *
 * Поиск пересчитывается не на каждое нажатие, а с небольшой задержкой: на большом
 * файле поиск занимает время, и если считать на каждый символ, набор в поле начнёт
 * отставать от пальцев. Задержка маленькая — глазом не заметна, а рывки убирает.
 */

import type { TextBuffer } from '../core/text-buffer';
import type { EditorController } from '../input/editor-controller';
import type { EditorView } from '../view/editor-view';
import { FindState } from '../find/find-state';
import { compileQuery, type FindMatch } from '../find/search';
import { replaceAll, replaceOne, type ReplaceEdit, type ReplaceSource } from '../find/replace';

/** Пауза перед пересчётом поиска после нажатия клавиши. */
const SEARCH_DEBOUNCE_MS = 120;

/** Куда встаёт панель: `find` — только поиск, `replace` — с полем замены. */
export type FindMode = 'find' | 'replace';

export class FindWidget {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private buffer: TextBuffer;
  private readonly state: FindState;
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly message: HTMLElement;

  private visible = false;
  private debounce: number | null = null;
  /** Куда вернуть фокус после закрытия — задаёт тот, кто виджет создал. */
  onClose: (() => void) | null = null;

  constructor(view: EditorView, controller: EditorController, buffer: TextBuffer) {
    this.view = view;
    this.controller = controller;
    this.buffer = buffer;
    this.state = new FindState(this.source());

    this.root = document.createElement('div');
    this.root.className = 'own-editor-find';
    this.root.hidden = true;
    this.root.setAttribute('role', 'search');

    this.input = document.createElement('input');
    this.input.className = 'own-editor-find-input';
    this.input.type = 'text';
    this.input.placeholder = 'Найти';
    this.input.setAttribute('aria-label', 'Найти');

    this.replaceInput = document.createElement('input');
    this.replaceInput.className = 'own-editor-find-input';
    this.replaceInput.type = 'text';
    this.replaceInput.placeholder = 'Заменить';
    this.replaceInput.setAttribute('aria-label', 'Заменить');

    this.counter = document.createElement('span');
    this.counter.className = 'own-editor-find-counter';
    this.message = document.createElement('div');
    this.message.className = 'own-editor-find-message';
    this.message.hidden = true;

    this.root.append(...this.buildRows());
    view.element.append(this.root);

    this.input.addEventListener('input', this.onQueryInput);
    this.input.addEventListener('keydown', this.onInputKeyDown);
    this.replaceInput.addEventListener('keydown', this.onReplaceKeyDown);
  }

  /** Разметка: две строки (поиск и замена) и сообщение под ними. */
  private buildRows(): HTMLElement[] {
    const findRow = document.createElement('div');
    findRow.className = 'own-editor-find-row';

    const toggleCase = this.toggle(
      'Aa',
      'Учитывать регистр',
      () => this.state.snapshot.options.caseSensitive,
      (on) => this.setOption({ caseSensitive: on }),
    );
    const toggleWord = this.toggle(
      'ab',
      'Слово целиком',
      () => this.state.snapshot.options.wholeWord,
      (on) => this.setOption({ wholeWord: on }),
    );
    const toggleRegex = this.toggle(
      '.*',
      'Регулярное выражение',
      () => this.state.snapshot.options.regex,
      (on) => this.setOption({ regex: on }),
    );

    const prev = this.button('↑', 'Предыдущее совпадение (Shift+Enter)', () => this.step(-1));
    const next = this.button('↓', 'Следующее совпадение (Enter)', () => this.step(1));
    const close = this.button('✕', 'Закрыть (Esc)', () => this.hide());

    findRow.append(this.input, this.counter, toggleCase, toggleWord, toggleRegex, prev, next, close);

    const replaceRow = document.createElement('div');
    replaceRow.className = 'own-editor-find-row is-replace';
    const replaceOneButton = this.button('Заменить', 'Заменить текущее совпадение', () => this.replaceCurrent());
    const replaceAllButton = this.button('Заменить всё', 'Заменить все совпадения', () => this.replaceEverything());
    replaceRow.append(this.replaceInput, replaceOneButton, replaceAllButton);

    return [findRow, replaceRow, this.message];
  }

  /** Кнопка с подписью; текст может быть и глифом. */
  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'own-editor-find-btn';
    node.textContent = label;
    node.title = title;
    node.setAttribute('aria-label', title);
    node.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
    return node;
  }

  /** Кнопка-переключатель настройки: нажата — включено. */
  private toggle(
    label: string,
    title: string,
    read: () => boolean | undefined,
    write: (on: boolean) => void,
  ): HTMLButtonElement {
    const node = this.button(label, title, () => write(!(read() === true)));
    node.classList.add('is-toggle');
    node.setAttribute('aria-pressed', 'false');
    // Состояние кнопки обновляем после отрисовки, когда оно уже посчитано.
    node.addEventListener('click', () =>
      queueMicrotask(() => node.setAttribute('aria-pressed', String(read() === true))),
    );
    return node;
  }

  /** Источник строк для поиска: документ редактора. */
  private source(): ReplaceSource & { lineCount: number } {
    return {
      getLine: (line0: number) => this.buffer.lineText(line0 + 1),
      lineStart: (line: number) => this.buffer.lineStart(line),
      lineCount: this.buffer.lineCount,
    };
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Новый документ. Совпадения прежнего к нему не относятся: прячем панель и снимаем
   * подсветку. Буфер меняем до этого — иначе ближайший пересчёт искал бы в старом.
   */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.hide();
  }

  /** Показать панель. `mode` задаёт, есть ли поле замены; `query` — с каким запросом. */
  show(mode: FindMode, query?: string): void {
    this.visible = true;
    this.root.hidden = false;
    this.root.classList.toggle('is-replace', mode === 'replace');
    this.view.element.classList.add('own-editor-has-find');
    // Запрос по умолчанию — выделенный текст: искать то, что выделил, — обычное дело.
    const selected = this.controller.selectedText();
    const initial = query ?? (selected.includes('\n') ? '' : selected);
    if (initial.length > 0) this.input.value = initial;
    this.refresh();
    this.input.focus();
    this.input.select();
    this.measure();
  }

  /**
   * Сообщить представлению высоту панели: поле прокрутки сдвигается ровно на неё.
   * Меряем после отрисовки — до неё размеров у узла ещё нет.
   */
  private measure(): void {
    requestAnimationFrame(() => {
      this.view.element.style.setProperty('--own-editor-find-height', `${this.root.offsetHeight}px`);
    });
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.view.element.classList.remove('own-editor-has-find');
    this.view.element.style.removeProperty('--own-editor-find-height');
    this.view.clearSearchHighlights();
    // Фокус возвращаем в редактор: панель — гость, работа продолжается в тексте.
    this.onClose?.();
  }

  /** Пересчитать поиск (запрос, настройки и подсветку) и обновить счётчик. */
  private refresh(): void {
    const query = this.input.value;
    this.state.setSource(this.source());
    this.state.setQuery(query, {}, this.controller.caret);
    this.applySnapshot();
  }

  /** Состояние кнопки-переключателя: `aria-pressed` и вид нажатой. */
  private setOption(option: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): void {
    this.state.setQuery(this.input.value, option, this.controller.caret);
    this.applySnapshot();
    this.syncToggles();
    this.input.focus();
  }

  /** После пересчёта: подсветка совпадений, счётчик и сообщение об ошибке. */
  private applySnapshot(): void {
    const snapshot = this.state.snapshot;
    this.setMessage(snapshot.error);
    this.view.setSearchHighlights(snapshot.matches, snapshot.current);

    if (snapshot.query.length === 0) {
      this.counter.textContent = '';
      return;
    }
    if (snapshot.matches.length === 0) {
      this.counter.textContent = 'нет совпадений';
      this.counter.classList.add('is-empty');
      return;
    }
    this.counter.classList.remove('is-empty');
    const current = snapshot.current >= 0 ? snapshot.current + 1 : 0;
    this.counter.textContent = `${current} из ${snapshot.matches.length}${snapshot.truncated ? '+' : ''}`;
  }

  private setMessage(text: string | null): void {
    this.message.hidden = text === null;
    this.message.textContent = text ?? '';
  }

  private syncToggles(): void {
    const buttons = this.root.querySelectorAll<HTMLButtonElement>('.own-editor-find-btn.is-toggle');
    const flags = [
      this.state.snapshot.options.caseSensitive === true,
      this.state.snapshot.options.wholeWord === true,
      this.state.snapshot.options.regex === true,
    ];
    buttons.forEach((node, index) => {
      node.setAttribute('aria-pressed', String(flags[index] === true));
    });
  }

  /** Перейти к следующему или предыдущему совпадению и показать его выделением. */
  private step(delta: number): void {
    const match = this.state.move(delta);
    if (!match) return;
    this.reveal(match);
    this.applySnapshotKeepingFocus();
  }

  /**
   * Повторить последний поиск шагом (Vim `n`/`N`): панель при этом не открываем — человек
   * уже задал запрос раньше. Запрос пересчитываем по текущему тексту: после правок прежние
   * места были бы неверны. Пусто в запросе — шагать некуда.
   */
  searchStep(delta: number): void {
    const { query, options } = this.state.snapshot;
    if (query.length === 0) return;
    this.state.setSource(this.source());
    this.state.setQuery(query, options, this.controller.caret);
    this.step(delta);
  }

  /** Показать совпадение: курсор и выделение на него, прокрутка к нему. */
  private reveal(match: FindMatch): void {
    this.controller.selectRange(match.start, match.end);
    this.view.revealOffset(match.start);
  }

  private applySnapshotKeepingFocus(): void {
    const snapshot = this.state.snapshot;
    this.view.setSearchHighlights(snapshot.matches, snapshot.current);
    const current = snapshot.current >= 0 ? snapshot.current + 1 : 0;
    this.counter.textContent = snapshot.matches.length > 0 ? `${current} из ${snapshot.matches.length}` : '';
  }

  /** Заменить текущее совпадение и перейти к следующему. */
  private replaceCurrent(): void {
    const match = this.state.currentMatch;
    if (!match) return;
    const compiled = compileQuery(this.input.value, this.state.snapshot.options);
    if (!compiled) return;
    const edit = replaceOne(this.source(), match, compiled, this.replaceInput.value, this.state.snapshot.options);
    if (!edit) return;
    this.applyEdit(edit);
    // Совпадения после правки пересчитываются, а курсор уже переехал — «текущим»
    // станет ближайшее к новой позиции, то есть следующее.
    this.refreshAfterEdit();
  }

  /** Заменить все совпадения одной правкой. */
  private replaceEverything(): void {
    const snapshot = this.state.snapshot;
    const compiled = compileQuery(snapshot.query, snapshot.options);
    if (!compiled || snapshot.matches.length === 0) return;
    const edit = replaceAll(this.source(), snapshot.matches, compiled, this.replaceInput.value, snapshot.options);
    if (!edit) return;
    this.applyEdit(edit);
    this.refreshAfterEdit();
    this.setMessage(`заменено: ${edit.count}`);
  }

  /** Правка идёт через контроллер: так она попадает в историю и отменяется Ctrl+Z. */
  private applyEdit(edit: ReplaceEdit): void {
    this.controller.applyEdit({ start: edit.start, removed: edit.removed, inserted: edit.inserted });
  }

  /** Пересчитать после правки: документ изменился, прежние совпадения недействительны. */
  private refreshAfterEdit(): void {
    this.state.setQuery(this.input.value, {}, this.controller.caret);
    this.applySnapshot();
  }

  private readonly onQueryInput = (): void => {
    // Пересчёт с задержкой: иначе поиск по большому файлу тормозит набор в поле.
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      this.refresh();
    }, SEARCH_DEBOUNCE_MS);
  };

  private readonly onInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter — вперёд, Shift+Enter — назад: как в остальных редакторах.
      this.step(event.shiftKey ? -1 : 1);
      return;
    }
    // Ctrl+F/Ctrl+H уже в панели: в поле фокуса нет у редактора, значит событие сюда
    // и должно приходить. Ctrl+F выделяет запрос, Ctrl+H раскрывает строку замены.
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
      const lower = event.key.toLowerCase();
      if (lower === 'f') {
        event.preventDefault();
        this.input.select();
        return;
      }
      if (lower === 'h') {
        event.preventDefault();
        this.show('replace', this.input.value);
        this.replaceInput.focus();
      }
    }
  };

  private readonly onReplaceKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) this.replaceEverything();
      else this.replaceCurrent();
    }
  };

  dispose(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.root.remove();
  }
}
