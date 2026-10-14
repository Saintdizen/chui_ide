/**
 * Ввод с клавиатуры и мыши: связка между DOM и контроллером.
 *
 * Здесь живёт всё, что требует событий браузера: нажатия клавиш, клики, вставка из
 * буфера обмена и работа IME. Сам смысл действий («вправо», «вставить») решают чистые
 * модули рядом, а этот слой только переводит одно в другое.
 *
 * Виртуальная клавиатура. Наш текст нарисован, а не лежит в поле ввода, поэтому
 * браузер не знает, куда ставить каретку и куда «приклеить» окно IME. Решение то же,
 * что в других редакторах: рядом с кареткой стоит почти невидимая `textarea`. В неё
 * браузер пишет состав иероглифа (его и показывает окошко выбора), а обычный ввод мы
 * перехватываем ещё раньше — событием `beforeinput`. Так и IME работает, и текст
 * остаётся нашим.
 *
 * Порядок перехвата принципиален:
 *
 *   • `keydown` — движения и команды (стрелки, Backspace, Enter, Tab, отмена). Эти
 *     клавиши гасим: без этого браузер попытается их «применить» к пустой `textarea`.
 *   • `beforeinput` — печатные символы и вставка. Тут же приходит готовый текст IME,
 *     поэтому отдельная ветка для состава не нужна: `compositionend` отдаёт итог.
 *   • `copy`/`cut`/`paste` — буфер обмена. Их отдаёт браузер, и только в них есть
 *     `clipboardData`; самих клавиш не касаемся.
 *
 * Мышь: нажатие ставит каретку, протяжка тянет выделение, двойной щелчок берёт слово,
 * тройной — строку. Счёт готовых щелчков даёт браузер в `event.detail`.
 */

import { wordAt } from '../core/graphemes';
import { blockCommentFor, lineCommentFor } from './comments';
import { chordCommand, chordName, isChordPrefix, resolveKey, type EditCommand, type Motion } from './keymap';
import { MacroRecorder, recordsCommand, runMacro, type MacroStep, type MacroTarget } from './macro';
import { VimBinding } from './vim-binding';
import type { VimMode } from './vim';
import { EmacsBinding } from './emacs-binding';
import type { EditorChange, EditorController } from './editor-controller';

import type { EditorView } from '../view/editor-view';
import { columnSelections, type Selection } from '../view/selection';

/** Команды, которые выполняются по событию `beforeinput`, а не по клавише. */
const CLIPBOARD_COMMANDS: ReadonlySet<EditCommand> = new Set(['copy', 'cut', 'paste']);

/** Команды, которые ввод не выполняет сам, а передаёт наружу. */
export type CommandName =
  | 'find'
  | 'replace'
  | 'gotoLine'
  | 'palette'
  | 'codeActions'
  /** Навигация по символу: перейти к определению, ссылки, заглянуть в определение. */
  | 'goToDefinition'
  | 'references'
  | 'peekDefinition'
  /** Обернуть выделение парой знаков; пару выбирает вызывающий. */
  | 'surroundWith'
  /** Отформатировать выделение участком (Ctrl+K Ctrl+F); сервер спрашивает вызывающий. */
  | 'formatSelection'
  /** Выделить по структуре шире/уже — участки берёт вызывающий у сервера. */
  | 'expandSelection'
  | 'shrinkSelection';

/**
 * Кто может забрать клавишу себе раньше редактора. Так устроены попапы: при видимом
 * списке подсказок стрелки ходят по списку, а Enter вставляет подсказку — и только когда
 * попапа нет, те же клавиши двигают курсор и переводят строку. Ввод спрашивает
 * перехватчиков по порядку и останавливается на первом, кто сказал «моя».
 */
export interface KeyInterceptor {
  /** Обработать клавишу. `true` — клавиша наша, редактору её не отдавать. */
  handleKey(event: KeyboardEvent): boolean;
  /** Текст или курсор изменились: перехватчик может показать или спрятать попап. */
  onChange?(change: EditorChange): void;
}

