/**
 * Автодополнение: когда показать подсказки, что в них и что делать при выборе.
 *
 * Здесь встречаются три слоя: слова (`WordIndex`), подбор (`buildCompletions`) и попап
 * (`SuggestWidget`). Сам ответ на нажатие лежит в них; этот модуль решает, КОГДА что
 * делать, — а это и есть поведение подсказок, которое человек замечает:
 *
 *   • печатает букву — показываем список по набранному началу: слова файла, а следом
 *     объявления карты проекта (как индекс в больших IDE, который питает подсказки сам);
 *   • едет по списку стрелками, принимает Enter или Tab, отказывается Escape;
 *   • уводит курсор, ставит пробел или знак препинания — список закрывается сам, потому
 *     что набранное перестало быть началом слова;
 *   • Ctrl+Space — показать всё, что есть, даже без набранного;
 *   • повторное Ctrl+Space расширяет список: файл → проект → зависимости;
 *   • Ctrl+Shift+Space — только то, что подходит к месту: в позиции значения не
 *     предлагать имена типов, после `:` — только типы (первый шаг «умного» дополнения;
 *     сравнивать по ожидаемому типу мы не умеем — модели типов в клиенте нет).
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
import { expectedAt, filterByExpectation, type Expectation } from './expectation';
import { EXTERNAL_BONUS, matchScore } from './fuzzy';
import { importPathAt, importPathItems, type ImportPathContext } from './import-path';
import { expandSnippet } from './snippet';
import { memberAccessAt, membersOf, type MemberAccess } from './member-access';
import { prefixAt } from './prefix';
import { WordIndex } from './word-index';
import type { SuggestWidget } from '../widgets/suggest-widget';

/** Сколько строк вокруг курсора заглядывать в словарь при каждом показе. */
const WORDS_AROUND = 400;

/**
 * Пауза перед повтором запроса, если сервер ответил пусто. Первый ответ при старте
 * бывает пустым: сервер (tsserver, pyright) ещё разбирает проект, а не молчит.
 */
const LSP_RETRY_MS = 300;

/**
 * Пауза перед вопросом к карте символов при обычном наборе.
 *
 * Печатают быстрее, чем отвечает мост, и спрашивать на каждую букву значило бы держать
 * очередь запросов, обгоняющих друг друга. Пауза короткая: карта отвечает мгновенно,
 * и человек не должен замечать, что список «дорос» уже после нажатия.
 */
const INDEX_DELAY_MS = 120;

/** С какого набранного начала спрашивать карту: одна буква совпадёт с половиной проекта. */
const INDEX_MIN_PREFIX = 2;

/** Через сколько перечитывать список файлов проекта для подсказок пути. */
const FILE_LIST_TTL_MS = 5000;

/**
 * Откуда берутся подсказки: чем шире, тем больше список.
 *
 * Так же, как в больших IDE: первое нажатие Ctrl+Space даёт то, что рядом, повторное —
 * шире. Порядок именно такой, потому что ближнее нужнее: слово из этого файла человек
 * ищет чаще, чем класс из чужого пакета.
 */
export type CompletionScope = 'file' | 'project' | 'dependencies';

/** Следующий уровень ширины — для повторного Ctrl+Space. */
function widerScope(scope: CompletionScope): CompletionScope {
  if (scope === 'file') return 'project';
  return 'dependencies';
}

/** Подпись уровня в списке: по ней видно, откуда взялись новые имена. */
export function scopeLabel(scope: CompletionScope): string | null {
  if (scope === 'project') return 'из проекта';
  if (scope === 'dependencies') return 'из зависимости';
  return null;
}

/** Спрашивать ли карту символов по набранному началу: источник есть и набрано не меньше двух знаков. */
export function worthAskingIndex(prefix: string, hasSource: boolean): boolean {
  return hasSource && prefix.length >= INDEX_MIN_PREFIX;
}

