/**
 * Автодополнение: когда показать подсказки, что в них и что делать при выборе.
 *
 * Здесь встречаются три слоя: слова (`WordIndex`), подбор (`buildCompletions`) и попап
 * (`SuggestWidget`). Сам ответ на нажатие лежит в них; этот модуль решает, КОГДА что
 * делать, — а это и есть поведение подсказок, которое человек замечает:
 *
 *   • печатает букву — показываем список по набранному началу (простой автопоказ);
 *   • едет по списку стрелками, принимает Enter или Tab, отказывается Escape;
 *   • уводит курсор, ставит пробел или знак препинания — список закрывается сам, потому
 *     что набранное перестало быть началом слова;
 *   • Ctrl+Space — показать всё, что есть, даже без набранного.
 *
 * Внутри строк и комментариев подсказки не показываются: там слова не имеют отношения к
 * делу, а попап закрывает текст ровно там, где человек читает. Роль токена под курсором
 * даёт подсветка — второй таблицы «где мы находимся» держать не нужно.
 *
 * Словарь наполняется по мере надобности: перед показом списка в него добавляются строки
 * вокруг курсора, ещё не попавшие туда. Так подсказки опираются на то, что человек читал,
 * и не заставляют проходить весь файл при открытии.
 */

import type { TextBuffer } from '../core/text-buffer';
import { COMMENT, STRING } from '../highlight/tokens';
import { snippetsForLanguage, type Snippet } from '../../../shared/snippets';
import type { EditorController, EditorChange } from '../input/editor-controller';
import type { EditorView } from '../view/editor-view';
import { allCompletions, buildCompletions, DEFAULT_LIMIT, type CompletionItem } from './completions';
import { expandSnippet } from './snippet';
import { prefixAt } from './prefix';
import { WordIndex } from './word-index';
import type { SuggestWidget } from '../widgets/suggest-widget';

/** Сколько строк вокруг курсора заглядывать в словарь при каждом показе. */
const WORDS_AROUND = 400;

export interface CompletionAssistantOptions {
  /** Идентификатор языка: по нему берутся слова языка для подсказок. */
  language?: string;
  /** Свои дополнения от вызывающего — позже здесь будут ответы языкового сервера. */
  external?: () => readonly string[];
  /** Сниппеты всех языков: к текущему языку отберёт `snippetsForLanguage`. */
  snippets?: () => readonly Snippet[];
  /**
   * Подсказки языкового сервера: набранное начало и позиция курсора → дополнения.
   * Приходят асинхронно и подмешиваются в уже показанный список, когда ответят.
   * Не задано — подсказки только из слов и сниппетов.
   */
  lsp?: (prefix: string, position: { line: number; column: number }) => Promise<readonly CompletionItem[]>;
}

export class CompletionAssistant {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private buffer: TextBuffer;
  private readonly widget: SuggestWidget;
  private readonly index = new WordIndex();
  private readonly external: () => readonly string[];
  private readonly snippets: () => readonly Snippet[];
  private readonly lsp: CompletionAssistantOptions['lsp'];
  private language: string;
  /** Номер запроса к серверу: показ ответа — только если он ещё про текущее место. */
  private lspRequestId = 0;

  constructor(
    view: EditorView,
    controller: EditorController,
    buffer: TextBuffer,
    widget: SuggestWidget,
    options: CompletionAssistantOptions = {},
  ) {
    this.view = view;
    this.controller = controller;
    this.buffer = buffer;
    this.widget = widget;
    this.language = options.language ?? 'plaintext';
    this.external = options.external ?? (() => []);
    this.snippets = options.snippets ?? (() => []);
    this.lsp = options.lsp;
    widget.onAccept = () => this.accept();
  }

  /** Сменить язык (открыли другой файл). */
  setLanguage(languageId: string): void {
    this.language = languageId;
    this.index.reset();
    this.lspRequestId += 1;
    this.widget.hide();
  }