export interface EditorInputOptions {
  /** Что делать с командами, у которых нет своей реакции внутри редактора. */
  onCommand?: (command: CommandName) => void;
  /** Перехватчики клавиш и наблюдатели изменений — попапы и подсказки. */
  interceptors?: readonly KeyInterceptor[];
  /** Язык открытого файла: по нему ввод знает, чем комментировать строку (Ctrl+/). */
  language?: () => string | null;
  /**
   * Вставка из буфера прошла: где она легла (смещения буфера). Нужно тому, кто форматирует
   * вставленный кусок отдельно — сам ввод о форматировании не знает и знать не должен.
   */
  onPasted?: (range: { start: number; end: number }) => void;
  /** Vim-режим включён при создании (настройка `editor.vimMode`). */
  vimMode?: boolean;
  /** Режим Vim сменился — по нему приложение показывает значок в строке состояния. */
  onVimModeChange?: (mode: VimMode) => void;
  /** Emacs-режим включён при создании (настройка `editor.emacsMode`). */
  emacsMode?: boolean;
}

export class EditorInputBinding {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private readonly input: HTMLTextAreaElement;
  private readonly viewport: HTMLElement | null;
  private readonly onCommand: ((command: CommandName) => void) | undefined;
  private readonly interceptors: readonly KeyInterceptor[];
  private readonly language: (() => string | null) | undefined;
  /** Начатая приставка сочетания (`Ctrl+K`), ждущая вторую клавишу. `null` — не начата. */
  private pendingChord: string | null = null;
  /** Вставка прошла: сообщаем тому, кто форматирует вставленный кусок (см. опции). */
  private readonly onPasted: ((range: { start: number; end: number }) => void) | undefined;
  private dragging = false;
  /** Начало блочного выделения (Alt+протяжка): столбец берётся от этого места. */
  private boxAnchor: number | null = null;
  /** Идёт ли состав IME: пока он идёт, ввод не перехватываем — его завершит `compositionend`. */
  private composing = false;
  /** Запись макроса: копит действия, пока включена. */
  private readonly macro = new MacroRecorder();
  /** Модальный Vim-режим: разбор клавиш и применение команд. */
  private readonly vim: VimBinding;
  /** Emacs-режим: сочетания Ctrl/Alt поверх обычного ввода. */
  private readonly emacs: EmacsBinding;
  private readonly unsubscribe: () => void;

  constructor(view: EditorView, controller: EditorController, options: EditorInputOptions = {}) {
    this.view = view;
    this.controller = controller;
    this.onCommand = options.onCommand;
    this.interceptors = options.interceptors ?? [];
    this.language = options.language;
    this.onPasted = options.onPasted;
    // Vim: начальное состояние ставим молча — слушателя режима на этом этапе ещё нет.
    this.vim = new VimBinding(controller, options.onVimModeChange);
    this.vim.setEnabled(options.vimMode === true, false);
    this.emacs = new EmacsBinding(controller);
    this.emacs.setEnabled(options.emacsMode === true);
    this.input = document.createElement('textarea');
    this.input.className = 'own-editor-input';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocorrect', 'off');
    this.input.setAttribute('spellcheck', 'false');
    // Поле живёт ВНУТРИ полотна: так оно едет вместе с текстом при прокрутке, и окно
    // IME остаётся возле курсора, а не в углу экрана.
    view.element.querySelector('.own-editor-content')?.append(this.input);

    this.input.addEventListener('keydown', this.onKeyDown);
    this.input.addEventListener('beforeinput', this.onBeforeInput);
    this.input.addEventListener('compositionstart', this.onCompositionStart);
    this.input.addEventListener('compositionend', this.onCompositionEnd);
    this.input.addEventListener('copy', this.onCopy);
    this.input.addEventListener('cut', this.onCut);
    this.input.addEventListener('paste', this.onPaste);

    this.viewport = view.element.querySelector<HTMLElement>('.own-editor-viewport');
    this.viewport?.addEventListener('mousedown', this.onMouseDown);
    this.viewport?.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);