/**
 * Что добавить из карты символов на этом уровне ширины.
 *
 * Уровни — вложенные: второй (`project`) показывает объявления своего кода, третий
 * (`dependencies`) добавляет к ним чужие. Так и должно быть: «шире» значит «не меньше,
 * чем было». Обратное (третий уровень только из пакетов) выглядело бы потерей — свои
 * имена исчезали бы при расширении.
 *
 * Уже показанное не повторяем — список не должен двоиться, — а подпись говорит, откуда
 * имя: у чужого ещё и пакет.
 */
export function extendItems(
  scope: CompletionScope,
  found: readonly ProjectCompletion[],
  shown: ReadonlySet<string>,
): CompletionItem[] {
  if (scope === 'file') return [];
  const items: CompletionItem[] = [];
  for (const symbol of found) {
    const fromDependency = Boolean(symbol.package);
    // Второй уровень — только своё: чужое появится на третьем.
    if (scope === 'project' && fromDependency) continue;
    if (shown.has(symbol.name)) continue;
    const detail = fromDependency ? `из зависимости: ${symbol.package}` : 'из проекта';
    items.push({ label: symbol.name, kind: 'word', detail });
  }
  return items;
}

/** Символ из карты: имя, вид и откуда взят — из проекта или из установленной зависимости. */
export interface ProjectCompletion {
  name: string;
  kind: string;
  /** Пакет, из которого символ (`requests`, `express`); пусто — своё объявление. */
  package?: string | null;
}

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
  /**
   * Символы проекта по имени — карта символов (`index` в main: объявления своего кода
   * и зависимостей, собранные заранее). Нужны в двух местах: повторный Ctrl+Space
   * показывает их уровнями, а обычный набор подмешивает своё из карты — так индекс
   * питает подсказки сам, не дожидаясь сервера.
   *
   * `onlyIndex` — «спроси только карту»: при наборе серверы не тревожим (их ответ
   * придёт своим путём), а на Ctrl+Space нужен полный ответ вместе с ними.
   * Не задано — расширять нечем, остаётся файл.
   */
  projectSymbols?: (query: string, onlyIndex?: boolean) => Promise<readonly ProjectCompletion[]>;
  /**
   * Файлы проекта относительными путями (`src/app.ts`, `pkg/core.py`). По ним строятся
   * подсказки пути внутри импорта — там человек ищет не имя, а файл, и слова ему не
   * помогут. Список берётся из проекта, а не из открытого файла: импортируют всегда чужое.
   */
  projectFiles?: () => Promise<readonly string[]>;
  /**
   * Путь открытого файла: от него считаются относительные спецификаторы (`./utils`).
   * Не задан — подсказки путей не работают, остаются слова.
   */
  currentPath?: () => string | null;
  /**
   * Довести подсказку опозданием (`completionItem/resolve`): на входе — исходный
   * элемент сервера из `CompletionItem.resolve`, на выходе — описание и уточнение.
   * Не задано — список показывает только то, что пришло в первом ответе.
   */
  resolve?: (item: unknown) => Promise<{ detail?: string; documentation?: string } | null>;
}

