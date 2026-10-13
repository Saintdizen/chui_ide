/**
 * Хозяин своего редактора: собирает слои в одно рабочее место.
 *
 * До этого модуля слои жили порознь, и связывал их тот, кто создавал редактор (проба,
 * тесты). Хозяин берёт эту связку на себя и делает то, чего у слоёв нет по отдельности:
 *
 *   • открывает файл — берёт буфер из реестра и раздаёт его ВСЕМ слоям разом: и тексту,
 *     и подсветке, и панелям, и подсказкам. Забыть хоть один — и слой будет смотреть на
 *     прошлый документ: панель поиска искала бы в старом файле, а подсказки предлагали бы
 *     слова из него же;
 *   • держит позицию курсора по файлам — её просит и возвращает сессия проекта;
 *   • проталкивает правки извне (ассистент, языковой сервер) в буфер и документ;
 *   • следит, чтобы текст из буфера уходил в документ: тот — истина о содержимом, и по
 *     нему считается «грязность» вкладки и сохранение.
 *
 * Границей хозяин повторяет `core/editor-api.ts` — тот интерфейс, которым редактор
 * пользуется в остальном renderer: имена методов и событий те же, поэтому потребители
 * (ассистент, сессия, проверка импортов) про подмену движка не знают.
 *
 * Модуль браузерный: он собирает узлы и слушает ввод. Проверяется он живой пробой, а не
 * тестами без окна — как и остальные слои вида.
 */

import type { CursorPosition, LspDiagnostic } from '../../../shared/api';
import type { TextEdit } from '../../../shared/edits';
import type { FoldRange } from '../../../shared/fold-ranges';
import type { GitLineChange } from '../../../shared/git-line-changes';
import type { CodeLensCommand, CodeLensEntry } from '../../../shared/lsp-code-lens';
import type { SignatureHelp } from '../../../shared/lsp-signature';
import type { InlayHint } from '../../../shared/lsp-inlay-hints';
import type { RunnableTest } from '../../../shared/python-tests';
import type { Snippet } from '../../../shared/snippets';
import type { TestOutcome } from '../../../shared/test-model';
import type { BreakpointInput } from '../../core/debug';
import type { TextDocument } from '../../core/document';
import { Emitter } from '../../core/events';
import { CompletionAssistant } from '../complete/assistant';
import type { CompletionItem } from '../complete/completions';
import { SignatureAssistant } from '../complete/signature';
import { TextBuffer } from '../core/text-buffer';
import { wordAt } from '../core/graphemes';
import type { Scheme } from '../highlight/style';
import { type EditorChange, EditorController } from '../input/editor-controller';
import { type CommandName, EditorInputBinding, type KeyInterceptor } from '../input/editor-input';
import type { CaseStyle } from '../input/case-convert';
import { blockCommentFor, lineCommentFor } from '../input/comments';
import { InlineCompletions } from '../input/inline-completions';
import { EditorView } from '../view/editor-view';
import { normalizeWhitespaceMode, type WhitespaceMode } from '../view/whitespace';
import { caret, isEmpty, type Selection } from '../view/selection';
import { FileDecorations, type LensDecoration } from '../view/decorations';
import { FindWidget } from '../widgets/find-widget';
import { GotoLineWidget } from '../widgets/goto-widget';
import { HoverWidget, type HoverExternalInfo } from '../widgets/hover-widget';
import { LocationsWidget } from '../widgets/locations-widget';
import { SignatureWidget } from '../widgets/signature-widget';
import { SuggestWidget } from '../widgets/suggest-widget';
import type { DocumentRegistry } from './document-registry';
import { translateEdits, type TranslatedEdits } from './document-edits';
import { breakpointGlyphClass, breakpointTooltip, changeGutterTooltip, testGlyphTooltip } from './gutter-marks';
import { SymbolNavigation, type SymbolSource } from './symbol-navigation';

/** Пауза перед пересчётом диапазонов свёртки: на каждое нажатие считать блоки незачем. */
const FOLD_REFRESH_DELAY_MS = 300;

/** Пауза перед перезапросом подсказок-вставок: типы и имена меняются не на каждую букву. */
const INLAY_REFRESH_DELAY_MS = 500;

/** Пауза перед перезапросом код-линз по правке: сервер спрашиваем не на каждую букву. */
const LENS_REFRESH_DELAY_MS = 400;

/** Нажали на значок запуска в жёлобе — этот файл и строку и просят выполнить. */
export interface RunMarkerHit {
  path: string;
  line: number;
}

/** Нажали на полоску изменения в жёлобе — файл и строка этой полоски. */
export interface ChangeMarkerHit {
  path: string;
  line: number;
}

/** Нажали на значок у теста — просят запустить именно его. */
export interface TestMarkerHit {
  path: string;
  line: number;
  /** Селектор pytest из разбора файла: `файл::Класс::тест`. */
  selector: string;
  name: string;
}

/** Что редактор знает о месте правого клика: приложению этого хватает для меню. */
export interface EditorContextInfo {
  /** Файл панели (`null` — ничего не открыто). */
  path: string | null;
  /** Место под кликом (1-based). */
  line: number;
  column: number;
  /** Есть ли выделение и его текст — от этого зависит доступность «вырезать»/«копировать». */
  hasSelection: boolean;
  selectedText: string;
  canUndo: boolean;
  canRedo: boolean;
}

/** Что изменилось с курсором: файл, позиция и сколько выделений (у нас всегда одно). */
export interface CursorState {
  path: string | null;
  line: number;
  column: number;
  selections: number;
}

/**
 * Запись покрытия одного файла: путь, непокрытые строки и (если отчёт их дал) строки
 * с наполовину пройденной ветвью. Путь — абсолютный: редактор ключует файлы так.
 */
export type CoverageEntry = readonly [path: string, missing: readonly number[], partial?: readonly number[]];