  /** Новый документ: слова прежнего к нему не относятся, и сам буфер уже другой. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.index.reset();
    this.lspRequestId += 1;
    this.widget.hide();
  }

  /**
   * Обработать клавишу раньше редактора. `true` — клавиша наша: так стрелки ходят по
   * списку, а не двигают курсор, и нажатие не попадает в текст.
   */
  handleKey(event: KeyboardEvent): boolean {
    // Ctrl+Space — показать всё: и слова языка, и имена из файла.
    if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.showAll();
      return true;
    }
    // Пока список виден, он забирает стрелки, Enter, Tab и Escape.
    if (this.widget.isVisible && this.widget.handleKey(event)) return true;
    // Ввод обычного знака закроет список: набранное перестанет быть началом слова,
    // и это выяснится при следующем изменении текста. Пока просто прячем его.
    if (this.widget.isVisible && isTypedChar(event)) this.widget.hide();
    return false;
  }

  /**
   * Текст изменился: пересчитать подсказки. Вызывается вводом после правки — тогда
   * подсказки предлагаются ровно по тому, что в документе сейчас.
   *
   * Название `onChange` — не вольность: это метод интерфейса `KeyInterceptor`, по
   * которому ввод и оповещает попапы (см. `input/editor-input.ts`).
   */
  onChange(change: EditorChange): void {
    this.changeCalls += 1;
    if (change.kind === 'selection') {
      // Курсор переехал без правки: список про прежнее место, показывать его нельзя.
      if (this.widget.isVisible) this.widget.hide();
      return;
    }
    // Правка: в словаре обновляем затронутые строки.
    this.index.invalidate(this.buffer.lineAt(change.from) - 1);
    const caret = this.controller.caret;
    const line = this.buffer.lineAt(caret);
    const text = this.buffer.lineText(line);
    const prefix = prefixAt(text, caret - this.buffer.lineStart(line));
    if (prefix.length === 0) {
      this.hideReasons += 1;
      this.widget.hide();
      return;
    }
    // В строке или комментарии не подсказываем: там слова — это текст, а не код.
    const tokenType = this.view.tokenTypeAt(caret);
    this.lastToken = tokenType;
    if (tokenType === STRING || tokenType === COMMENT) {
      this.hideReasons += 1;
      this.widget.hide();
      return;
    }
    this.show(prefix);
  }

  /** Показать подсказки по набранному началу. */
  private show(prefix: string): void {
    this.fillIndex();
    const items = buildCompletions(this.index, this.language, prefix, {
      limit: DEFAULT_LIMIT,
      external: this.external(),
      snippets: snippetsForLanguage(this.snippets(), this.language),
      exclude: this.contextWords(prefix),
    });
    const caret = this.controller.caret;
    this.widget.show(items, this.anchor(caret), prefix.length);
    this.askServer(prefix, caret);
  }

  /** Показать всё без набранного начала — по Ctrl+Space. */
  private showAll(): void {
    this.fillIndex();
    const items = allCompletions(this.index, this.language, {
      limit: DEFAULT_LIMIT,
      external: this.external(),
      snippets: snippetsForLanguage(this.snippets(), this.language),
    });
    // Заменяем слово под курсором, если оно есть: тогда подсказка встаёт вместо него.
    const caret = this.controller.caret;
    const line = this.buffer.lineAt(caret);
    const prefix = prefixAt(this.buffer.lineText(line), caret - this.buffer.lineStart(line));
    this.widget.show(items, this.anchor(caret), prefix.length);
    this.askServer(prefix, caret);
  }

  /**
   * Спросить подсказки у языкового сервера и подмешать их в уже показанный список,
   * когда ответят. Свои слова никуда не уходят: ответ сервера идёт впереди, но при
   * неудаче список остаётся прежним — молчание сервера не должно гасить подсказки.
   */
  private askServer(prefix: string, caret: number): void {
    const lsp = this.lsp;
    if (!lsp) return;
    const id = ++this.lspRequestId;
    const position = this.buffer.positionAt(caret);
    void lsp(prefix, position)
      .then((extra) => {
        // Курсор уехал или пришёл новый запрос — ответ про прежнее место не показываем.
        if (id !== this.lspRequestId || this.controller.caret !== caret) return;
        if (extra.length === 0) return;
        // Своё показываем поверх: сервер и словарь часто дают одно и то же имя.
        const local = this.widget.allItems;
        const already = new Set(local.filter((item) => item.kind === 'external').map((item) => item.label));
        const fresh = extra.filter((item) => !already.has(item.label));
        const merged = [...fresh, ...local.filter((item) => item.kind !== 'external')];
        this.widget.show(merged, this.anchor(caret), prefix.length);
      })
      .catch(() => {
        // Сервера нет или он не ответил — остаются слова языка и документа.
      });
  }

  /** Принять выбранную подсказку: заменить набранное начало словом или раскрыть сниппет. */
  private accept(): void {
    const item = this.widget.current;
    if (!item) {
      this.widget.hide();
      return;
    }
    const caret = this.controller.caret;
    const start = caret - this.widget.replaces;
    this.widget.hide();
    const removed = this.buffer.getText(start, caret);
    // Сниппет раскрывается ПОСЛЕ вставки: разметка `${1:…}` в тексте не остаётся, а
    // курсор встаёт на первое место — так же ведёт себя Monaco (`InsertAsSnippet`).
    if (item.snippet !== undefined) {
      const expanded = expandSnippet(item.snippet);
      this.controller.applyEdit(
        { start, removed, inserted: expanded.text },
        { anchor: start + expanded.caret, active: start + expanded.selectionEnd },
      );
      return;
    }
    // Вставка идёт обычной правкой контроллера — значит, попадает в историю и
    // отменяется Ctrl+Z, как любой набор. Вставляем `insert`, если он есть: сервер
    // может подставлять не то, что в подписи.
    this.controller.applyEdit({ start, removed, inserted: item.insert ?? item.label });
  }

  /** Слова, уже стоящие в строке под курсором: предлагать их снова незачем. */
  private contextWords(prefix: string): ReadonlySet<string> {
    const found = new Set<string>([prefix]);
    const line = this.buffer.lineText(this.buffer.lineAt(this.controller.caret));
    for (const match of line.matchAll(/[\p{L}\p{Nl}\p{Nd}_$]{2,}/gu)) found.add(match[0]);
    return found;
  }

  /** Где каретка: попап показываем у неё, а не у края экрана. */
  private anchor(offset: number): { left: number; top: number; bottom: number } {
    const point = this.view.clientPoint(offset);
    return { left: point.left, top: point.top, bottom: point.bottom };
  }

  /** Добавить в словарь строки вокруг курсора, которых там ещё нет. */
  private fillIndex(): void {
    const line = this.buffer.lineAt(this.controller.caret);
    const from = Math.max(1, line - WORDS_AROUND);
    const to = Math.min(this.buffer.lineCount, line + WORDS_AROUND);
    for (let current = from; current <= to; current += 1) {
      this.index.addLine(current - 1, this.buffer.lineText(current));
    }
  }

  /** Выбранная подсказка — для проб и тестов. */
  get currentItem(): CompletionItem | null {
    return this.widget.current;
  }

  get isVisible(): boolean {
    return this.widget.isVisible;
  }

  /** Что знает ассистент: сколько слов, что набрано, сколько раз его позвали. */
  get diagnostics(): { words: number; prefix: string; changes: number; hides: number; lastToken: string | null } {
    const caret = this.controller.caret;
    const line = this.buffer.lineAt(caret);
    return {
      words: this.index.size,
      prefix: prefixAt(this.buffer.lineText(line), caret - this.buffer.lineStart(line)),
      changes: this.changeCalls,
      hides: this.hideReasons,
      lastToken: this.lastToken,
    };
  }

  /** Сколько раз ассистента позвали об изменении. Смотрим при отладке автопоказа. */
  private changeCalls = 0;
  /** Сколько раз попап прятали и почему — по этим числам видно обрыв. */
  private hideReasons = 0;
  /** Тип токена под курсором при последнем изменении. */
  private lastToken: string | null = null;
}

/** Печатный знак без Ctrl/Alt: такой ввод меняет текст и закрывает список. */
function isTypedChar(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete';
}