export class CompletionAssistant {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private buffer: TextBuffer;
  private readonly widget: SuggestWidget;
  private readonly index = new WordIndex();
  /** Символы карты проекта — для расширения списка повторным Ctrl+Space и при наборе. */
  private readonly projectSymbols?: (query: string, onlyIndex?: boolean) => Promise<readonly ProjectCompletion[]>;
  /** Файлы проекта для подсказок пути в импорте и путь открытого файла. */
  private readonly projectFiles?: () => Promise<readonly string[]>;
  private readonly currentPath?: () => string | null;
  /**
   * Прочитанный список файлов проекта. Держим его здесь, а не забираем на каждый знак:
   * обход дерева на каждую букву был бы дороже самих подсказок. Свежесть — по времени:
   * созданный файл появится в списке через несколько секунд (см. `FILE_LIST_TTL_MS`).
   */
  private fileList: readonly string[] | null = null;
  private fileListAt = 0;
  /** Текущая ширина списка Ctrl+Space: файл, проект, зависимости (см. `showAll`). */
  private scope: CompletionScope = 'file';
  /** Список открыт именно Ctrl+Space: только тогда повтор расширяет, а не начинает заново. */
  private askedAll = false;
  private readonly external: () => readonly string[];
  private readonly snippets: () => readonly Snippet[];
  private readonly lsp: CompletionAssistantOptions['lsp'];
  private readonly resolve: CompletionAssistantOptions['resolve'];
  /** Подписи, для которых уже спрашивали resolve: не повторяем на каждое движение стрелок. */
  private readonly resolveRequested = new Set<string>();
  private language: string;
  /** Номер запроса к серверу: показ ответа — только если он ещё про текущее место. */
  private lspRequestId = 0;
  /** Знаки, по которым сервер сам готов открывать подсказки (`.` в TS, `@` в CSS). */
  private triggers = new Set<string>();
  /** Отложенный повтор запроса к серверу — снимаем, если место/файл сменились. */
  private lspRetry: number | null = null;
  /** Отложенный вопрос к карте символов при наборе (см. `scheduleIndex`). */
  private indexTimer: number | null = null;

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
    this.projectSymbols = options.projectSymbols;
    this.projectFiles = options.projectFiles;
    this.currentPath = options.currentPath;
    this.resolve = options.resolve;
    widget.onAccept = () => this.accept();
    // Список выделил строку — доводим её до полного вида (описание, подробность).
    widget.onSelect = (item) => void this.resolveItem(item);
  }

  /** Сменить язык (открыли другой файл). */
  setLanguage(languageId: string): void {
    this.language = languageId;
    this.index.reset();
    this.resolveRequested.clear();
    this.lspRequestId += 1;
    this.clearRetry();
    this.widget.hide();
  }

  /**
   * Закрыть ассистент: снять отложенные запросы. Без этого таймеры (до 300 мс) держали бы
   * ассистент закрытой вкладки и могли дёрнуть сервер или карту вхолостую.
   */
  dispose(): void {
    this.clearRetry();
    this.clearIndexTimer();
    this.lspRequestId += 1;
  }

  /**
   * Знаки, по которым сервер готов открывать подсказки (из его `initialize`).
   * Приходят асинхронно при открытии файла: до ответа работает наш путь (точка и буквы).
   */
  setTriggerCharacters(characters: readonly string[]): void {
    this.triggers = new Set(characters);
  }

  /** Новый документ: слова прежнего к нему не относятся, и сам буфер уже другой. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.index.reset();
    this.resolveRequested.clear();
    this.lspRequestId += 1;
    this.clearRetry();
    this.clearIndexTimer();
    this.widget.hide();
  }

  /**
   * Обработать клавишу раньше редактора. `true` — клавиша наша: так стрелки ходят по
   * списку, а не двигают курсор, и нажатие не попадает в текст.
   */
  handleKey(event: KeyboardEvent): boolean {
    // Ctrl+Shift+Space — «умное»: только подходящее к месту. Проверяем раньше обычного
    // Ctrl+Space, иначе сочетание перехватит оно.
    if (event.key === ' ' && (event.ctrlKey || event.metaKey) && event.shiftKey) {
      event.preventDefault();
      this.showSmart();
      return true;
    }
    // Ctrl+Space — показать всё: и слова языка, и имена из файла.
    if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.showAll();
      return true;
    }
    // Пока список виден, он забирает стрелки, Enter, Tab и Escape.
    if (this.widget.isVisible && this.widget.handleKey(event)) return true;
    // Знак не прячем здесь: лишнее перепрятывание давало мигание — попап гас на нажатии
    // и тут же возвращался на изменении текста. Список обновит `onChange`, а если
    // набранное перестало совпадать — он и закроет попап (см. `show`).
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
    // Место сменилось — отложенный вопрос к карте про прежнее место уже не к месту.
    this.clearIndexTimer();
    // Начали печатать — уровни ширины больше не нужны: набранное начало точнее.
    if (change.kind !== 'selection') this.askedAll = false;
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
    const column = caret - this.buffer.lineStart(line);

    // Спецификатор импорта — не текст, а путь: подсказывать надо файлы проекта
    // (`from './ut'` — человек ищет файл, а не слово). Проверяем ДО строки: внутри
    // строки подсказки выключены, но путь — как раз то исключение, ради которого всё.
    const importContext = importPathAt(text, column, this.language);
    if (importContext) {
      this.widget.hide();
      void this.showImportPaths(importContext, caret);
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

    // После точки подсказываем ЧЛЕНОВ объекта, а не слова файла: набрав `this.`,
    // человек ждёт свои поля и методы. Показывается и на пустом наборе — сама точка
    // уже говорит, что дальше идёт имя члена.
    const member = memberAccessAt(text, column);
    if (member) {
      this.showMembers(member);
      return;
    }

    const prefix = prefixAt(text, column);
    if (prefix.length === 0) {
      // Знак-триггер сервера (`@` в CSS, `:` в JSON): сервер сам знает, что предложить
      // в этом месте, — спрашиваем, даже если набранного начала нет. Свой путь выше
      // (по буквам) этого не умеет: там имя уже есть, а здесь его ещё нет.
      if (this.triggers.has(charBefore(this.buffer, caret))) {
        this.widget.hide();
        this.askServer(prefix, caret);
        return;
      }
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
    // Карта проекта отвечает следом и своим чередом: список уже виден, поэтому
    // никакого ожидания сервера тут нет.
    this.scheduleIndex(prefix, caret);
  }

  /**
   * «Умное» дополнение — Ctrl+Shift+Space.
   *
   * От обычного отличается тем, что список сужен по месту: в позиции значения не
   * предлагаются имена типов, после `:` — переменные. Полноценного сравнения по
   * ожидаемому типу тут нет: модель типов живёт в языковом сервере, и он сам сужает
   * свой ответ. Здесь то, что видно по тексту.
   *
   * Если после сужения не осталось ничего — отдаём полный список: пустой попап в ответ
   * на нажатие читается как «подсказок нет вовсе».
   */
  private showSmart(): void {
    const caret = this.controller.caret;
    const line = this.buffer.lineAt(caret);
    const text = this.buffer.lineText(line);
    const column = caret - this.buffer.lineStart(line);
    // В импорте «умное» сужение ни к чему: подходящее тут ровно одно — путь.
    const importContext = importPathAt(text, column, this.language);
    if (importContext) {
      void this.showImportPaths(importContext, caret);
      return;
    }
    const member = memberAccessAt(text, column);
    if (member) {
      this.scope = 'file';
      this.showMembers(member);
      return;
    }

    const expectation = expectedAt(text.slice(0, column));
    const prefix = prefixAt(text, column);
    this.fillIndex();
    const all = allCompletions(this.index, this.language, {
      limit: DEFAULT_LIMIT,
      external: this.external(),
      snippets: snippetsForLanguage(this.snippets(), this.language),
    });
    const fitting = filterByExpectation(all, expectation);
    this.scope = 'file';
    this.askedAll = true;
    this.widget.show(fitting.length > 0 ? fitting : all, this.anchor(caret), prefix.length);
    // Серверу говорим, чего ждёт место: иначе его элементы придут без отбора, и
    // «умный» список снова наполнится тем, что тут не нужно.
    this.askServer(prefix, caret, 0, expectation === 'any' ? null : expectation);
  }

  /**
   * Показать всё без набранного начала — по Ctrl+Space.
   *
   * Повторное нажатие расширяет список: файл → проект → зависимости. Так же ведут себя
   * большие IDE, и это единственный способ добраться до имени, которого нет в открытом
   * файле, но которое есть в проекте: печатать его начало человек не хочет (он его не
   * помнит), а знать — хочет.
   *
   * Уровень помнится только пока список открыт по Ctrl+Space: стоит начать печатать, и
   * подсказки снова узкие — набранное начало точнее любого уровня.
   */
  private showAll(): void {
    const caret = this.controller.caret;
    const line = this.buffer.lineAt(caret);
    const text = this.buffer.lineText(line);
    const column = caret - this.buffer.lineStart(line);

    // В импорте Ctrl+Space значит «покажи пути», а не «все слова»: место просит файл.
    const importContext = importPathAt(text, column, this.language);
    if (importContext) {
      void this.showImportPaths(importContext, caret);
      return;
    }

    // После точки Ctrl+Space значит «все члены этого объекта», а не «все слова файла»:
    // уровни ширины тут ни при чём, членов у объекта ровно столько, сколько есть.
    const member = memberAccessAt(text, column);
    if (member) {
      this.scope = 'file';
      this.showMembers(member);
      return;
    }

    // Попап уже открыт этим же нажатием — значит просят шире; иначе начинаем с файла.
    this.scope = this.widget.isVisible && this.askedAll ? widerScope(this.scope) : 'file';
    this.askedAll = true;

    this.fillIndex();
    const items = allCompletions(this.index, this.language, {
      limit: DEFAULT_LIMIT,
      external: this.external(),
      snippets: snippetsForLanguage(this.snippets(), this.language),
    });
    // Заменяем слово под курсором, если оно есть: тогда подсказка встаёт вместо него.
    const prefix = prefixAt(text, column);
    this.widget.show(items, this.anchor(caret), prefix.length);
    this.askServer(prefix, caret);
    if (this.scope !== 'file') void this.extendWithProject(prefix);
  }

  /**
   * Подсказать путь внутри импорта: файлы и каталоги проекта.
   *
   * Список файлов приходит через мост (обход дерева в renderer невозможен) и
   * запоминается на несколько секунд: печатают быстрее, чем обходится дерево, а
   * созданный только что файл появится в подсказках после короткой паузы.
   */
  private async showImportPaths(context: ImportPathContext, caret: number): Promise<void> {
    const files = await this.loadProjectFiles();
    if (files.length === 0) return;
    const from = this.currentPath?.() ?? null;
    if (!from) return;
    // Пока читали список, человек мог уйти с этого места — старый ответ не к месту.
    if (this.controller.caret !== caret) return;
    const items = importPathItems(files, from, this.language, context);
    this.widget.show(items, this.anchor(caret), context.prefix.length);
  }

  /** Файлы проекта: из памяти, пока список свежий, иначе — у проекта. */
  private async loadProjectFiles(): Promise<readonly string[]> {
    const source = this.projectFiles;
    if (!source) return [];
    if (this.fileList !== null && Date.now() - this.fileListAt < FILE_LIST_TTL_MS) return this.fileList;
    const files = await source().catch(() => null);
    if (!files) return this.fileList ?? [];
    this.fileList = files;
    this.fileListAt = Date.now();
    return files;
  }

  /**
   * Дополнить обычный список объявлениями карты — так индекс питает подсказки сам.
   *
   * Список по набранному началу раньше знал только слова файла и ответ сервера: если
   * сервер молчит (не установлен, поднимается, язык ему незнаком), имя из соседнего
   * файла проекта не предлагалось вовсе, хотя карта его знает. Спрашиваем карту после
   * короткой паузы в наборе (см. `INDEX_DELAY_MS`) и только с двух знаков.
   */
  private scheduleIndex(prefix: string, caret: number): void {
    this.clearIndexTimer();
    if (!worthAskingIndex(prefix, this.projectSymbols !== undefined)) return;
    this.indexTimer = window.setTimeout(() => {
      this.indexTimer = null;
      void this.extendFromIndex(prefix, caret);
    }, INDEX_DELAY_MS);
  }

  /**
   * Добавить к списку символы карты — второй и третий уровень Ctrl+Space.
   *
   * Список уже показан (слова файла), поэтому ответ карты ДОПИСЫВАЕТСЯ к нему, а не
   * заменяет: файл остаётся первым, добавленное идёт следом с подписью, откуда взято.
   * Карта отвечает без языкового сервера и мгновенно — ждать тут нечего, но запрос
   * всё равно асинхронный, и человек успевает увидеть список до ответа.
   */
  private async extendWithProject(prefix: string): Promise<void> {
    const source = this.projectSymbols;
    if (!source) return;
    const scope = this.scope;

    const found = await source(prefix).catch(() => []);
    // Пока ходили, список могли закрыть, начать печатать или расширить ещё раз.
    if (!this.widget.isVisible || this.scope !== scope) return;
    this.appendProject(scope, found);
  }

  /**
   * Дописать в список то, что знает карта, — при обычном наборе (см. `scheduleIndex`).
   *
   * Ширина тут средняя (`project`): свои объявления проекта. Чужие из пакетов остаются
   * за третьим уровнем Ctrl+Space — при наборе они только заслонили бы нужное.
   */
  private async extendFromIndex(prefix: string, caret: number): Promise<void> {
    const source = this.projectSymbols;
    if (!source) return;

    // Только карта: серверы спрашивает `askServer`, и второй такой запрос на каждую
    // паузу в наборе был бы лишней работой.
    const found = await source(prefix, true).catch(() => []);
    // Пока карта отвечала, человек мог уйти с этого места или начать печатать другое.
    if (!this.widget.isVisible || this.controller.caret !== caret) return;
    this.appendProject('project', found);
  }

  /** Дописать найденное в карте к показанному списку, не повторяя уже видимое. */
  private appendProject(scope: CompletionScope, found: readonly ProjectCompletion[]): void {
    const items = extendItems(scope, found, new Set(this.widget.labels()));
    if (items.length === 0) return;
    this.widget.append(items);
  }

  /**
   * Подсказки-члены объекта (`this.`, `order.`): имена, которые принадлежат ему.
   *
   * Два источника, и порядок тут важнее, чем кажется. Свои члены (разбор файла)
   * показываем СРАЗУ — попап должен появляться на саму точку, без ожидания сети.
   * Языковой сервер отвечает следом и встаёт впереди: только он знает типы, поэтому
   * для `order.` он и есть настоящий ответ, а наши имена — подстраховка на случай,
   * когда сервера нет или язык ему незнаком.
   */
  private showMembers(member: MemberAccess): void {
    const caret = this.controller.caret;
    const ranked: { item: CompletionItem; score: number }[] = [];
    const taken = new Set<string>();

    // Члены приёмника из текста файла: `self.` — свои, `self.Elements.` — члены
    // НАЗВАННОГО класса (вложенного, фабрики). Работает и без сервера, и сразу.
    for (const entry of membersOf(this.textAroundCaret(), member.receiver)) {
      if (entry.name.length === 0 || taken.has(entry.name)) continue;
      // Набранное после точки совпадает с именем члена по тем же правилам, что и
      // слова в обычном списке: `gT` найдёт `getTitle` и после `this.`.
      const match = matchScore(entry.name, member.prefix);
      if (!match) continue;
      taken.add(entry.name);
      ranked.push({
        item: {
          label: entry.name,
          kind: 'word',
          detail: entry.kind === 'method' ? 'метод' : 'поле',
          positions: match.positions,
        },
        score: match.score,
      });
    }

    ranked.sort((left, right) => right.score - left.score);
    this.widget.show(
      ranked.map((entry) => entry.item),
      this.anchor(caret),
      member.replaces,
    );
    this.askServer(member.prefix, caret);
  }

  /**
   * Спросить подсказки у языкового сервера и подмешать их в уже показанный список,
   * когда ответят. Свои слова никуда не уходят: ответ сервера идёт впереди, но при
   * неудаче список остаётся прежним — молчание сервера не должно гасить подсказки.
   */
  private askServer(prefix: string, caret: number, attempt = 0, only: Expectation | null = null): void {
    this.clearRetry();
    const lsp = this.lsp;
    if (!lsp) return;
    const id = ++this.lspRequestId;
    const position = this.buffer.positionAt(caret);
    void lsp(prefix, position)
      .then((extra) => {
        // Курсор уехал или пришёл новый запрос — ответ про прежнее место не показываем.
        if (id !== this.lspRequestId || this.controller.caret !== caret) return;
        // Набранное начало проверяем и у ответа сервера: часть серверов отдаёт список
        // ЦЕЛИКОМ, полагаясь на отбор у клиента (см. `fuzzy.ts` — правила те же, что
        // и у наших слов, чтобы `gT` находил `getTitle` и у серверных подсказок).
        const local = this.widget.allItems;
        const known = new Set(local.map((item) => item.label));
        let fresh = extra.filter((item) => !known.has(item.label) && hasMatch(item, prefix));
        // «Умное» дополнение режет и ответ сервера: имена типов в позиции значения
        // бесполезны, откуда бы они ни пришли. Пусто после отбора — не повод гасить
        // список: слова файла уже показаны, и они остаются.
        if (only) fresh = filterByExpectation(fresh, only);
        if (fresh.length === 0) {
          // Пусто — сервер ещё греется. Повторяем один раз, если курсор не уехал.
          if (attempt === 0) {
            this.lspRetry = window.setTimeout(() => this.askServer(prefix, caret, 1, only), LSP_RETRY_MS);
          }
          return; // подтвердить нечего — список остаётся прежним
        }
        // Сервер впереди: он знает типы, а словарь — только имена. Оценку совпадения
        // даём подсказке сервера небольшим превышением (см. `fuzzy.ts`: EXTERNAL_BONUS).
        this.widget.show(rankServerItems(fresh, local, prefix), this.anchor(caret), prefix.length);
      })
      .catch(() => {
        // Сервера нет или он не ответил — остаются слова языка и документа.
      });
  }

  /** Снять отложенный повтор: место или файл сменились — старый запрос уже не к месту. */
  private clearRetry(): void {
    if (this.lspRetry !== null) {
      window.clearTimeout(this.lspRetry);
      this.lspRetry = null;
    }
  }

  /** Снять отложенный вопрос к карте символов: он был про прежнее место. */
  private clearIndexTimer(): void {
    if (this.indexTimer !== null) {
      window.clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
  }

  /**
   * Довести выделенную строку: спросить у сервера описание и подробность. Спрашиваем
   * по одному элементу и только раз на подпись — список открывается на каждый набор,
   * и тянуть описания сразу для всех строк значило бы заваливать сервер запросами.
   */
  private async resolveItem(item: CompletionItem): Promise<void> {
    const resolve = this.resolve;
    if (!resolve || item.resolve === undefined) return;
    if (this.resolveRequested.has(item.label)) return;
    this.resolveRequested.add(item.label);
    const done = await resolve(item.resolve).catch(() => null);
    if (!done) return;
    // Список мог смениться, пока ждали ответ: `patch` сам не найдёт строку — это не ошибка.
    this.widget.patch(item, {
      ...(done.detail ? { detail: done.detail } : {}),
      ...(done.documentation ? { documentation: done.documentation } : {}),
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

    // Авто-импорт: у подсказки бывают дополнительные правки (обычно строка import).
    // Применяем их ВМЕСТЕ со вставкой, одним шагом истории: иначе Ctrl+Z убирал бы их
    // по отдельности, а смещения пришлось бы считать дважды.
    const extra = this.additionalChanges(item);
    if (extra.length > 0) {
      const expanded = item.snippet !== undefined ? expandSnippet(item.snippet) : null;
      const inserted = expanded ? expanded.text : (item.insert ?? item.label);
      const changes = [...extra, { start, removed, inserted }].sort((l, r) => r.start - l.start);
      // Правки выше вставки удлиняют текст перед ней — на столько же сдвинется курсор.
      let shift = 0;
      for (const change of changes) if (change.start < start) shift += change.inserted.length - change.removed.length;
      const anchor = start + shift + (expanded ? expanded.caret : inserted.length);
      const active = start + shift + (expanded ? expanded.selectionEnd : inserted.length);
      this.controller.applyEdits(changes, { anchor, active });
      return;
    }

    // Сниппет раскрывается ПОСЛЕ вставки: разметка `${1:…}` в тексте не остаётся, а
    // курсор встаёт на первое место — так же ведёт себя вставка сниппета.
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

  /** Дополнительные правки подсказки (авто-импорт) в смещениях текущего буфера. */
  private additionalChanges(item: CompletionItem): { start: number; removed: string; inserted: string }[] {
    const edits = item.additionalEdits;
    if (!edits || edits.length === 0) return [];
    const changes: { start: number; removed: string; inserted: string }[] = [];
    for (const edit of edits) {
      const from = this.buffer.offsetAt({ line: edit.startLine, column: edit.startColumn });
      const to = this.buffer.offsetAt({ line: edit.endLine, column: edit.endColumn });
      changes.push({ start: from, removed: this.buffer.getText(from, to), inserted: edit.newText });
    }
    return changes;
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

  /**
   * Текст вокруг курсора — для разбора членов класса. Берём окно, а не файл целиком:
   * подсказка идёт на каждое нажатие после точки, и собирать ради неё весь текст
   * большого файла незачем. Класс целиком в окно помещается с большим запасом.
   */
  private textAroundCaret(): string {
    const line = this.buffer.lineAt(this.controller.caret);
    const from = Math.max(1, line - WORDS_AROUND);
    const to = Math.min(this.buffer.lineCount, line + WORDS_AROUND);
    const lines: string[] = [];
    for (let current = from; current <= to; current += 1) lines.push(this.buffer.lineText(current));
    return lines.join('\n');
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

/**
 * Совпадает ли подсказка с набранным — по тем же правилам, что и слова (см. `fuzzy.ts`),
 * но с учётом `filterText`: у CamelCase-серверов он не равен подписи, и фильтр по
 * подписи терял бы верные ответы.
 */
function hasMatch(item: CompletionItem, prefix: string): boolean {
  if (prefix.length === 0) return true;
  return matchScore(item.filterText ?? item.label, prefix) !== null;
}

/**
 * Собрать список к показу: подсказки сервера — с надбавкой к оценке (он знает типы),
 * затем — наши слова в том порядке, в каком их собрал `buildCompletions`. Простое
 * «серверные сверху, наши следом» ломало бы релевантность: хорошее наше имя уезжало
 * под слабую серверную подсказку.
 */
function rankServerItems(
  fresh: readonly CompletionItem[],
  local: readonly CompletionItem[],
  prefix: string,
): CompletionItem[] {
  const scored = [
    ...fresh.map((item) => ({
      item,
      score: (matchScore(item.filterText ?? item.label, prefix)?.score ?? 0) + EXTERNAL_BONUS,
    })),
    ...local.map((item) => ({ item, score: matchScore(item.label, prefix)?.score ?? 0 })),
  ];
  return scored.sort((left, right) => right.score - left.score).map((entry) => entry.item);
}

/** Знак перед кареткой: им узнаём набранный знак-триггер сервера (`@`, `:`). */
function charBefore(buffer: TextBuffer, caret: number): string {
  return caret > 0 ? buffer.getText(caret - 1, caret) : '';
}