export interface EditorHostOptions {
  /** Сколько пробелов в шаге отступа (Tab). */
  tabSize?: number;
  /** Кегль текста в редакторе, px. */
  fontSize?: number;
  /** Столбцы направляющих (ruler): вертикальные черты на этих столбцах. */
  rulers?: readonly number[];
  /** Показывать ли невидимые знаки: `none` (по умолчанию), `trailing` или `all`. */
  whitespace?: WhitespaceMode;
  /** Показывать ли миникарту — сжатый вид всего файла справа. */
  minimap?: boolean;
  /** Переносить ли длинные строки (word wrap). */
  wordWrap?: boolean;
  /** Включать ли лигатуры шрифта. */
  ligatures?: boolean;
  /**
   * Подсказки-вставки файла (inlay hints) от языкового сервера: путь и текст → подсказки
   * (см. `shared/lsp-inlay-hints.ts`). Не задано — подсказок в коде нет вовсе.
   */
  inlayHints?: (path: string, text: string) => Promise<readonly InlayHint[]>;
  /** Схема оформления: цвета токенов и обвязки. */
  scheme?: Scheme;
  /** Сниппеты всех языков: к текущему языку отберёт подсказка. */
  snippets?: () => readonly Snippet[];
  /**
   * Наведение от языкового сервера: путь и позиция (1-based) → текст разметки.
   * Не задано — показывается только то, что видно в файле (см. `hover-widget.ts`).
   */
  hoverFromLanguage?: (path: string, position: { line: number; column: number }) => Promise<HoverExternalInfo | null>;
  /**
   * Подсказки языкового сервера: путь и позиция (1-based) → дополнения. Не задано —
   * подсказки только из слов языка, документа и сниппетов.
   */
  completionFromLanguage?: (
    path: string,
    position: { line: number; column: number },
  ) => Promise<readonly CompletionItem[]>;
  /**
   * Подсказка о параметрах вызова от языкового сервера: путь и позиция (1-based) → разбор
   * (см. `shared/lsp-signature.ts`). Не задано — карточки о параметрах нет вовсе.
   */
  signatureFromLanguage?: (path: string, position: { line: number; column: number }) => Promise<SignatureHelp | null>;
  /**
   * Источник мест символа — языковой сервер (см. `LspFeatures`). Не задан — перехода к
   * определению и ссылок у панели не будет вовсе: показывать нечего и открывать некуда.
   */
  symbols?: SymbolSource;
  /** Перейти к месту: открыть файл и поставить курсор. Дело приложения, не панели. */
  revealLocation?: (path: string, line: number, column: number) => void;
  /** Короткий путь для подписи места в списке (в приложении — относительный). */
  relativePath?: (path: string) => string;
  /**
   * Сообщить человеку, что мест не нашлось (в приложении — всплывающая весточка).
   */
  onNotice?: (text: string) => void;
  /**
   * Отладочная подсказка: слово под курсором и место → текст из остановленного кадра.
   * Приоритетнее наведения от языкового сервера: во время останова именно значение
   * переменной и нужно. Не задано — подсказки об остановленном кадре нет.
   */
  debugHover?: (word: string, at: { path: string; line: number }) => Promise<HoverExternalInfo | null>;
  /** F1 — открыть палитру команд. Не задано — F1 в редакторе может только гаситься. */
  openPalette?: () => void;
  /**
   * Правый клик по тексту: приложение показывает своё меню. Шов, потому что пункты
   * меню — это команды приложения (отмена, буфер обмена, поиск, переходы), а не
   * знание панели.
   */
  contextMenu?: (info: EditorContextInfo, event: MouseEvent) => void;
  /**
   * Быстрые исправления под курсором (Ctrl+.): показать список действий языка. Дело
   * приложения — у него и попапы, и языковой сервер, и документная модель для правок.
   */
  codeActions?: (path: string, position: { line: number; column: number }) => void;
  /**
   * Диапазоны свёртки файла: у языкового сервера спрашивает приложение, а без сервера
   * их считают по отступам. Не задано — свёртки нет вовсе (и значков в жёлобе тоже).
   */
  foldRanges?: (path: string, text: string) => Promise<readonly FoldRange[]>;
  /**
   * Код-линзы файла от языкового сервера: путь и текст → подписи у строк (см.
   * `shared/lsp-code-lens.ts`). Не задано — линз нет вовсе.
   */
  codeLenses?: (path: string, text: string) => Promise<readonly CodeLensEntry[]>;
  /** Исполнить команду линзы: её выбирает сервер, а запускает приложение. */
  lensCommand?: (path: string, command: CodeLensCommand) => void;
  /**
   * Inline-подсказка «допиши за меня»: включение, задержка и запрос к модели. Не задана —
   * призрачного текста в панели нет вовсе (у Monaco это был его провайдер подсказок).
   */
  inlineCompletion?: {
    enabled(): boolean;
    debounceMs(): number;
    /** Контекст вокруг курсора → готовый текст. `null`/пусто — подсказки нет. */
    complete(request: { path: string; language: string; prefix: string; suffix: string }): Promise<string | null>;
  };
}

/**
 * Рабочее место редактора: одна панель, один открытый файл.
 *
 * Буферов хозяин не держит — их берёт из реестра (`document-registry.ts`) по пути. Так
 * один файл, открытый в двух панелях, остаётся одним текстом, и правка видна в обеих.
 */
export class EditorHost {
  private readonly registry: DocumentRegistry;
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private readonly input: EditorInputBinding;
  private readonly find: FindWidget;
  private readonly goto: GotoLineWidget;
  private readonly hover: HoverWidget;
  private readonly assistant: CompletionAssistant;
  private readonly suggest: SuggestWidget;
  /** Подсказка о параметрах вызова. `null` — источника нет, карточки не будет. */
  private readonly signature: SignatureAssistant | null;
  /** Список мест (определения, ссылки). `null` — источника нет, показывать нечего. */
  private readonly locations: LocationsWidget | null;
  /** Связка «сервер → решение → попап». `null` вместе с источником. */
  private readonly navigation: SymbolNavigation | null;
  /** Подсказка «допиши за меня». `null` — источника нет, призрачного текста не будет. */
  private readonly inline: InlineCompletions | null;
  /** Язык открытого файла: нужен подсказке и подсветке. */
  private languageId = 'plaintext';
  /**
   * Чем открывается палитра команд (F1). Отдельным полем, а не в опциях: панель
   * создаётся раньше, чем палитра готова, и опцию ставит `openPaletteOnF1` позже.
   */
  openPalette: (() => void) | null = null;
  /** Правый клик по тексту: приложение показывает своё меню (см. `EditorContextInfo`). */
  private readonly contextMenu: ((info: EditorContextInfo, event: MouseEvent) => void) | undefined;
  /** Быстрые исправления: список показывает приложение (см. `codeActions` в опциях). */
  private readonly codeActions: ((path: string, position: { line: number; column: number }) => void) | undefined;
  /** Диапазоны свёртки — от приложения (языковой сервер или отступы). */
  private readonly foldRanges: ((path: string, text: string) => Promise<readonly FoldRange[]>) | undefined;
  /** Номер запроса диапазонов свёртки: ответ на прежний текст не показываем. */
  private foldRequestId = 0;
  /** Пауза перед пересчётом свёртки по правке: на каждое нажатие считать незачем. */
  private foldTimer: number | null = null;

  /** Подсказки-вставки (inlay hints) — источник от приложения; спрашиваем по файлу. */
  private readonly inlayHintSource: ((path: string, text: string) => Promise<readonly InlayHint[]>) | undefined;
  /** Номер запроса подсказок: ответ на прежний текст не показываем. */
  private inlayRequestId = 0;
  private inlayTimer: number | null = null;

  /** Код-линзы — от приложения (языковой сервер): источник, исполнение и последний ответ. */
  private readonly codeLensSource: ((path: string, text: string) => Promise<readonly CodeLensEntry[]>) | undefined;
  private readonly lensCommand: ((path: string, command: CodeLensCommand) => void) | undefined;
  /** Последний ответ по файлам: рисуем из него, а команду на клик ищем здесь же. */
  private readonly codeLenses = new Map<string, readonly CodeLensEntry[]>();
  private lensRequestId = 0;
  private lensTimer: number | null = null;

  /** Поле прокрутки: на нём слушаем Ctrl+Click по слову (переход к определению). */
  private readonly viewport: HTMLElement | null;

  private scheme: Scheme;
  private path: string | null = null;
  /** Открытый файл — только для чтения (большой файл): ввод и правки не проходят. */
  private readOnly = false;
  /** Значок «только чтение» над панелью: виден, когда файл большой. */
  private readonly readOnlyBadge: HTMLElement;
  /** Куда стоял курсор в каждом файле — восстанавливается при возврате к файлу. */
  private readonly cursors = new Map<string, CursorPosition>();
  private readonly cursorEmitter = new Emitter<CursorState>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeBuffer: () => void;
  private readonly changeTextEmitter = new Emitter<void>();

  /** Курсор переехал или файл сменился — по этому событию обновляют статус-бар и сессию. */
  readonly onDidCursor = this.cursorEmitter.event;

