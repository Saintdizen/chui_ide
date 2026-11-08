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
import { selectionEnd, selectionStart } from '../view/selection';
import { FindState } from '../find/find-state';
import { compileQuery, rangeOfSelection, type FindMatch } from '../find/search';
import { replaceAll, replaceOne, type ReplaceEdit, type ReplaceSource } from '../find/replace';
import { countByGroup, groupCountLabel } from '../find/group-count';
import { createSearchHistory, stepHistory, type SearchHistory } from '../../core/search-history';

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
  /** История запросов и истории замен — своя у каждой панели: свой текст, свои запросы. */
  private readonly queryHistory: SearchHistory = createSearchHistory();
  private readonly replaceHistory: SearchHistory = createSearchHistory();
  /** Где стоим при листании стрелками: `-1` — в истории не были, в поле своё. */
  private queryCursor = -1;
  private replaceCursor = -1;
  /** Ввод, после которого листание начинается заново. */
  private lastTyped = '';
  private lastTypedReplace = '';
  private debounce: number | null = null;
  /** Куда вернуть фокус после закрытия — задаёт тот, кто виджет создал. */
  onClose: (() => void) | null = null;

  /** Совпадения текущего поиска — полосе меток нужно знать, где они в файле. */
  get matches(): readonly FindMatch[] {
    return this.state.snapshot.matches;
  }

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
    // Ручной ввод в поле сбрасывает листание: иначе стрелка «вниз» подставила бы
    // запрос из истории поверх только что набранного.
    this.input.addEventListener('input', () => {
      this.queryCursor = -1;
    });
    this.replaceInput.addEventListener('input', () => {
      this.replaceCursor = -1;
    });
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

  /**
   * Показать панель. `mode` задаёт, есть ли поле замены; `query` — с каким запросом.
   * `inSelection` — искать только в выделенном (Ctrl+Alt+F): границы снимаются
   * СЕЙЧАС, потому что дальше выделение у нас заберут — курсор встанет на
   * найденное совпадение, и прежние границы уже не прочитать.
   */
  show(mode: FindMode, query?: string, inSelection = false): void {
    this.visible = true;
    this.root.hidden = false;
    this.root.classList.toggle('is-replace', mode === 'replace');
    this.view.element.classList.add('own-editor-has-find');
    // Запрос по умолчанию — выделенный текст: искать то, что выделил, — обычное дело.
    // Если выделения нет — прошлый запрос из истории: закрыть и открыть поиск —
    // не повод набирать то же самое заново.
    const selected = this.controller.selectedText();
    const remembered = this.queryHistory.entries()[0] ?? '';
    const initial = query ?? (selected.includes('\n') ? '' : selected || remembered);
    if (initial.length > 0) this.input.value = initial;
    // Поле непустое — листание начинается с нуля: иначе стрелка «вверх» подставила бы
    // поверх этого запроса его же самого.
    this.queryCursor = -1;
    this.lastTyped = initial;
    // Снимаем границы ДО первого пересчёта: иначе он пойдёт по всему файлу
    // и счётчик на миг покажет не то число.
    this.state.setRange(
      inSelection
        ? rangeOfSelection({
            start: selectionStart(this.controller.selection),
            end: selectionEnd(this.controller.selection),
          })
        : null,
    );
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
    // Границы выделения — про одну панель: закрыли и снова открыли обычным
    // поиском, искать по всему файлу. Иначе прежнее выделение тайком
    // подменяло бы область поиска.
    this.state.setRange(null);
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
    // Счёт по группам — подсказкой, а не второй строкой: он нужен эпизодически
    // (пишешь замену с `$1`), а место в панели дорогое. Пусто — подсказки нет.
    const byGroup = groupCountLabel(countByGroup(snapshot.matches), snapshot.matches.length);
    this.counter.title = byGroup;
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
    // ↑/↓ без Shift — история запросов, как в VS Code. В длинном запросе стрелки
    // уводят каретку, поэтому в историю — только с пустым полем или после листания.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!this.shouldBrowseHistory(this.input)) return;
      event.preventDefault();
      this.stepQueryHistory(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // Enter — вперёд, Shift+Enter — назад: как в остальных редакторах.
      // Заодно запоминаем запрос: его человек подтвердил действием.
      this.rememberQuery();
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
    // В поле замены стрелки тоже листают — свою историю подставок.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!this.shouldBrowseHistory(this.replaceInput)) return;
      event.preventDefault();
      this.stepReplaceHistory(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // Подтверждённую замену помним: её потом ищут назад чаще всего.
      this.rememberReplacement();
      if (event.ctrlKey || event.metaKey) this.replaceEverything();
      else this.replaceCurrent();
    }
  };

  /**
   * Можно ли отдать стрелку истории.
   *
   * Забирать стрелки всегда — значит сломать каретку в длинном запросе. Поэтому
   * история начинается там, где стрелке больше нечего делать в тексте: поле пустое
   * или мы уже листаем.
   */
  private shouldBrowseHistory(input: HTMLInputElement): boolean {
    const browsing = input === this.input ? this.queryCursor >= 0 : this.replaceCursor >= 0;
    return browsing || input.value.length === 0;
  }

  /**
   * Шаг по истории запросов.
   *
   * Набранное запоминается отдельно (`lastTyped`): листание подменяет поле, и без
   * этого возврат «вниз» вернул бы не своё, а чужое.
   */
  private stepQueryHistory(delta: number): void {
    // Своё набранное фиксируем ДО первого шага — иначе его не к чему вернуться.
    if (this.queryCursor < 0) this.lastTyped = this.input.value;
    const next = stepHistory(this.queryHistory.entries(), this.queryCursor, delta, this.lastTyped);
    this.queryCursor = next.index;
    this.input.value = next.query ?? this.lastTyped;
    // Пересчитываем сразу: листание — это уже готовый запрос, ждать ввода незачем.
    this.refresh();
    this.input.select();
  }

  private stepReplaceHistory(delta: number): void {
    if (this.replaceCursor < 0) this.lastTypedReplace = this.replaceInput.value;
    const next = stepHistory(
      this.replaceHistory.entries(),
      this.replaceCursor,
      delta,
      this.lastTypedReplace,
    );
    this.replaceCursor = next.index;
    this.replaceInput.value = next.query ?? this.lastTypedReplace;
    this.replaceInput.select();
  }

  private rememberQuery(): void {
    const value = this.input.value.trim();
    if (value.length === 0) return;
    this.queryHistory.remember(value);
    // Своё место в поле меняется: дальше листание начинается с этого текста.
    this.lastTyped = value;
    this.queryCursor = -1;
  }

  private rememberReplacement(): void {
    const value = this.replaceInput.value;
    // Пустая подстановка — это «удалить»: искать её назад так же нужно, как любую.
    this.replaceHistory.remember(value);
    this.lastTypedReplace = value;
    this.replaceCursor = -1;
  }

  dispose(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.root.remove();
  }
}