    this.unsubscribe = controller.onChange((change) => this.sync(change));
    this.sync({ kind: 'selection', from: controller.selection.active });
  }

  /** Идёт ли запись макроса (приложение показывает это в строке состояния). */
  isRecordingMacro(): boolean {
    return this.macro.isRecording;
  }

  /** Сколько действий уже записано. */
  macroLength(): number {
    return this.macro.length;
  }

  /** Начать запись макроса: прежний забывается. */
  startMacro(): void {
    this.macro.start();
  }

  /** Закончить запись и отдать записанное. */
  stopMacro(): readonly MacroStep[] {
    return this.macro.stop();
  }

  /** Записанный макрос (его сохраняет приложение, чтобы пережить закрытие окна). */
  macroSteps(): readonly MacroStep[] {
    return this.macro.taken();
  }

  /** Взять макрос из сессии: повтор доступен сразу после перезапуска. */
  restoreMacro(steps: readonly MacroStep[]): void {
    this.macro.set(steps);
  }

  /**
   * Выполнить макрос. Шаги идут тем же путём, что и нажатия: движение — через
   * движение, правка — через правку, текст — вставкой. Поэтому повтор ведёт себя
   * ровно так же, как если бы человек нажал те же клавиши.
   */
  playMacro(steps: readonly MacroStep[] = this.macro.taken()): number {
    const target: MacroTarget = {
      move: (motion, extend) => this.runMotion(motion, extend),
      edit: (command) => this.runEdit(command),
      insert: (text) => this.controller.type(text),
    };
    return runMacro(steps, target);
  }

  /** Vim-режим включён? */
  vimEnabled(): boolean {
    return this.vim.enabled;
  }

  /** Текущий режим Vim (при выключенном — «вставка»). */
  vimMode(): VimMode {
    return this.vim.mode;
  }

  /** Включить или выключить Vim-режим (настройка `editor.vimMode`). */
  setVimMode(on: boolean): void {
    this.vim.setEnabled(on);
  }

  /** Emacs-режим включён? */
  emacsEnabled(): boolean {
    return this.emacs.enabled;
  }

  /** Включить или выключить Emacs-режим (настройка `editor.emacsMode`). */
  setEmacsMode(on: boolean): void {
    this.emacs.setEnabled(on);
  }

  /** Поставить фокус в редактор — ввод идёт в скрытое поле. */
  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.unsubscribe();
    this.input.removeEventListener('keydown', this.onKeyDown);
    this.input.removeEventListener('beforeinput', this.onBeforeInput);
    this.input.removeEventListener('compositionstart', this.onCompositionStart);
    this.input.removeEventListener('compositionend', this.onCompositionEnd);
    this.input.removeEventListener('copy', this.onCopy);
    this.input.removeEventListener('cut', this.onCut);
    this.input.removeEventListener('paste', this.onPaste);
    this.viewport?.removeEventListener('mousedown', this.onMouseDown);
    this.viewport?.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.input.remove();
  }

  /** Перерисовать представление после изменения в контроллере и подвинуть поле ввода. */
  private sync(change: EditorChange): void {
    this.view.setSelections(this.controller.selections);
    // При правке текста сообщаем представлению смещение — от него оно считает строку,
    // с которой переразобрать подсветку (см. `view/editor-view.ts`).
    if (change.kind === 'text') this.view.refresh(change.from);
    this.view.revealOffset(this.controller.selection.active);
    this.moveInput();
    // Попапы видят изменение последними: к этому моменту текст и курсор уже на месте,
    // и им есть по чему пересчитать список (см. `complete/assistant.ts`).
    for (const interceptor of this.interceptors) interceptor.onChange?.(change);
  }

  /**
   * Поставить скрытое поле у каретки. Высоту берём как у строки, ширину — в клетку:
   * так окно IME появляется прямо под курсором, а не в углу редактора.
   */
  private moveInput(): void {
    const point = this.view.caretPoint(this.controller.selection.active);
    this.input.style.transform = `translate(${point.left}px, ${point.top}px)`;
    this.input.style.height = `${point.height}px`;
    this.input.value = '';
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const chord = {
      key: event.key,
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
    };

    // Сначала попапы: при видимом списке подсказок стрелки и Enter принадлежат ему,
    // а не движению курсора. Кто ответил «моя» — забирает клавишу целиком.
    for (const interceptor of this.interceptors) {
      if (interceptor.handleKey(event)) return;
    }

    // Затем — Vim-режим. В нормальном и визуальном режимах он забирает клавишу целиком,
    // а в режиме вставки пропускает всё, кроме выхода из него (Escape).
    if (this.vim.handleKey(chord)) {
      event.preventDefault();
      return;
    }

    // Emacs-режим: сочетания Ctrl/Alt поверх обычного ввода (режим не модальный).
    if (this.emacs.handleKey(chord)) {
      event.preventDefault();
      return;
    }

    // Сочетания-приставки (`Ctrl+K Ctrl+F`): первая клавиша пары ничего не делает, а
    // только ждёт вторую. Нажали что-то другое — пары не было, клавиша идёт обычным путём.
    const name = chordName(chord);
    if (this.pendingChord !== null) {
      const prefix = this.pendingChord;
      this.pendingChord = null;
      const command = chordCommand(prefix, name);
      if (command) {
        event.preventDefault();
        this.runEdit(command);
        return;
      }
    }
    if (isChordPrefix(name)) {
      event.preventDefault();
      this.pendingChord = name;
      return;
    }

    const action = resolveKey(chord);
    if (!action) return;

    if (action.kind === 'swallow') {
      event.preventDefault();
      return;
    }
    if (action.kind === 'insert') {
      // Печатный символ клавишей не вставляем: его отдаст `beforeinput`. Так работают
      // и составные знаки, и мёртвые клавиши (акценты), и IME.
      return;
    }
    if (action.kind === 'move') {
      event.preventDefault();
      this.macro.push({ kind: 'move', motion: action.motion, extend: action.extend });
      this.runMotion(action.motion, action.extend);
      return;
    }
    // Копирование, вырезание и вставку делают события буфера обмена — не мешаем им.
    if (CLIPBOARD_COMMANDS.has(action.edit)) return;

    event.preventDefault();
    if (recordsCommand(action.edit)) this.macro.push({ kind: 'edit', command: action.edit });
    this.runEdit(action.edit);
  };

  private readonly onBeforeInput = (event: InputEvent): void => {
    // Vim-режим вне вставки: клавиши там — команды, и текста в поле быть не должно.
    if (this.vim.enabled && this.vim.mode !== 'insert') {
      event.preventDefault();
      return;
    }
    // Набор текста снимает метку Emacs: она относится к выделению, а не к вводу.
    if (this.emacs.enabled) this.emacs.clearMark();
    // Пока идёт состав, ввод не трогаем: итог придёт по `compositionend`.
    if (this.composing) return;
    const { inputType, data } = event;
    if (inputType === 'insertText' || inputType === 'insertReplacementText') {
      event.preventDefault();
      // Набор с клавиши: за скобкой допишется пара, а закрывающая перешагнёт свою.
      if (data) {
        this.macro.push({ kind: 'insert', text: data });
        this.controller.typeWithPairs(data);
      }
      return;
    }
    if (inputType === 'insertFromPaste') {
      // Если пришли готовые данные — вставляем сразу; иначе сработает событие `paste`.
      if (data) {
        event.preventDefault();
        this.macro.push({ kind: 'insert', text: data });
        this.controller.paste(data);
      }
      return;
    }
    // Удаление уже обработано в `keydown`; остальные типы (перенос строки и прочее)
    // гасим, чтобы они не легли в скрытое поле.
    if (inputType.startsWith('delete') || inputType.startsWith('insert')) event.preventDefault();
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: CompositionEvent): void => {
    this.composing = false;
    // За время состава браузер написал текст в поле — берем итог и очищаем поле.
    const text = event.data ?? this.input.value;
    this.input.value = '';
    if (text) {
      this.macro.push({ kind: 'insert', text });
      this.controller.type(text);
    }
  };

  private readonly onCopy = (event: ClipboardEvent): void => {
    const text = this.controller.selectedText();
    if (!text) return;
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  };

  private readonly onCut = (event: ClipboardEvent): void => {
    const text = this.controller.cutSelection();
    if (!text) return;
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  };

  private readonly onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    this.paste(text);
  };

  /** Вставить текст и сказать, куда он лёг: каретка до и после вставки. */
  private paste(text: string): void {
    const before = this.controller.caret;
    this.controller.paste(text);
    const after = this.controller.caret;
    if (!this.onPasted || before === after) return;
    this.onPasted({ start: Math.min(before, after), end: Math.max(before, after) });
  }

  // — мышь —

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    // Глушим default: иначе браузер сам переносит фокус на узел под курсором
    // (у корня редактора есть tabindex), и вызов фокуса на скрытое поле теряется —
    // после клика текст перестаёт печататься вовсе. Заодно отменяется нативное
    // выделение: своё мы тянем сами в onMouseMove.
    event.preventDefault();
    this.focus();
    const offset = this.view.offsetAt(event.clientX, event.clientY);
    // Alt+клик добавляет каретку, не трогая уже стоящие, — так набирают мультикурсор
    // вручную. Протяжка после такого клика не начинается.
    if (event.altKey) {
      // Alt+клик добавляет каретку; Alt+протяжка — блочное выделение по столбцу.
      this.controller.addCursor({ anchor: offset, active: offset });
      this.boxAnchor = offset;
      this.dragging = true;
      return;
    }
    if (event.shiftKey) {
      // Shift+клик тянет выделение от прежнего места, а не ставит каретку заново.
      this.controller.setSelection({ anchor: this.controller.selection.anchor, active: offset });
      this.dragging = true;
      return;
    }
    this.controller.setSelection({ anchor: offset, active: offset });
    this.dragging = true;
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.dragging) return;
    const offset = this.view.offsetAt(event.clientX, event.clientY);
    // Блочное выделение: по выделению на каждой строке между концами.
    if (this.boxAnchor !== null) {
      this.controller.setSelections(columnSelections(this.controller.bufferRef, this.boxAnchor, offset));
      return;
    }
    this.controller.setSelection({ anchor: this.controller.selection.anchor, active: offset });
  };

  private readonly onMouseUp = (): void => {
    this.dragging = false;
    this.boxAnchor = null;
  };

  /** Двойной щелчок — слово под курсором, тройной — строка целиком. */
  private readonly onDoubleClick = (event: MouseEvent): void => {
    const offset = this.view.offsetAt(event.clientX, event.clientY);
    const range = event.detail >= 3 ? this.lineRange(offset) : this.wordRange(offset);
    this.controller.setSelection(range);
    this.dragging = false;
    this.boxAnchor = null;
  };

  private wordRange(offset: number): Selection {
    const buffer = this.controller.bufferRef;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    const word = wordAt(buffer.lineText(line), offset - start);
    if (!word) return { anchor: offset, active: offset };
    return { anchor: start + word.start, active: start + word.end };
  }

  private lineRange(offset: number): Selection {
    const buffer = this.controller.bufferRef;
    const line = buffer.lineAt(offset);
    const start = buffer.lineStart(line);
    return { anchor: start, active: start + buffer.lineText(line).length };
  }

  // — выполнение действий —

  private runMotion(motion: Motion, extend: boolean): void {
    switch (motion) {
      case 'left':
        this.controller.moveLeft(extend);
        break;
      case 'right':
        this.controller.moveRight(extend);
        break;
      case 'up':
        this.controller.moveVertical(-1, extend);
        break;
      case 'down':
        this.controller.moveVertical(1, extend);
        break;
      case 'wordLeft':
        this.controller.moveWordLeft(extend);
        break;
      case 'wordRight':
        this.controller.moveWordRight(extend);
        break;
      case 'lineStart':
        this.controller.moveLineStart(extend);
        break;
      case 'smartLineStart':
        this.controller.moveSmartLineStart(extend);
        break;
      case 'lineEnd':
        this.controller.moveLineEnd(extend);
        break;
      case 'docStart':
        this.controller.moveDocStart(extend);
        break;
      case 'docEnd':
        this.controller.moveDocEnd(extend);
        break;
      case 'pageUp':
        this.controller.movePage(-1, this.view.visibleLineCount(), extend);
        break;
      case 'pageDown':
        this.controller.movePage(1, this.view.visibleLineCount(), extend);
        break;
    }
  }

  private runEdit(edit: EditCommand): void {
    switch (edit) {
      case 'newline':
        this.controller.newline();
        break;
      case 'backspace':
        this.controller.backspace();
        break;
      case 'delete':
        this.controller.deleteForward();
        break;
      case 'deleteWordBackward':
        this.controller.deleteWordBackward();
        break;
      case 'deleteWordForward':
        this.controller.deleteWordForward();
        break;
      case 'indent':
        this.controller.indent();
        break;
      case 'outdent':
        this.controller.outdent();
        break;
      case 'undo':
        this.controller.undo();
        break;
      case 'redo':
        this.controller.redo();
        break;
      // Независимая отмена и повтор: только правка главной каретки.
      case 'undoAtCursor':
        this.controller.undoAtCursor();
        break;
      case 'redoAtCursor':
        this.controller.redoAtCursor();
        break;
      case 'selectAll':
        this.controller.selectAll();
        break;
      // Копирование, вырезание и вставка обрабатываются событиями буфера обмена.
      case 'copy':
      case 'cut':
      case 'paste':
        break;
      // Панель поиска, замена и переход к строке живут выше этого слоя: ввод о них
      // только сообщает, кто их показывает — дело вызывающего.
      case 'find':
        this.onCommand?.('find');
        break;
      case 'replace':
        this.onCommand?.('replace');
        break;
      case 'gotoLine':
        this.onCommand?.('gotoLine');
        break;
      // Ctrl+/ — комментарий строки: знак зависит от языка, а он — знание хозяина,
      // поэтому язык спрашиваем швом (см. `language` в опциях).
      case 'toggleComment': {
        const token = lineCommentFor(this.language?.() ?? null);
        if (token) this.controller.toggleComment(token);
        break;
      }
      // Shift+Alt+A — блочный комментарий: пара знаков тоже приходит от языка.
      case 'toggleBlockComment': {
        const marks = blockCommentFor(this.language?.() ?? null);
        if (marks) this.controller.toggleBlockComment(marks[0], marks[1]);
        break;
      }
      // Строки: удалить (Ctrl+Shift+K), соединить (Ctrl+Shift+J) или вставить рядом.
      case 'deleteLine':
        this.controller.deleteLines();
        break;
      case 'joinLines':
        this.controller.joinLines();
        break;
      case 'insertLineBelow':
        this.controller.insertLineBelow();
        break;
      case 'insertLineAbove':
        this.controller.insertLineAbove();
        break;
      // Alt+↑/↓ — перенос строки; Shift+Alt+↓ — её копия ниже.
      case 'moveLineUp':
        this.controller.moveLines(-1);
        break;
      case 'moveLineDown':
        this.controller.moveLines(1);
        break;
      case 'copyLineDown':
        this.controller.copyLinesDown();
        break;
      // F1 — палитра команд: её показывает вызывающий (в приложении — реестр команд).
      case 'palette':
        this.onCommand?.('palette');
        break;
      // Ctrl+. — быстрые исправления: список действий языка показывает вызывающий.
      case 'codeActions':
        this.onCommand?.('codeActions');
        break;
      // F12, Shift+F12, Ctrl+Shift+F12 — навигация по символу: дело вызывающего
      // (у него языковой сервер, чтение файлов и открытие вкладок).
      case 'goToDefinition':
        this.onCommand?.('goToDefinition');
        break;
      case 'references':
        this.onCommand?.('references');
        break;
      case 'peekDefinition':
        this.onCommand?.('peekDefinition');
        break;
      case 'surroundWith':
        this.onCommand?.('surroundWith');
        break;
      case 'formatSelection':
        this.onCommand?.('formatSelection');
        break;
      case 'expandSelection':
        this.onCommand?.('expandSelection');
        break;
      case 'shrinkSelection':
        this.onCommand?.('shrinkSelection');
        break;
      // Мультикурсор: вхождения слова, каретки по столбцу и сброс к главной.
      case 'selectNextOccurrence':
        this.controller.selectNextOccurrence();
        break;
      case 'selectAllOccurrences':
        this.controller.selectAllOccurrences();
        break;
      case 'addCursorAbove':
        this.controller.addCursorAbove();
        break;
      case 'addCursorBelow':
        this.controller.addCursorBelow();
        break;
      case 'collapseSelections':
        this.controller.collapseToPrimary();
        break;
      // Свернуть и развернуть блок у курсора — это состояние вида, вызывающий не нужен.
      case 'fold':
        this.view.foldAt(this.controller.caret);
        break;
      case 'unfold':
        this.view.unfoldAt(this.controller.caret);
        break;
    }
  }
}