  /** Текст в этой панели изменился: по этому событию соседняя панель перерисовывается. */
  readonly onDidChangeText = this.changeTextEmitter.event;

  // — украшения —

  /**
   * Готовые украшения по файлам: рисуем из них, а не из сырых данных. Отдельный набор
   * на файл — потому что данные приходят для всех открытых файлов (полоски git, покрытие),
   * а рисуется всегда один; файл за кадром ждёт своей очереди в `open`.
   */
  private readonly decorations = new Map<string, FileDecorations>();
  private readonly lineChanges = new Map<string, readonly GitLineChange[]>();
  private readonly runLines = new Map<string, Set<number>>();
  private readonly testMarkers = new Map<string, readonly RunnableTest[]>();
  private testOutcomes: ReadonlyMap<string, TestOutcome> = new Map();
  private readonly breakpoints = new Map<string, readonly BreakpointInput[]>();
  /** Строки закладок по файлам: список ведёт приложение, редактор только рисует значки. */
  private readonly bookmarks = new Map<string, readonly number[]>();
  private readonly coverageLines = new Map<string, ReadonlySet<number>>();
  /**
   * Строки, где ветвь условия пройдена лишь наполовину: часть дуг исполнена, часть
   * нет. Отдельно от непокрытых строк — это разная тяжесть, и видеть их надо по-разному.
   */
  private readonly coveragePartial = new Map<string, ReadonlySet<number>>();
  private blameLine: { path: string; line: number; text: string } | null = null;
  private readonly blameAll = new Map<string, readonly { line: number; text: string }[]>();
  private debugLine: { path: string; line: number } | null = null;
  /** Пометки языкового сервера по файлам: рисуем волнистым подчёркиванием. */
  private readonly externalMarkers = new Map<string, readonly LspDiagnostic[]>();

  /** Просьба запустить файл со значка в поле значков. */
  private readonly runMarkerEmitter = new Emitter<RunMarkerHit>();
  readonly onRunMarker = this.runMarkerEmitter.event;

  /** Клик по полю значков: включить или выключить точку останова на строке. */
  private readonly breakpointEmitter = new Emitter<RunMarkerHit>();
  readonly onBreakpointToggle = this.breakpointEmitter.event;

  /** Правый клик по значку точки останова: меню (условие, удаление). */
  private readonly breakpointMenuEmitter = new Emitter<RunMarkerHit>();
  readonly onBreakpointMenu = this.breakpointMenuEmitter.event;

  /** Левый клик по значку закладки (когда на строке нет ничего важнее): снять её. */
  private readonly bookmarkEmitter = new Emitter<RunMarkerHit>();
  readonly onBookmarkToggle = this.bookmarkEmitter.event;

  /** Клик по значку у объявления теста — запустить именно этот тест. */
  private readonly testMarkerEmitter = new Emitter<TestMarkerHit>();
  readonly onTestMarker = this.testMarkerEmitter.event;

  /** Клик по полоске изменения в жёлобе — открыть различие этой строки. */
  private readonly changeMarkerEmitter = new Emitter<ChangeMarkerHit>();
  readonly onChangeMarker = this.changeMarkerEmitter.event;

  /** Правый клик по полоске изменения — меню блока: индексировать, убрать, откатить. */
  private readonly changeStripMenuEmitter = new Emitter<ChangeMarkerHit>();
  readonly onChangeStripMenu = this.changeStripMenuEmitter.event;

  constructor(container: HTMLElement, registry: DocumentRegistry, options: EditorHostOptions = {}) {
    this.registry = registry;
    this.scheme = options.scheme ?? 'dark';
    this.openPalette = options.openPalette ?? null;
    this.contextMenu = options.contextMenu;
    this.codeActions = options.codeActions;
    this.foldRanges = options.foldRanges;
    this.codeLensSource = options.codeLenses;
    this.lensCommand = options.lensCommand;
    this.inlayHintSource = options.inlayHints;

    // До первого `open` редактор держит пустой буфер: слои не терпят «нет документа», а
    // пустая вкладка — нормальное состояние панели, пока файл не открыт.
    const buffer = new TextBuffer('');
    this.view = new EditorView(container, buffer, {
      scheme: this.scheme,
      whitespace: normalizeWhitespaceMode(options.whitespace),
      minimap: options.minimap,
      ligatures: options.ligatures,
    });
    this.view.setWordWrap(options.wordWrap === true);
    if (options.fontSize !== undefined) this.view.setFontSize(options.fontSize);
    if (options.rulers) this.view.setRulers(options.rulers);
    this.viewport = this.view.element.querySelector<HTMLElement>('.own-editor-viewport');
    // Значок «только чтение» — поверх панели: файл большой, правки в нём выключены.
    this.readOnlyBadge = document.createElement('div');
    this.readOnlyBadge.className = 'own-editor-readonly';
    this.readOnlyBadge.textContent = 'Только чтение';
    this.readOnlyBadge.title = 'Файл слишком большой для правки — открыт только для чтения';
    this.readOnlyBadge.hidden = true;
    container.append(this.readOnlyBadge);
    this.controller = new EditorController(buffer, { tabSize: options.tabSize });
    this.find = new FindWidget(this.view, this.controller, buffer);
    this.goto = new GotoLineWidget(this.view, this.controller, buffer);
    this.suggest = new SuggestWidget(container);
    this.assistant = new CompletionAssistant(this.view, this.controller, buffer, this.suggest, {
      snippets: options.snippets,
      // Подсказки сервера: путь берём активный — панель о нём знает, ассистент нет.
      lsp: options.completionFromLanguage
        ? (_prefix, position) => {
            const path = this.activePath;
            return path ? options.completionFromLanguage!(path, position) : Promise.resolve([]);
          }
        : undefined,
    });
    this.hover = new HoverWidget(this.view, buffer, {
      // Порядок источников = приоритет: отладочная подсказка важнее языковой (во время
      // останова нужно значение переменной, а не тип из сервера).
      sources: [
        ...(options.debugHover ? [async (offset: number) => this.debugHoverAt(options.debugHover!, offset)] : []),
        ...(options.hoverFromLanguage
          ? [
              async (offset: number) => {
                const path = this.activePath;
                if (!path) return null;
                const position = this.controller.bufferRef.positionAt(offset);
                return options.hoverFromLanguage!(path, position);
              },
            ]
          : []),
      ],
    });

    // Подсказка о параметрах вызова: карточка у каретки. Есть только когда дан источник —
    // сигнатуру своей грамматикой не вывести (см. `complete/signature.ts`).
    this.signature = options.signatureFromLanguage
      ? new SignatureAssistant(this.view, this.controller, buffer, new SignatureWidget(container), {
          source: (path, position) => options.signatureFromLanguage!(path, position),
          path: () => this.activePath,
        })
      : null;

    // Список мест (определения, ссылки). Есть только когда дан источник: без языкового
    // сервера переходить некуда, и попап не нужен.
    this.locations = options.symbols ? new LocationsWidget(container) : null;
    this.navigation = options.symbols
      ? new SymbolNavigation({
          source: options.symbols,
          widget: this.locations!,
          anchor: () => this.caretAnchor(),
          reveal: (target) => options.revealLocation?.(target.path, target.line, target.column),
          label: (target) => (options.relativePath ?? ((path: string) => path))(target.path),
          notice: (text) => options.onNotice?.(text),
          position: () => {
            const position = this.cursorPosition();
            return { path: this.path, line: position.line, column: position.column };
          },
        })
      : null;

    // Подсказка «допиши за меня»: призрачный текст у каретки. Есть только когда дан
    // источник (запрос к модели) — иначе спрашивать нечего.
    const inlineSource = options.inlineCompletion;
    this.inline = inlineSource
      ? new InlineCompletions(this.view, this.controller, {
          enabled: () => inlineSource.enabled(),
          debounceMs: () => inlineSource.debounceMs(),
          complete: (prefix, suffix) =>
            inlineSource.complete({ path: this.path ?? '', language: this.languageId, prefix, suffix }),
        })
      : null;

    // Ввод: панели показывает вызывающий, клавишу первыми забирают попапы (подсказки,
    // список мест, призрачный текст). Подсказки идут первыми: их список обычно открыт
    // во время набора, а призрачный текст — после паузы, когда списка уже нет.
    const interceptors: KeyInterceptor[] = [this.assistant];
    if (this.signature) interceptors.push(this.signature);
    if (this.navigation) interceptors.push(this.navigation);
    if (this.inline) interceptors.push(this.inline);
    this.input = new EditorInputBinding(this.view, this.controller, {
      onCommand: (command) => this.runCommand(command),
      interceptors,
      // Язык: по нему ввод выбирает знак комментария для Ctrl+/.
      language: () => this.languageId,
    });
    // После закрытия панели фокус возвращается в текст: работа продолжается там.
    this.find.onClose = () => this.input.focus();
    this.goto.onClose = () => this.input.focus();
    // Ctrl+Click по слову — переход к определению (жест, который у Monaco делал его
    // обработчик открытия). Слушаем в фазе захвата: иначе ввод успеет начать выделение.
    this.viewport?.addEventListener('mousedown', this.onViewMouseDown, true);

    this.unsubscribe = this.controller.onChange((change) => this.onControllerChange(change));
    // Внешняя замена буфера (диск, форматирование, правки агента) прошла мимо контроллера:
    // текст на экране устарел, и о ней надо перерисовать самим.
    const bufferSubscription = this.registry.onDidChangeBuffer((path) => this.onExternalBufferChange(path));
    this.unsubscribeBuffer = () => bufferSubscription.dispose();
    this.bindDecorationClicks();
    this.emitCursor();
  }

  /** Корень редактора — для вставки в макет панели. */
  get element(): HTMLElement {
    return this.view.element;
  }

  /** Путь открытого файла (`null` — панель пуста). */
  get activePath(): string | null {
    return this.path;
  }

  /** Текущее состояние курсора — активный файл берётся «живьём». */
  get cursorState(): CursorState {
    if (!this.path) return { path: null, line: 1, column: 1, selections: 1 };
    const position = this.cursorPosition();
    return { path: this.path, line: position.line, column: position.column, selections: 1 };
  }

  /**
   * Открыть файл в панели.
   *
   * Порядок важен: сперва всем слоям выдаём НОВЫЙ буфер, и только потом контроллер
   * объявляет выделение. Объявление — событие, на которое слои откликаются; к этому
   * моменту они уже должны смотреть на открытый документ, иначе подсказки и панели
   * отреагируют на чужой текст.
   */
  open(document: TextDocument, position?: CursorPosition): void {
    const buffer = this.registry.resolve(document);

    // Покидая файл, запоминаем, где стоял курсор: вернувшись, человек ждёт то же место.
    if (this.path && this.path !== document.path) this.cursors.set(this.path, this.cursorPosition());

    const target = position ?? this.cursors.get(document.path);
    const selection: Selection = target ? selectionAt(buffer, target) : caret(0);

    this.view.setBuffer(buffer);
    this.find.setBuffer(buffer);
    this.goto.setBuffer(buffer);
    this.hover.setBuffer(buffer);
    this.assistant.setBuffer(buffer);
    this.signature?.setBuffer(buffer);
    // Подсветку и слова подсказок берём по языку документа: один реестр языков на всё.
    // Языка без грамматики это не смущает — текст покажется простым (см. registry.ts).
    this.view.setLanguage(document.languageId);
    this.assistant.setLanguage(document.languageId);
    this.languageId = document.languageId;
    // Призрачная подсказка говорила о прошлом файле — к новому она не относится.
    this.inline?.setBuffer();

    this.path = document.path;
    // Большой файл открывается только для чтения: значок говорит об этом человеку, а
    // контроллер в таком файле не даёт править текст (см. `setReadOnly`).
    this.readOnly = document.readOnly;
    this.controller.setReadOnly(document.readOnly);
    this.readOnlyBadge.hidden = !document.readOnly;
    if (document.readOnly) {
      // Такой файл в языковой сервер не отдаём (см. `core/lsp.ts`), поэтому серверные
      // украшения для него не запрашиваем — и снимаем те, что остались от прошлого файла.
      this.view.setFoldRanges([]);
      this.view.setInlayHints([]);
      this.codeLenses.delete(document.path);
    }
    this.controller.setBuffer(buffer, selection);
    // Нарисовать украшения именно этого файла: у прежнего они свои (его полоски git,
    // его точки останова) и в новом показываться не должны.
    this.refreshDecorations(document.path);
    if (!document.readOnly) {
      // Свёртка — тоже про файл: диапазоны нового берём у сервера или считаем по отступам.
      void this.refreshFolds();
      // Код-линзы, как и свёртка, про конкретный файл: прежние к новому не относятся.
      void this.refreshLenses();
      // Подсказки-вставки — тоже про файл: у прежнего они свои.
      void this.refreshInlayHints();
    }
    this.input.focus();
    this.emitCursor();
  }

  /**
   * Правки извне — ассистент, языковой сервер. Переводим позиции LSP в смещения буфера и
   * применяем ОДНИМ шагом истории: отмена должна вернуть всё разом.
   *
   * Открытый файл правит контроллер (тогда правка попадает в историю и в документ), а
   * файл за кадром — прямо в буфер и в документ: история нужна там, где человек печатает.
   */
  applyEdits(document: TextDocument, edits: readonly TextEdit[]): TranslatedEdits {
    // Файл только для чтения правок не принимает — ни от ассистента, ни от сервера.
    if (document.readOnly) return { changes: [], skipped: [] };
    const buffer = this.registry.resolve(document);
    const translated = translateEdits(buffer, edits);
    if (translated.changes.length === 0) return translated;

    if (this.path === document.path) {
      this.controller.applyEdits(translated.changes);
    } else {
      for (const change of translated.changes) {
        buffer.replace(change.start, change.removed.length, change.inserted);
      }
      this.registry.push(document.path);
    }
    return translated;
  }

  /**
   * Позиции курсоров по файлам — их берёт сессия проекта. Активный файл читаем «живьём»:
   * его позиция могла измениться не через событие (например, переходом).
   */
  cursorPositions(): Record<string, CursorPosition> {
    const result: Record<string, CursorPosition> = {};
    for (const [path, position] of this.cursors) result[path] = position;
    if (this.path) result[this.path] = this.cursorPosition();
    return result;
  }

  /** Поставить позиции курсоров из сессии. Хозяин подхватит их при открытии файла. */
  restoreCursorPositions(positions: Record<string, CursorPosition>): void {
    this.cursors.clear();
    for (const [path, position] of Object.entries(positions)) this.cursors.set(path, position);
  }

  /** Перейти к строке и столбцу. Файл за кадром — лишь запоминаем позицию до открытия. */
  reveal(path: string, line: number, column: number): void {
    if (this.path !== path) {
      this.cursors.set(path, { line, column });
      return;
    }
    const offset = this.controller.bufferRef.offsetAt({ line, column });
    this.controller.selectRange(offset, offset);
    this.view.revealOffset(offset);
    this.input.focus();
  }

  /** Текст выделенного участка — для копирования. Пустая строка, если выделения нет. */
  selectedText(): string {
    return this.controller.selectedText();
  }

  /**
   * Вставка текста в курсор. Идёт обычной правкой контроллера: так она попадает в
   * историю (Ctrl+Z) и уходит в документ, как набранный руками текст.
   */
  insertAtCursor(text: string): boolean {
    if (!this.path) return false;
    this.controller.type(text);
    this.input.focus();
    return true;
  }

  /** Позиция курсора прямо сейчас: нужна команде «точка останова на строке». */
  cursor(): { line: number; column: number } {
    return this.cursorPosition();
  }

  /**
   * Перерисовать по текущему буферу. Нужно, когда текст изменила ДРУГАЯ панель: буфер
   * у панелей общий (его держит реестр), а перерисоваться сама она не догадается.
   */
  refreshText(): void {
    this.view.refresh();
  }

  /**
   * Буфер заменили снаружи (диск, форматирование, агент). Правка прошла мимо контроллера,
   * поэтому вид надо перерисовать, а курсор — прижать к новому тексту: прежнее смещение
   * после полной замены уже ничего не значит.
   */
  private onExternalBufferChange(path: string): void {
    if (this.path !== path) return;
    const buffer = this.registry.get(path);
    if (!buffer) return;
    this.view.refresh();
    const caret = Math.min(this.controller.caret, buffer.length);
    this.controller.setSelection({ anchor: caret, active: caret }, false);
    this.view.setSelection(this.controller.selection);
  }

  /** Настройки редактора, влияющие на вид: ширина отступа (Tab) и кегль текста. */
  applyOptions(options: {
    tabSize?: number;
    fontSize?: number;
    rulers?: readonly number[];
    whitespace?: WhitespaceMode;
    minimap?: boolean;
    wordWrap?: boolean;
    ligatures?: boolean;
  }): void {
    if (options.tabSize !== undefined) {
      this.controller.setTabSize(options.tabSize);
      this.view.setTabSize(options.tabSize);
    }
    if (options.fontSize !== undefined) this.view.setFontSize(options.fontSize);
    if (options.rulers !== undefined) this.view.setRulers(options.rulers);
    if (options.whitespace !== undefined) this.view.setWhitespace(normalizeWhitespaceMode(options.whitespace));
    if (options.minimap !== undefined) this.view.setMinimap(options.minimap);
    if (options.wordWrap !== undefined) this.view.setWordWrap(options.wordWrap);
    if (options.ligatures !== undefined) this.view.setLigatures(options.ligatures);
  }

  /** Текущий текст файла по буферу (`null` — файл в реестре не открыт). */
  currentText(path: string): string | null {
    return this.registry.get(path)?.text ?? null;
  }

  /** Сменить схему оформления: цвета токенов переставляются на слое вида. */
  setScheme(scheme: Scheme): void {
    this.scheme = scheme;
    this.view.setScheme(scheme);
  }

  /** Поставить фокус в редактор — после команд палитры и переходов. */
  focus(): void {
    this.input.focus();
  }

  // — команды —
  // Публичные обёртки над контроллером и панелями: по ним палитра зовёт действия
  // редактора, не зная ни про контроллер, ни про попапы (см. `editor-commands.ts`).

  undo(): void {
    this.controller.undo();
  }

  redo(): void {
    this.controller.redo();
  }

  selectAll(): void {
    this.controller.selectAll();
    this.input.focus();
  }

  /**
   * Буфер обмена из меню. С клавиш копирование идёт событиями copy/cut/paste, а у
   * пункта меню такого события нет — поле ввода в этот момент не имеет нативного
   * выделения, поэтому кладём и читаем текст сами (navigator.clipboard).
   */
  copyToClipboard(): void {
    const text = this.controller.selectedText();
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
    this.input.focus();
  }

  cutToClipboard(): void {
    const text = this.controller.cutSelection();
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined);
    this.input.focus();
  }

  pasteFromClipboard(): void {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) this.controller.paste(text);
      })
      .catch(() => undefined);
    this.input.focus();
  }

  indent(): void {
    this.controller.indent();
  }

  outdent(): void {
    this.controller.outdent();
  }

  /** Ctrl+/ — закомментировать или расскомментировать строки. Знак — по языку файла. */
  toggleComment(): void {
    const token = lineCommentFor(this.languageId);
    if (token) this.controller.toggleComment(token);
  }

  /** Alt+↑/↓ — перенести строку или строки выделения выше или ниже. */
  moveLines(direction: -1 | 1): void {
    this.controller.moveLines(direction);
  }

  /** Shift+Alt+↓ — скопировать строку или строки выделения ниже. */
  copyLinesDown(): void {
    this.controller.copyLinesDown();
  }

  /** Shift+Alt+A — обернуть выделение блочным комментарием языка (или снять его). */
  toggleBlockComment(): void {
    const marks = blockCommentFor(this.languageId);
    if (marks) this.controller.toggleBlockComment(marks[0], marks[1]);
  }

  /** Сортировать строки выделения: `reverse` — по убыванию, `unique` — без повторов. */
  sortLines(options: { reverse?: boolean; unique?: boolean } = {}): void {
    this.controller.sortLines(options);
  }

  /** Соединить строки выделения в одну. */
  joinLines(): void {
    this.controller.joinLines();
  }

  /** Ctrl+Shift+K — удалить строки выделения целиком. */
  deleteLines(): void {
    this.controller.deleteLines();
  }

  /** Дублировать выделение (пусто — строку под кареткой). */
  duplicateSelection(): void {
    this.controller.duplicateSelection();
  }

  /** Ctrl+Enter — вставить пустую строку ниже текущей. */
  insertLineBelow(): void {
    this.controller.insertLineBelow();
  }

  /** Ctrl+Shift+Enter — вставить пустую строку выше текущей. */
  insertLineAbove(): void {
    this.controller.insertLineAbove();
  }

  /** Переставить два знака вокруг каретки (по графемам). */
  transpose(): void {
    this.controller.transpose();
  }

  /** Сменить стиль имени у выделения или слова под кареткой. */
  convertCase(style: CaseStyle): void {
    this.controller.convertCase(style);
  }

  /** Открыть панель поиска или поиска с заменой. */
  openFind(mode: 'find' | 'replace'): void {
    this.find.show(mode);
  }

  /** Открыть панель перехода к строке. */
  openGoto(): void {
    this.goto.show();
  }

  /** Перейти к определению символа под курсором. `false` — переходить нечем. */
  goToDefinition(): boolean {
    if (!this.navigation) return false;
    this.navigation.goToDefinition();
    return true;
  }

  /** Показать ссылки на символ под курсором. `false` — искать негде. */
  findReferences(): boolean {
    if (!this.navigation) return false;
    this.navigation.findReferences();
    return true;
  }

  /**
   * Ctrl+Click (или Cmd+Click) по слову — переход к определению. Жест забираем в
   * фазе захвата и гасим событие: иначе ввод успел бы начать выделение и каретка
   * ускакала бы с места. Без источника мест жест ничего не делает — уходим молча.
   */
  private readonly onViewMouseDown = (event: MouseEvent): void => {
    if (!this.navigation || event.button !== 0) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const offset = this.view.offsetAt(event.clientX, event.clientY);
    this.controller.setSelection({ anchor: offset, active: offset });
    this.input.focus();
    this.navigation.goToDefinition();
  };

  /**
   * Где каретка в системе окна (`null` — панель пуста). Нужно приложению: свои попапы
   * (например, список быстрых исправлений) оно ставит у каретки.
   */
  caretPoint(): { left: number; top: number; bottom: number } | null {
    return this.path ? this.caretAnchor() : null;
  }

  /** Где каретка в системе окна: там показывается список мест. */
  private caretAnchor(): { left: number; top: number; bottom: number } {
    const point = this.view.clientPoint(this.controller.caret);
    return { left: point.left, top: point.top, bottom: point.bottom };
  }

  /**
   * Слово под смещением и его строка. Нужно отладочной подсказке: значение
   * спрашивают у слова (идентификатора), а не у позиции. `null` — слова нет.
   */
  private debugHoverAt(
    evaluate: (word: string, at: { path: string; line: number }) => Promise<HoverExternalInfo | null>,
    offset: number,
  ): Promise<HoverExternalInfo | null> {
    const path = this.activePath;
    if (!path) return Promise.resolve(null);
    const buffer = this.controller.bufferRef;
    const line = buffer.lineAt(offset);
    const text = buffer.lineText(line);
    const word = wordAt(text, offset - buffer.lineStart(line));
    if (!word) return Promise.resolve(null);
    return evaluate(text.slice(word.start, word.end), { path, line });
  }

  // — украшения —

  /**
   * Пересобрать украшения файла из того, что известно, и — если файл открыт — показать.
   * Одна точка сбо́рки: и полоски git, и значки, и фон, и подписи, и подчёркивания
   * складываются вместе, а не по частям — иначе новая правка сбрасывала бы чужую.
   */
  private refreshDecorations(path: string): void {
    const decorations = this.decorations.get(path) ?? new FileDecorations();
    this.decorations.set(path, decorations);

    decorations.setStrips(this.buildStrips(path));
    decorations.setGlyphs(this.buildGlyphs(path));
    decorations.setLineBackgrounds(this.buildBackgrounds(path));
    decorations.setAfterContents(this.buildAfters(path));
    decorations.setLenses(this.buildLenses(path));
    decorations.setSquiggles(this.buildSquiggles(path));

    if (this.path === path) this.view.setDecorations(decorations);
  }

  /** Полоски изменений git: добавлено / изменено / удалено относительно HEAD. */
  private buildStrips(path: string) {
    return (this.lineChanges.get(path) ?? []).map((change) => ({
      line: change.line,
      className: `change-gutter is-${change.kind}`,
      tooltip: changeGutterTooltip(change.kind),
    }));
  }

  /**
   * Значки в поле слева: точка останова, запуск файла, отдельный тест. Порядок
   * наложения тот же, что у клика (см. `onGlyphClick`): точка входа и тест важнее
   * точки останова — последнюю ставят где угодно.
   */
  private buildGlyphs(path: string) {
    const glyphs = new Map<number, { line: number; className: string; tooltip?: string }>();

    // Закладка — самый слабый значок: точка останова, запуск и тест её перекрывают
    // (ниже они кладутся в ту же карту и затирают запись по строке).
    for (const line of this.bookmarks.get(path) ?? []) {
      glyphs.set(line, { line, className: 'bookmark-glyph', tooltip: 'Закладка' });
    }
    for (const item of this.breakpoints.get(path) ?? []) {
      glyphs.set(item.line, {
        line: item.line,
        className: breakpointGlyphClass(item),
        tooltip: breakpointTooltip(item),
      });
    }
    for (const line of this.runLines.get(path) ?? []) {
      glyphs.set(line, { line, className: 'run-glyph', tooltip: 'Запустить файл' });
    }
    for (const test of this.testMarkers.get(path) ?? []) {
      const outcome = this.testOutcomes.get(test.selector);
      const state = outcome ? ` is-${outcome}` : '';
      glyphs.set(test.line, {
        line: test.line,
        className: `run-glyph test-glyph${state}`,
        tooltip: testGlyphTooltip(test, outcome),
      });
    }

    return [...glyphs.values()];
  }

  /** Заливка строки: непокрытые тестами строки и строка, где стоит отладчик. */
  private buildBackgrounds(path: string) {
    const backgrounds: { line: number; className: string }[] = [];
    const missing = this.coverageLines.get(path) ?? new Set<number>();
    for (const line of missing) backgrounds.push({ line, className: 'coverage-line' });
    // Частичная ветвь слабее полного непокрытия: строку тесты исполняли, а вот одну
    // из ветвей условия — нет. Полностью непокрытая строка важнее, её и оставляем.
    for (const line of this.coveragePartial.get(path) ?? []) {
      if (!missing.has(line)) backgrounds.push({ line, className: 'coverage-partial-line' });
    }
    if (this.debugLine && this.debugLine.path === path) {
      backgrounds.push({ line: this.debugLine.line, className: 'debug-line' });
    }
    return backgrounds;
  }

  /** Подписи blame — у строки под курсором или у всего файла. */
  private buildAfters(path: string) {
    const afters: { line: number; content: string; className: string }[] = [];
    const whole = this.blameAll.get(path);
    if (whole) {
      for (const item of whole) afters.push({ line: item.line, content: `  ${item.text}`, className: 'blame-inline' });
      return afters;
    }
    if (this.blameLine && this.blameLine.path === path) {
      afters.push({ line: this.blameLine.line, content: `  ${this.blameLine.text}`, className: 'blame-inline' });
    }
    return afters;
  }

  /** Волнистые подчёркивания пометок языка: серьёзность — класс. */
  private buildSquiggles(path: string) {
    return (this.externalMarkers.get(path) ?? []).map((item) => ({
      line: item.line,
      startColumn: item.column,
      // Многострочная пометка подчёркивается до конца своей первой строки — как в Monaco.
      endColumn: item.endLine === item.line ? Math.max(item.endColumn, item.column + 1) : Number.MAX_SAFE_INTEGER,
      className: severityClass(item.severity),
    }));
  }

  /**
   * Украшения для файла: набор заменяется целиком, как в DAP. Файл может быть не
   * открыт — украшения всё равно соберём и они ждут своей очереди в `open`.
   */
  setLineChanges(path: string, changes: readonly GitLineChange[]): void {
    if (changes.length === 0) this.lineChanges.delete(path);
    else this.lineChanges.set(path, changes);
    this.refreshDecorations(path);
  }

  setRunLines(path: string, lines: readonly number[]): void {
    if (lines.length === 0) this.runLines.delete(path);
    else this.runLines.set(path, new Set(lines));
    this.refreshDecorations(path);
  }

  setTestMarkers(path: string, tests: readonly RunnableTest[]): void {
    if (tests.length === 0) this.testMarkers.delete(path);
    else this.testMarkers.set(path, tests);
    this.refreshDecorations(path);
  }

  /** Исходы прогонов по селекторам: значок теста красится по ним. */
  setTestOutcomes(outcomes: ReadonlyMap<string, TestOutcome>): void {
    this.testOutcomes = outcomes;
    for (const path of this.testMarkers.keys()) this.refreshDecorations(path);
  }

  setBreakpoints(path: string, breakpoints: readonly BreakpointInput[]): void {
    if (breakpoints.length === 0) this.breakpoints.delete(path);
    else this.breakpoints.set(path, breakpoints);
    this.refreshDecorations(path);
  }

  /** Строки закладок файла: пустой набор — значков закладок у файла нет. */
  setBookmarks(path: string, lines: readonly number[]): void {
    if (lines.length === 0) this.bookmarks.delete(path);
    else this.bookmarks.set(path, lines);
    this.refreshDecorations(path);
  }

  /**
   * Строки покрытия по файлам из отчёта. Третий элемент записи (если есть) — строки
   * с наполовину пройденной ветвью: они подсвечиваются слабее непокрытых. Наборы
   * заменяются целиком.
   */
  setCoverage(files: Iterable<CoverageEntry>): void {
    const affected = new Set([...this.coverageLines.keys(), ...this.coveragePartial.keys()]);
    this.coverageLines.clear();
    this.coveragePartial.clear();
    for (const [path, lines, partial] of files) {
      if (lines.length > 0) this.coverageLines.set(path, new Set(lines));
      if (partial && partial.length > 0) this.coveragePartial.set(path, new Set(partial));
      if (lines.length > 0 || (partial && partial.length > 0)) affected.add(path);
    }
    for (const path of affected) this.refreshDecorations(path);
  }

  /** Красная строка на строке отладчика. `null` — подсветку убрать. */
  setDebugLine(path: string | null, line: number | null): void {
    const affected = new Set<string>();
    if (this.debugLine) affected.add(this.debugLine.path);
    this.debugLine = path && line ? { path, line } : null;
    if (this.debugLine) affected.add(this.debugLine.path);
    for (const item of affected) this.refreshDecorations(item);
  }

  /** Подпись blame у строки под курсором. `null` — подпись убрать. */
  setBlame(annotation: { path: string; line: number; text: string } | null): void {
    const affected = new Set<string>();
    if (this.blameLine) affected.add(this.blameLine.path);
    this.blameLine = annotation;
    if (this.blameLine) affected.add(this.blameLine.path);
    for (const item of affected) this.refreshDecorations(item);
  }

  /** Подписи blame у ВСЕХ строк файла. Пустой список снимает подписи у этого файла. */
  setBlameAll(path: string, annotations: readonly { line: number; text: string }[]): void {
    if (annotations.length === 0) this.blameAll.delete(path);
    else this.blameAll.set(path, annotations);
    this.refreshDecorations(path);
  }

  /** Пометки языкового сервера: волнистые подчёркивания. Набор заменяется целиком. */
  setMarkers(path: string, diagnostics: readonly LspDiagnostic[]): void {
    if (diagnostics.length === 0) this.externalMarkers.delete(path);
    else this.externalMarkers.set(path, diagnostics);
    this.refreshDecorations(path);
  }

  /** Файлы, открытые в панелях сейчас. Нужно тому, кто рисует полоски изменений. */
  visiblePaths(): string[] {
    return this.path ? [this.path] : [];
  }

  /** Значок в поле слева: что это значит — решает хозяин, а не представление. */
  private bindDecorationClicks(): void {
    this.view.onGlyphClick = (line) => this.onGlyphClick(line);
    this.view.onGlyphContextMenu = (line) => this.onGlyphClick(line, true);
    this.view.onStripClick = (line) => this.onStripClick(line);
    // Правый клик по полоске: меню блока (то, чего не сделать щелчком по тексту).
    this.view.onStripContextMenu = (line) => this.onStripContextMenu(line);
    this.view.onLensClick = (line) => this.onLensClick(line);
    this.view.onContextMenu = (event) => this.openContextMenu(event);
  }

  /**
   * Правый клик по тексту. Сперва ставим каретку в место клика — человек ожидает, что
   * меню относится к слову под курсором (дальше это нужно переходам к определению и
   * ссылкам). Затем отдаём сбор меню приложению: у него есть реестр команд и буфер обмена.
   */
  private openContextMenu(event: MouseEvent): void {
    const offset = this.view.offsetAt(event.clientX, event.clientY);
    this.controller.setSelection({ anchor: offset, active: offset });
    this.input.focus();
    const position = this.cursorPosition();
    this.contextMenu?.(
      {
        path: this.path,
        line: position.line,
        column: position.column,
        hasSelection: !isEmpty(this.controller.selection),
        selectedText: this.controller.selectedText(),
        canUndo: this.controller.canUndo,
        canRedo: this.controller.canRedo,
      },
      event,
    );
  }

  /**
   * Клик по полю значков. Порядок важен: у точки входа и у теста значки видны, а
   * точку останова ставят где угодно — поэтому она последняя. Правый клик по значку
   * точки просит меню (условие, удаление); если точки нет — то же, что левый.
   */
  private onGlyphClick(line: number, menu = false): void {
    const path = this.path;
    if (!path) return;

    if (this.runLines.get(path)?.has(line)) {
      this.runMarkerEmitter.fire({ path, line });
      return;
    }
    const test = this.testMarkers.get(path)?.find((item) => item.line === line);
    if (test) {
      this.testMarkerEmitter.fire({ path, line, selector: test.selector, name: test.name });
      return;
    }
    const hasBreakpoint = this.breakpoints.get(path)?.some((item) => item.line === line) === true;
    if (menu && hasBreakpoint) {
      this.breakpointMenuEmitter.fire({ path, line });
      return;
    }
    // Левый клик по закладке, где больше ничего нет, снимает её: значок под
    // курсором — то, что человек и рассчитывает убрать.
    if (!menu && !hasBreakpoint && this.bookmarks.get(path)?.includes(line)) {
      this.bookmarkEmitter.fire({ path, line });
      return;
    }
    this.breakpointEmitter.fire({ path, line });
  }

  /** Клик по полоске изменения: просим открыть различие этой строки. */
  private onStripClick(line: number): void {
    const path = this.path;
    if (!path) return;
    if (this.lineChanges.get(path)?.some((change) => change.line === line)) {
      this.changeMarkerEmitter.fire({ path, line });
    }
  }

  /**
   * Правый клик по полоске: меню действий с блоком. Показываем его только там, где
   * полоска есть, — иначе мешало бы обычному меню текста. Собирает меню приложение:
   * у него и git, и подтверждения.
   */
  private onStripContextMenu(line: number): void {
    const path = this.path;
    if (!path) return;
    if (this.lineChanges.get(path)?.some((change) => change.line === line)) {
      this.changeStripMenuEmitter.fire({ path, line });
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeBuffer();
    this.viewport?.removeEventListener('mousedown', this.onViewMouseDown, true);
    this.input.dispose();
    this.find.dispose();
    this.goto.dispose();
    this.hover.dispose();
    this.signature?.dispose();
    this.suggest.dispose();
    this.locations?.dispose();
    this.inline?.dismiss();
    if (this.foldTimer !== null) window.clearTimeout(this.foldTimer);
    if (this.lensTimer !== null) window.clearTimeout(this.lensTimer);
    if (this.inlayTimer !== null) window.clearTimeout(this.inlayTimer);
    this.view.dispose();
    this.cursorEmitter.dispose();
    this.changeTextEmitter.dispose();
    this.changeStripMenuEmitter.dispose();
  }

  /** Показать панель по команде ввода (`Ctrl+F`, `Ctrl+H`, `Ctrl+G`, `F1`). */
  private runCommand(command: CommandName): void {
    if (command === 'gotoLine') this.goto.show();
    else if (command === 'palette') this.openPalette?.();
    else if (command === 'codeActions') {
      // Быстрые исправления — дело приложения: ему и сервер, и список, и правки.
      if (this.path) this.codeActions?.(this.path, this.cursorPosition());
    } else this.find.show(command === 'replace' ? 'replace' : 'find');
  }

  /**
   * Контроллер сообщил об изменении. Текст уходит в документ (истину о содержимом),
   * позиция курсора — в память хозяина, а наружу летит событие о курсоре.
   */
  private onControllerChange(change: EditorChange): void {
    if (this.path) {
      if (change.kind === 'text') {
        this.registry.push(this.path);
        this.changeTextEmitter.fire();
        // Правка могла тронуть границы блоков: диапазоны свёртки пересчитываем с паузой.
        this.scheduleFolds();
        // Линзы привязаны к местам в тексте — после правки их тоже перезапрашиваем.
        this.scheduleLenses();
        // Подсказки-вставки зависят от типов и имён — правка их меняет, перезапрашиваем.
        this.scheduleInlayHints();
      }
      this.cursors.set(this.path, this.cursorPosition());
    }
    this.emitCursor();
  }

  // — свёртка —

  /** Сложить блок у каретки. `false` — сворачивать нечего. */
  foldAtCursor(): boolean {
    return this.view.foldAt(this.controller.caret);
  }

  /** Раскрыть блок, закрывающий каретку. `false` — раскрывать нечего. */
  unfoldAtCursor(): boolean {
    return this.view.unfoldAt(this.controller.caret);
  }

  foldAll(): void {
    this.view.foldAll();
  }

  // — мультикурсор —

  /** Следующее вхождение слова под кареткой (Ctrl+D). `false` — вхождений нет. */
  selectNextOccurrence(): boolean {
    return this.controller.selectNextOccurrence();
  }

  /** Выделить все вхождения слова под кареткой (Ctrl+Shift+L). */
  selectAllOccurrences(): boolean {
    return this.controller.selectAllOccurrences();
  }

  /** Добавить каретку на строку выше или ниже по столбцу. */
  addCursorAbove(): void {
    this.controller.addCursorAbove();
  }

  addCursorBelow(): void {
    this.controller.addCursorBelow();
  }

  /** Оставить только главную каретку (Escape). `true` — кареток было несколько. */
  collapseSelections(): boolean {
    const many = this.controller.selections.length > 1;
    this.controller.collapseToPrimary();
    return many;
  }

  unfoldAll(): void {
    this.view.unfoldAll();
  }

  /** Диапазоны свёртки текущего файла: спросить у приложения и отдать виду. */
  private async refreshFolds(): Promise<void> {
    if (this.readOnly) return;
    const source = this.foldRanges;
    const path = this.path;
    if (!source || !path) return;
    const text = this.registry.get(path)?.text ?? '';
    const id = (this.foldRequestId += 1);
    const ranges = await source(path, text).catch(() => []);
    // Пока спрашивали, файл сменился или текст переписали — ответ уже не к месту.
    if (id !== this.foldRequestId || this.path !== path) return;
    this.view.setFoldRanges(ranges);
  }

  /** Пересчитать свёртку с паузой: на каждое нажатие считать блоки незачем. */
  private scheduleFolds(): void {
    if (!this.foldRanges) return;
    if (this.foldTimer !== null) window.clearTimeout(this.foldTimer);
    this.foldTimer = window.setTimeout(() => {
      this.foldTimer = null;
      void this.refreshFolds();
    }, FOLD_REFRESH_DELAY_MS);
  }

  // — код-линзы —

  /**
   * Подписи-линзы у строк: короткие действия от языкового сервера («3 ссылки»,
   * «Запустить тест»). Показываем только те, у которых уже есть готовая команда:
   * без неё линза — пустая подпись, кликать не по чему.
   */
  private buildLenses(path: string): readonly LensDecoration[] {
    const lenses: LensDecoration[] = [];
    for (const entry of this.codeLenses.get(path) ?? []) {
      const command = entry.command;
      if (!command) continue;
      lenses.push({
        line: entry.range.start.line + 1,
        content: `  ${command.title}`,
        className: 'own-editor-lens',
        tooltip: command.title,
      });
    }
    return lenses;
  }

  /** Код-линзы файла: спросить у приложения и перерисовать украшения этого файла. */
  private async refreshLenses(): Promise<void> {
    if (this.readOnly) return;
    const source = this.codeLensSource;
    const path = this.path;
    if (!source || !path) return;
    const text = this.registry.get(path)?.text ?? '';
    const id = (this.lensRequestId += 1);
    const entries = await source(path, text).catch(() => []);
    // Пока спрашивали, файл сменился или текст переписали — ответ уже не к месту.
    if (id !== this.lensRequestId || this.path !== path) return;
    if (entries.length === 0) this.codeLenses.delete(path);
    else this.codeLenses.set(path, entries);
    this.refreshDecorations(path);
  }

  /** Пересчитать линзы с паузой: на каждое нажатие дёргать сервер незачем. */
  private scheduleLenses(): void {
    if (!this.codeLensSource) return;
    if (this.lensTimer !== null) window.clearTimeout(this.lensTimer);
    this.lensTimer = window.setTimeout(() => {
      this.lensTimer = null;
      void this.refreshLenses();
    }, LENS_REFRESH_DELAY_MS);
  }

  /**
   * Подсказки-вставки текущего файла: спросить у приложения и отдать виду. Вид покажет их
   * только у видимых строк, поэтому спрашиваем на весь файл — но при смене файла или
   * текста ответ прошлого запроса уже не к месту (по номеру запроса).
   */
  private async refreshInlayHints(): Promise<void> {
    if (this.readOnly) return;
    const source = this.inlayHintSource;
    const path = this.path;
    if (!source || !path) return;
    const text = this.registry.get(path)?.text ?? '';
    const id = (this.inlayRequestId += 1);
    const hints = await source(path, text).catch(() => []);
    if (id !== this.inlayRequestId || this.path !== path) return;
    this.view.setInlayHints(hints);
  }

  /** Пересчитать подсказки-вставки с паузой: на каждое нажатие дёргать сервер незачем. */
  private scheduleInlayHints(): void {
    if (!this.inlayHintSource) return;
    if (this.inlayTimer !== null) window.clearTimeout(this.inlayTimer);
    this.inlayTimer = window.setTimeout(() => {
      this.inlayTimer = null;
      void this.refreshInlayHints();
    }, INLAY_REFRESH_DELAY_MS);
  }

  /** Клик по линзе строки: исполняем команду, которую положил в неё сервер. */
  private onLensClick(line: number): void {
    const path = this.path;
    if (!path || !this.lensCommand) return;
    const entry = (this.codeLenses.get(path) ?? []).find((item) => item.range.start.line + 1 === line);
    if (entry?.command) this.lensCommand(path, entry.command);
  }

  /** Позиция курсора активного файла в понятиях «строка и столбец». */
  private cursorPosition(): CursorPosition {
    const position = this.controller.bufferRef.positionAt(this.controller.caret);
    return { line: position.line, column: position.column };
  }

  private emitCursor(): void {
    this.cursorEmitter.fire(this.cursorState);
  }
}

/** Позиция курсора как выделение из одного смещения. */
function selectionAt(buffer: TextBuffer, position: CursorPosition): Selection {
  const offset = buffer.offsetAt({ line: position.line, column: position.column });
  return caret(offset);
}

/** Класс серьёзности пометки для волнистого подчёркивания (`editor.css`). */
function severityClass(severity: LspDiagnostic['severity']): string {
  if (severity === 'error') return 'is-error';
  if (severity === 'warning') return 'is-warning';
  return 'is-info';
}
