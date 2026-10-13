/**
 * Рабочее место редактора: одна или две панели, файл в каждой.
 *
 * Хозяин одной панели (`editor-host.ts`) умеет открыть файл, править и рисовать. Но у
 * приложения есть то, чего одна панель не выражает: РАЗДЕЛЕНИЕ редактора — два файла
 * рядом, и активная панель, куда придёт следующий файл. Это и есть забота рабочего места.
 *
 * Панелей максимум две, как и было у сервиса на Monaco. Модель (у нас — буфер) у панелей
 * ОБЩАЯ: её держит реестр документов, поэтому один файл в двух панелях остаётся одним
 * текстом. Отсюда же и обязанность рабочего места: правка в одной панели должна быть
 * видна в другой — буфер-то общий, но чужая панель о правке не узнает и не перерисуется.
 * Поэтому рабочее место слушает изменения каждого хозяина и обновляет соседей.
 *
 * Границей этот класс повторяет `core/editor-api.ts` (ту часть, что про текст и украшения):
 * имена методов и событий те же, поэтому потребители про своё ядро ничего не знают.
 * Своё здесь есть и для списка команд (свой каталог), и для сравнения (свой diff),
 * и для пометок, и для inline-AI (призрачный текст идёт в main через RPC).
 *
 * Модуль браузерный: он собирает узлы и слушает фокус. Проверяется живой пробой.
 */

import type { CursorPosition } from '../../../shared/api';
import type { TextEdit } from '../../../shared/edits';
import type { GitLineChange } from '../../../shared/git-line-changes';
import type { RunnableTest } from '../../../shared/python-tests';
import type { TestOutcome } from '../../../shared/test-model';
import type { BreakpointInput } from '../../core/debug';
import type { Snippet } from '../../../shared/snippets';
import type { TextDocument } from '../../core/document';
import { Emitter } from '../../core/events';
import type { Scheme } from '../highlight/style';
import type { DiagnosticItem, LspDiagnostic } from '../../../shared/api';
import { DiagnosticsStore } from './diagnostics';
import { OwnDiffEditor, type OwnDiffHandle } from './diff-editor';
import { availableCommands, findEditorCommand, type EditorCommandContext } from './editor-commands';
import { ProblemNavigation } from './problem-navigation';
import type { SymbolSource } from './symbol-navigation';
import type { HoverExternalInfo } from '../widgets/hover-widget';
import type { CompletionItem } from '../complete/completions';
import type { SignatureHelp } from '../../../shared/lsp-signature';
import type { FoldRange } from '../../../shared/fold-ranges';
import type { CodeLensCommand, CodeLensEntry } from '../../../shared/lsp-code-lens';
import type { InlayHint } from '../../../shared/lsp-inlay-hints';
import type { DocumentRegistry } from './document-registry';
import type { TranslatedEdits } from './document-edits';
import {
  EditorHost,
  type ChangeMarkerHit,
  type CoverageEntry,
  type CursorState,
  type EditorContextInfo,
  type RunMarkerHit,
  type TestMarkerHit,
} from './editor-host';
import type { WhitespaceMode } from '../view/whitespace';

/** Значение выражения для подсказки отладчика: что показать и какого типа. */
export interface DebugHoverValue {
  value: string;
  type: string | null;
}

/** Где запрошена отладочная подсказка: файл и строка под курсором. */
export interface DebugHoverPosition {
  path: string;
  line: number;
}

export interface EditorWorkspaceOptions {
  /** Сколько пробелов в шаге отступа (Tab). */
  tabSize?: number;
  /** Кегль текста в редакторе, px. */
  fontSize?: number;
  /** Столбцы направляющих (ruler): вертикальные черты на этих столбцах. */
  rulers?: readonly number[];
  /** Показывать ли невидимые знаки: `none`, `trailing` или `all`. */
  whitespace?: WhitespaceMode;
  /** Показывать ли миникарту — сжатый вид всего файла справа. */
  minimap?: boolean;
  /** Переносить ли длинные строки (word wrap). */
  wordWrap?: boolean;
  /** Включать ли лигатуры шрифта. */
  ligatures?: boolean;
  /** Схема оформления: цвета токенов и обвязки. */
  scheme?: Scheme;
  /** Сниппеты всех языков: их показывают подсказки по триггеру. */
  snippets?: () => readonly Snippet[];
  /** Форматировать файл (инструмент языка спрашивает app, у редактора его нет). */
  formatCode?: (path: string) => void;
  /** Быстрые исправления под курсором: список и правки — дело приложения. */
  codeActions?: (path: string, position: { line: number; column: number }) => void;
  /** Диапазоны свёртки файла: у сервера спрашивает приложение, а без — считает по отступам. */
  foldRanges?: (path: string, text: string) => Promise<readonly FoldRange[]>;
  /**
   * Код-линзы файла: подписи-действия у строк от языкового сервера (см.
   * `shared/lsp-code-lens.ts`). Не задано — линз нет вовсе.
   */
  codeLenses?: (path: string) => Promise<readonly CodeLensEntry[]>;
  /** Исполнить команду линзы: её выбирает сервер, а запускает приложение. */
  lensCommand?: (path: string, command: CodeLensCommand) => void;
  /** Подсказки-вставки файла: путь и текст → подсказки (см. `LspFeatures.inlayHints`). */
  inlayHints?: (path: string, text: string) => Promise<readonly InlayHint[]>;
  /** Наведение от языкового сервера: путь и позиция → текст разметки. */
  hoverFromLanguage?: (path: string, position: { line: number; column: number }) => Promise<HoverExternalInfo | null>;
  /** Подсказки языкового сервера: путь и позиция → дополнения (см. `LspFeatures.completion`). */
  completionFromLanguage?: (
    path: string,
    position: { line: number; column: number },
  ) => Promise<readonly CompletionItem[]>;
  /** Подсказка о параметрах вызова: путь и позиция → разбор (см. `LspFeatures.signatureHelp`). */
  signatureFromLanguage?: (path: string, position: { line: number; column: number }) => Promise<SignatureHelp | null>;
  /**
   * Источник мест символа — языковой сервер (`LspFeatures`). Он же включает переход к
   * определению и поиск ссылок: без него эти команды не предлагаются, потому что
   * показать их нечем.
   */
  symbols?: SymbolSource;
  /**
   * Переименовать символ под курсором. Отдельным швом (как форматирование): ввод
   * имени — диалог, а применение правок — документная модель, и то и другое — дело
   * приложения, а не панели.
   */
  renameSymbol?: (path: string, position: { line: number; column: number }) => void;
  /** Перейти к месту: открыть файл и поставить курсор. Дело приложения (оно знает, как открыть). */
  revealLocation?: (path: string, line: number, column: number) => void;
  /** Короткий путь для подписи места в списке. */
  relativePath?: (path: string) => string;
  /** Сообщить человеку, что мест не нашлось. */
  onNotice?: (text: string) => void;
  /** Правый клик по тексту: приложение собирает меню (см. `EditorContextInfo`). */
  contextMenu?: (info: EditorContextInfo, event: MouseEvent) => void;
  /**
   * Inline-подсказка «допиши за меня»: включение, задержка и запрос к модели. Не задана —
   * призрачного текста в панелях нет вовсе.
   */
  inlineCompletion?: {
    enabled(): boolean;
    debounceMs(): number;
    complete(request: { path: string; language: string; prefix: string; suffix: string }): Promise<string | null>;
  };
}

/**
 * Рабочее место: панели в ряд и одна из них активная. Активность решает фокус — так же,
 * как у сервиса на Monaco: куда кликнули, туда и придёт следующий файл, оттуда и курсор
 * в статус-бар.
 */
export class EditorWorkspace {
  private readonly registry: DocumentRegistry;
  private readonly panesHost: HTMLElement;
  private readonly splitter: HTMLElement;
  private readonly panes: EditorHost[] = [];
  /** Узел каждой панели — чтобы убрать его при закрытии разделения. */
  private readonly paneHosts: HTMLElement[] = [];
  /** Что открыто по путям: при разделении новый панели нужно то же самое. */
  private readonly documents = new Map<string, TextDocument>();
  private activeIndex = 0;
  private scheme: Scheme;
  private readonly tabSize: number | undefined;
  private readonly fontSize: number | undefined;
  /** Столбцы направляющих — панели равны, как отступы и кегль. */
  private readonly rulers: readonly number[] | undefined;
  /** Невидимые знаки: панели равны, как отступы и кегль. */
  private readonly whitespace: WhitespaceMode | undefined;
  private readonly minimap: boolean | undefined;
  private readonly wordWrap: boolean | undefined;
  private readonly ligatures: boolean | undefined;
  private readonly snippets: (() => readonly Snippet[]) | undefined;
  /** Шов к инструменту формата: его у редактора нет, о нём знает приложение. */
  private readonly formatCode: ((path: string) => void) | undefined;
  /** Наведение от языкового сервера — тот же шов, но асинхронный. */
  private readonly hoverFromLanguage:
    | ((path: string, position: { line: number; column: number }) => Promise<HoverExternalInfo | null>)
    | undefined;
  /** Подсказки языкового сервера — тот же шов, но для дополнений. */
  private readonly completionFromLanguage: EditorWorkspaceOptions['completionFromLanguage'];
  /** Подсказка о параметрах вызова — тот же шов, но для сигнатур. */
  private readonly signatureFromLanguage: EditorWorkspaceOptions['signatureFromLanguage'];
  /** Источник мест символа: переход к определению и поиск ссылок. */
  private readonly symbols: SymbolSource | undefined;
  /** Переименование символа: шов к приложению (диалог имени и применение правок). */
  private readonly renameSymbol: ((path: string, position: { line: number; column: number }) => void) | undefined;
  /** Перейти к месту — открыть файл и поставить курсор. */
  private readonly revealLocation: ((path: string, line: number, column: number) => void) | undefined;
  /** Быстрые исправления: шов к приложению (сервер, список, применение правок). */
  private readonly codeActions: ((path: string, position: { line: number; column: number }) => void) | undefined;
  /** Диапазоны свёртки файла — тоже шов: у приложения и сервер, и подсчёт по отступам. */
  private readonly foldRanges: ((path: string, text: string) => Promise<readonly FoldRange[]>) | undefined;
  /** Код-линзы файла — шов: у сервера спрашивает приложение. */
  private readonly codeLenses: EditorWorkspaceOptions['codeLenses'];
  /** Исполнить команду линзы — шов к приложению (у него сервер). */
  private readonly lensCommand: EditorWorkspaceOptions['lensCommand'];
  /** Подсказки-вставки — тот же шов: у сервера спрашивает приложение. */
  private readonly inlayHints: EditorWorkspaceOptions['inlayHints'];
  /** Короткий путь для подписи места в списке. */
  private readonly relativePath: ((path: string) => string) | undefined;
  /** Сообщить, что мест не нашлось. */
  private readonly onNotice: ((text: string) => void) | undefined;
  /** Правый клик по тексту: меню собирает приложение (у него реестр команд и буфер обмена). */
  private readonly contextMenu: EditorWorkspaceOptions['contextMenu'];
  /** Inline-подсказка «допиши за меня». */
  private readonly inlineCompletion: EditorWorkspaceOptions['inlineCompletion'];
  /** Оценка выражения под курсором в остановленном файле; задаёт app (там контроллер отладки). */
  private debugHoverEvaluator:
    | ((expression: string, at: DebugHoverPosition) => Promise<DebugHoverValue | null>)
    | null = null;
  /** Чем открывается палитра команд (F1): ставит `openPaletteOnF1` после создания панелей. */
  private openPaletteOpener: (() => void) | null = null;

  private readonly cursorEmitter = new Emitter<CursorState>();
  readonly onCursorChange = this.cursorEmitter.event;

  private readonly splitEmitter = new Emitter<boolean>();
  readonly onDidChangeSplit = this.splitEmitter.event;

  /** События мест украшений активной панели — те же имена, что у сервиса на Monaco. */
  private readonly runMarkerEmitter = new Emitter<RunMarkerHit>();
  readonly onRunMarker = this.runMarkerEmitter.event;
  private readonly testMarkerEmitter = new Emitter<TestMarkerHit>();
  readonly onTestMarker = this.testMarkerEmitter.event;
  private readonly breakpointEmitter = new Emitter<RunMarkerHit>();
  readonly onBreakpointToggle = this.breakpointEmitter.event;
  private readonly breakpointMenuEmitter = new Emitter<RunMarkerHit>();
  readonly onBreakpointMenu = this.breakpointMenuEmitter.event;
  private readonly bookmarkEmitter = new Emitter<RunMarkerHit>();
  readonly onBookmarkToggle = this.bookmarkEmitter.event;
  private readonly changeMarkerEmitter = new Emitter<ChangeMarkerHit>();
  readonly onChangeMarker = this.changeMarkerEmitter.event;

  /** Правый клик по полоске изменения — меню блока (индексировать, убрать, откатить). */
  private readonly changeStripMenuEmitter = new Emitter<ChangeMarkerHit>();
  readonly onChangeStripMenu = this.changeStripMenuEmitter.event;

  /**
   * Пометки языка — один набор на все панели: источники (LSP, импорты) кладут их
   * по имени владельца, а в панели уезжает объединение. Так же было у Monaco, только
   * объединял движок; здесь объединяем сами (см. `diagnostics.ts`).
   */
  private readonly diagnostics = new DiagnosticsStore();
  readonly onDidChangeMarkers = this.diagnostics.onDidChange;

  /** Переход по пометкам (F8/Shift+F8): обход всех открытых файлов по кругу. */
  private readonly problems: ProblemNavigation;

  constructor(container: HTMLElement, registry: DocumentRegistry, options: EditorWorkspaceOptions = {}) {
    this.registry = registry;
    this.scheme = options.scheme ?? 'dark';
    this.tabSize = options.tabSize;
    this.fontSize = options.fontSize;
    this.rulers = options.rulers;
    this.whitespace = options.whitespace;
    this.minimap = options.minimap;
    this.wordWrap = options.wordWrap;
    this.ligatures = options.ligatures;
    this.snippets = options.snippets;
    this.formatCode = options.formatCode;
    this.codeActions = options.codeActions;
    this.foldRanges = options.foldRanges;
    this.codeLenses = options.codeLenses;
    this.lensCommand = options.lensCommand;
    this.inlayHints = options.inlayHints;
    this.hoverFromLanguage = options.hoverFromLanguage;
    this.completionFromLanguage = options.completionFromLanguage;
    this.signatureFromLanguage = options.signatureFromLanguage;
    this.symbols = options.symbols;
    this.renameSymbol = options.renameSymbol;
    this.revealLocation = options.revealLocation;
    this.relativePath = options.relativePath;
    this.onNotice = options.onNotice;
    this.contextMenu = options.contextMenu;
    this.inlineCompletion = options.inlineCompletion;
    // Переход по пометкам: список берём из своего хранилища, а переход отдаём наружу
    // (`revealLocation`), если приложение его дало: иначе файл может быть не открыт,
    // а открыть его умеет только приложение — в панели он лишь запомнит место.
    this.problems = new ProblemNavigation({
      problems: () => this.diagnostics.markers(),
      position: () => (this.activePath ? { path: this.activePath, ...this.cursor() } : null),
      reveal: (spot) => {
        if (this.revealLocation) this.revealLocation(spot.path, spot.line, spot.column);
        else this.reveal(spot.path, spot.line, spot.column);
      },
      notice: this.onNotice,
    });
    // Ряд панелей и разделитель между ними — та же разметка, что была у Monaco-сервиса.
    this.panesHost = document.createElement('div');
    this.panesHost.className = 'editor-panes';
    this.splitter = document.createElement('div');
    this.splitter.className = 'editor-splitter';
    this.splitter.hidden = true;
    container.append(this.panesHost);
    this.createPane();
    this.panesHost.append(this.splitter);
  }

  /** Активная панель: с ней работает всё, что требует «текущей» области. */
  get pane(): EditorHost {
    return this.panes[this.activeIndex]!;
  }

  /** Файл активной панели (`null` — панель пуста). */
  get activePath(): string | null {
    return this.pane.activePath;
  }

  /** Тот же файл, под именем сервиса на Monaco (`EditorService.currentPath`). */
  get currentPath(): string | null {
    return this.activePath;
  }

  /** Разделена ли область редактора на две панели. */
  get isSplit(): boolean {
    return this.panes.length > 1;
  }

  /** Панель, в которой открыт файл (`null` — файл нигде не открыт). */
  private paneWith(path: string): EditorHost | null {
    return this.panes.find((pane) => pane.activePath === path) ?? null;
  }

  /**
   * Создать панель: свой хозяин в своём узле. Хозяин сам собирает внутри слои, поэтому
   * рабочему месту остаётся только положить узел и подписаться на его события.
   */
  private createPane(): EditorHost {
    const host = document.createElement('div');
    host.className = 'editor-pane';
    const index = this.panes.length;
    const pane = new EditorHost(host, this.registry, {
      tabSize: this.tabSize,
      fontSize: this.fontSize,
      rulers: this.rulers,
      whitespace: this.whitespace,
      minimap: this.minimap,
      wordWrap: this.wordWrap,
      ligatures: this.ligatures,
      scheme: this.scheme,
      snippets: this.snippets,
      hoverFromLanguage: this.hoverFromLanguage,
      completionFromLanguage: this.completionFromLanguage,
      signatureFromLanguage: this.signatureFromLanguage,
      // Быстрые исправления — шов приложения: ему и сервер, и попап, и документная модель.
      codeActions: this.codeActions,
      foldRanges: this.foldRanges,
      codeLenses: this.codeLenses ? (path) => this.codeLenses!(path) : undefined,
      lensCommand: this.lensCommand,
      inlayHints: this.inlayHints,
      symbols: this.symbols,
      revealLocation: this.revealLocation,
      relativePath: this.relativePath,
      onNotice: this.onNotice,
      contextMenu: this.contextMenu,
      inlineCompletion: this.inlineCompletion,
      // Отладочная подсказка: слово и его строка → значение из кадра (см. `setDebugHover`).
      debugHover: (word, at) => this.debugHoverText(word, at),
      // F1 открывает палитру: обработчик ставит `openPaletteOnF1`.
      openPalette: () => this.openPaletteOpener?.(),
    });

    // Фокус решает, куда придёт следующий файл и чей курсор видит статус-бар.
    host.addEventListener('focusin', () => this.setActivePane(index));

    // Курсор в статус-бар отдаёт только активная панель: у второй он не «текущий».
    pane.onDidCursor((state) => {
      if (this.activeIndex === index) this.cursorEmitter.fire(state);
    });

    // Правка в этой панели: соседние должны перерисоваться — буфер-то у них общий.
    pane.onDidChangeText(() => this.refreshSiblings(index, pane));

    // Места украшений идут наружу только от активной панели — как у сервиса на Monaco.
    pane.onRunMarker((hit) => this.forward(index, this.runMarkerEmitter, hit));
    pane.onTestMarker((hit) => this.forward(index, this.testMarkerEmitter, hit));
    pane.onBreakpointToggle((hit) => this.forward(index, this.breakpointEmitter, hit));
    pane.onBreakpointMenu((hit) => this.forward(index, this.breakpointMenuEmitter, hit));
    pane.onBookmarkToggle((hit) => this.forward(index, this.bookmarkEmitter, hit));
    pane.onChangeMarker((hit) => this.forward(index, this.changeMarkerEmitter, hit));
    pane.onChangeStripMenu((hit) => this.forward(index, this.changeStripMenuEmitter, hit));

    this.panes.push(pane);
    this.paneHosts.push(host);
    this.panesHost.append(host);
    host.classList.toggle('is-active', index === 0);
    return pane;
  }

  /** Пропустить событие украшения наружу, только если панель активна. */
  private forward<T>(index: number, emitter: Emitter<T>, hit: T): void {
    if (this.activeIndex === index) emitter.fire(hit);
  }

  /** Перерисовать панели, кроме изменившейся, если в них открыт тот же файл. */
  private refreshSiblings(index: number, source: EditorHost): void {
    const path = source.activePath;
    if (!path) return;
    for (const [i, pane] of this.panes.entries()) {
      if (i === index || pane.activePath !== path) continue;
      pane.refreshText();
    }
  }

  /**
   * Разделить область редактора: справа появляется вторая панель с тем же файлом.
   * Буфер у панелей общий, поэтому правка видна в обеих; дальше в панель можно открыть
   * другой файл — она станет активной по клику.
   */
  splitEditor(): void {
    if (this.isSplit) return;
    const current = this.activePath;
    const document = current ? this.documents.get(current) : null;
    const pane = this.createPane();
    this.panesHost.classList.add('is-split');
    this.splitter.hidden = false;
    this.setActivePane(this.panes.length - 1);
    if (document) pane.open(document);
    this.splitEmitter.fire(true);
    pane.focus();
  }

  /** Убрать разделение: остаётся первая панель. Буфера не трогаем — ими владеет реестр. */
  closeSplit(): void {
    if (!this.isSplit) return;
    const pane = this.panes.pop()!;
    const host = this.paneHosts.pop()!;
    pane.dispose();
    host.remove();
    this.panesHost.classList.remove('is-split');
    this.splitter.hidden = true;
    this.setActivePane(0);
    this.splitEmitter.fire(false);
    this.pane.focus();
  }

  /** Отметить активную панель: с двумя областями иначе не видно, где стоит курсор. */
  private setActivePane(index: number): void {
    this.activeIndex = index;
    for (const [i, host] of this.paneHosts.entries()) host.classList.toggle('is-active', i === index);
    this.cursorEmitter.fire(this.pane.cursorState);
  }

  /** Открыть файл в активной панели. */
  open(document: TextDocument, position?: CursorPosition): void {
    this.documents.set(document.path, document);
    this.pane.open(document, position);
  }

  /** Правки извне (ассистент, языковой сервер) — в активную панель. */
  applyEdits(document: TextDocument, edits: readonly TextEdit[]): TranslatedEdits {
    return this.pane.applyEdits(document, edits);
  }

  /**
   * Позиции курсоров по файлам — их берёт сессия проекта. Собираем со всех панелей:
   * файл может быть открыт лишь в пассивной панели, и его позиция тоже нужна.
   */
  cursorPositions(): Record<string, CursorPosition> {
    const result: Record<string, CursorPosition> = {};
    for (const pane of this.panes) Object.assign(result, pane.cursorPositions());
    return result;
  }

  /** Раздать позиции курсоров всем панелям: каждая подхватит их при открытии файла. */
  restoreCursorPositions(positions: Record<string, CursorPosition>): void {
    for (const pane of this.panes) pane.restoreCursorPositions(positions);
  }

  /** Перейти к строке и столбцу: в панель, где открыт файл, иначе — в активную. */
  reveal(path: string, line: number, column: number): void {
    const pane = this.paneWith(path);
    if (pane && pane !== this.pane) this.setActivePane(this.panes.indexOf(pane));
    (pane ?? this.pane).reveal(path, line, column);
  }

  /** Перейти к кадру отладки: тот же переход, но с колонкой по умолчанию. */
  revealDebugFrame(path: string, line: number, column = 1): void {
    this.reveal(path, line, column);
  }

  // — команды редактора —

  /**
   * Список действий редактора — те же поля, что отдавал сервис на Monaco
   * (`listActions`), поэтому палитра наполняется ими без переделки. Список короткий:
   * это то, что редактор ДЕЙСТВИТЕЛЬНО умеет, а не чужие внутренние действия.
   */
  listActions(): Array<{ id: string; label: string; alias: string }> {
    return availableCommands(this.commandContext()).map((command) => ({
      id: command.id,
      label: command.label,
      alias: command.alias,
    }));
  }

  /** Запустить действие по идентификатору. `false` — такой команды у редактора нет. */
  runAction(id: string): boolean {
    const command = findEditorCommand(id);
    if (!command || (command.requires && this.commandContext()[command.requires] === undefined)) return false;
    command.run(this.commandContext());
    return true;
  }

  /**
   * Контекст команд: синхронная часть — у панели. Необязательное (источник мест для
   * перехода и ссылок, инструмент формата) подключаем только если хозяин его дал: тогда
   * команда попадает в список и её можно вызвать, а иначе в палитре нет пустого пункта.
   */
  private commandContext(): EditorCommandContext {
    const path = this.pane.activePath;
    const context: EditorCommandContext = {
      undo: () => this.pane.undo(),
      redo: () => this.pane.redo(),
      selectAll: () => this.pane.selectAll(),
      openFind: (mode) => this.pane.openFind(mode),
      openGoto: () => this.pane.openGoto(),
      indent: () => this.pane.indent(),
      outdent: () => this.pane.outdent(),
      // Правки строк: те же действия, что по клавишам, — теперь и в палитре.
      toggleComment: () => this.pane.toggleComment(),
      toggleBlockComment: () => this.pane.toggleBlockComment(),
      moveLines: (direction) => this.pane.moveLines(direction),
      copyLinesDown: () => this.pane.copyLinesDown(),
      sortLines: (options) => this.pane.sortLines(options),
      joinLines: () => this.pane.joinLines(),
      deleteLines: () => this.pane.deleteLines(),
      duplicateSelection: () => this.pane.duplicateSelection(),
      insertLineBelow: () => this.pane.insertLineBelow(),
      insertLineAbove: () => this.pane.insertLineAbove(),
      transpose: () => this.pane.transpose(),
      convertCase: (style) => this.pane.convertCase(style),
      // Свёртка — состояние самой панели: она знает и диапазоны, и что сложено.
      fold: () => this.pane.foldAtCursor(),
      unfold: () => this.pane.unfoldAtCursor(),
      foldAll: () => this.pane.foldAll(),
      unfoldAll: () => this.pane.unfoldAll(),
      // Мультикурсор: команды палитры делают то же, что клавиши в панели.
      selectNextOccurrence: () => void this.pane.selectNextOccurrence(),
      selectAllOccurrences: () => void this.pane.selectAllOccurrences(),
      addCursorAbove: () => this.pane.addCursorAbove(),
      addCursorBelow: () => this.pane.addCursorBelow(),
      collapseSelections: () => void this.pane.collapseSelections(),
    };
    const formatCode = this.formatCode;
    if (formatCode) context.formatCode = () => path && formatCode(path);
    // Переход и ссылки редактор умеет сам — ему нужен лишь источник мест. Нет источника —
    // команды не предлагаются (см. `requires` в `editor-commands.ts`).
    if (this.symbols) {
      context.goToDefinition = () => void this.pane.goToDefinition();
      context.findReferences = () => void this.pane.findReferences();
    }
    // Переименование — шов приложения: ему нужен диалог имени и документная модель.
    const renameSymbol = this.renameSymbol;
    if (renameSymbol) context.renameSymbol = () => path && renameSymbol(path, this.pane.cursor());
    // Быстрые исправления — тот же порядок: список показывает приложение.
    const codeActions = this.codeActions;
    if (codeActions) context.codeActions = () => path && codeActions(path, this.pane.cursor());
    // Переход по пометкам есть всегда: хранилище пометок — у самого рабочего места.
    context.nextProblem = () => this.problems.next();
    context.previousProblem = () => this.problems.previous();
    return context;
  }

  /** Текст выделенного участка — для копирования. Пустая строка, если выделения нет. */
  selectedText(): string {
    return this.pane.selectedText();
  }

  /** Вставка текста в курсор активной панели. */
  insertAtCursor(text: string): boolean {
    return this.pane.insertAtCursor(text);
  }

  /** Буфер обмена активной панели — для пунктов контекстного меню. */
  copyToClipboard(): void {
    this.pane.copyToClipboard();
  }

  cutToClipboard(): void {
    this.pane.cutToClipboard();
  }

  pasteFromClipboard(): void {
    this.pane.pasteFromClipboard();
  }

  /** Текст файла по буферу (`null` — файл нигде не открыт). */
  currentText(path: string): string | null {
    return this.pane.currentText(path);
  }

  /** Файлы, открытые в панелях сейчас. Нужно тому, кто рисует полоски изменений. */
  visiblePaths(): string[] {
    const paths = new Set<string>();
    for (const pane of this.panes) if (pane.activePath) paths.add(pane.activePath);
    return [...paths];
  }

  /** Позиция курсора активной панели. */
  cursor(): { line: number; column: number } {
    return this.pane.cursor();
  }

  /**
   * Сравнение двух версий файла. Своё, без Monaco, но с ТОЙ ЖЕ границей, что отдавал
   * `EditorService.createDiff`, — поэтому просмотр различий и экран конфликтов работают
   * не меняясь. Схему берём текущую: сравнение должно следовать за темой приложения.
   */
  createDiff(container: HTMLElement): OwnDiffHandle {
    return new OwnDiffEditor(container, { scheme: this.scheme });
  }

  /** Сменить схему оформления на всех панелях. */
  setTheme(scheme: Scheme): void {
    this.scheme = scheme;
    for (const pane of this.panes) pane.setScheme(scheme);
  }

  /** Настройки вида: ширина отступа, кегль и направляющие. Панели равны — применяем ко всем. */
  applyOptions(options: {
    tabSize?: number;
    fontSize?: number;
    rulers?: readonly number[];
    whitespace?: WhitespaceMode;
    minimap?: boolean;
    wordWrap?: boolean;
    ligatures?: boolean;
  }): void {
    for (const pane of this.panes) pane.applyOptions(options);
  }

  /**
   * Украшения файла: набор тот же, что у сервиса на Monaco, но адресуется всем панелям —
   * файл может быть открыт в двух, и полоски должны быть в обеих.
   */
  setLineChanges(path: string, changes: readonly GitLineChange[]): void {
    for (const pane of this.panes) pane.setLineChanges(path, changes);
  }

  setRunLines(path: string, lines: readonly number[]): void {
    for (const pane of this.panes) pane.setRunLines(path, lines);
  }

  setTestMarkers(path: string, tests: readonly RunnableTest[]): void {
    for (const pane of this.panes) pane.setTestMarkers(path, tests);
  }

  setTestOutcomes(outcomes: ReadonlyMap<string, TestOutcome>): void {
    for (const pane of this.panes) pane.setTestOutcomes(outcomes);
  }

  setBreakpoints(path: string, breakpoints: readonly BreakpointInput[]): void {
    for (const pane of this.panes) pane.setBreakpoints(path, breakpoints);
  }

  setBookmarks(path: string, lines: readonly number[]): void {
    for (const pane of this.panes) pane.setBookmarks(path, lines);
  }

  setCoverage(files: Iterable<CoverageEntry>): void {
    for (const pane of this.panes) pane.setCoverage(files);
  }

  setDebugLine(path: string | null, line: number | null): void {
    for (const pane of this.panes) pane.setDebugLine(path, line);
  }

  setBlame(annotation: { path: string; line: number; text: string } | null): void {
    for (const pane of this.panes) pane.setBlame(annotation);
  }

  setBlameAll(path: string, annotations: readonly { line: number; text: string }[]): void {
    for (const pane of this.panes) pane.setBlameAll(path, annotations);
  }

  setMarkers(path: string, diagnostics: readonly LspDiagnostic[]): void {
    for (const pane of this.panes) pane.setMarkers(path, diagnostics);
  }

  /**
   * Пометки одного источника (языковой сервер, проверка импортов). Набор владельца
   * заменяется целиком: свежие пометки сервера не должны смешиваться с прежними его же.
   * В панели уезжает ОБЪЕДИНЕНИЕ всех владельцев — подчёркивания рисуются по нему.
   */
  setExternalMarkers(path: string, owner: string, diagnostics: readonly LspDiagnostic[]): void {
    this.diagnostics.set(path, owner, diagnostics);
    this.drawMarkers(path);
  }

  /** Снять пометки файла целиком: его закрыли, подчёркивания должны исчезнуть. */
  clearMarkers(path: string): void {
    this.diagnostics.clear(path);
    this.drawMarkers(path);
  }

  /** Раздать всем панелям объединённые пометки файла — по ним рисуются подчёркивания. */
  private drawMarkers(path: string): void {
    const merged = this.diagnostics.forPath(path);
    for (const pane of this.panes) pane.setMarkers(path, merged);
  }

  /** Список пометок для наружу (`get_diagnostics`): с путём и источником. */
  markers(path?: string): DiagnosticItem[] {
    return this.diagnostics.markers(path);
  }

  /** Сколько ошибок и предупреждений — для статус-бара. */
  problemCounts(): { errors: number; warnings: number } {
    return this.diagnostics.problemCounts();
  }

  /** Поставить фокус в активную панель. */
  focus(): void {
    this.pane.focus();
  }

  /** Где каретка активной панели в системе окна (`null` — ничего не открыто). */
  caretPoint(): { left: number; top: number; bottom: number } | null {
    return this.pane.caretPoint();
  }

  /** Пометки языка файла с диапазонами — контекст для запроса быстрых исправлений. */
  lspDiagnostics(path: string): LspDiagnostic[] {
    return this.diagnostics.forPath(path);
  }

  /**
   * Перейти к следующей пометке языка (по кругу). Замена действия Monaco
   * `editor.action.marker.nextInFiles`: его зовёт клик по счётчику проблем в статусбаре.
   */
  revealNextProblem(): void {
    this.problems.next();
  }

  /**
   * Подключить оценку выражений для подсказки под курсором в остановленном файле.
   * Отдельным швом, потому что контроллер отладки живёт в приложении, а редактор о
   * нём знать не должен. Позицию передаём: по ней вызывающий выбирает кадр для счёта.
   */
  setDebugHover(evaluate: (expression: string, at: DebugHoverPosition) => Promise<DebugHoverValue | null>): void {
    this.debugHoverEvaluator = evaluate;
  }

  /**
   * Направить F1 на нашу палитру. У Monaco это перекрывало его же действие
   * `editor.action.quickCommand`; своему редактору клавишу надо просто обработать.
   */
  openPaletteOnF1(open: () => void): void {
    this.openPaletteOpener = open;
    for (const pane of this.panes) pane.openPalette = () => open();
  }

  /**
   * Текст подсказки отладчика по слову: заголовок — слово, тело — `имя = значение`.
   * `null` — отладчик недоступен или выражение не вычислилось.
   */
  private async debugHoverText(word: string, at: DebugHoverPosition): Promise<HoverExternalInfo | null> {
    const evaluate = this.debugHoverEvaluator;
    if (!evaluate) return null;
    const result = await evaluate(word, at);
    if (!result) return null;
    const type = result.type ? ` — \`${result.type}\`` : '';
    return { title: word, text: `\`${word}\` = ${result.value}${type}` };
  }

  dispose(): void {
    for (const pane of this.panes) pane.dispose();
    this.panes.length = 0;
    this.paneHosts.length = 0;
    this.cursorEmitter.dispose();
    this.splitEmitter.dispose();
    this.runMarkerEmitter.dispose();
    this.testMarkerEmitter.dispose();
    this.breakpointEmitter.dispose();
    this.breakpointMenuEmitter.dispose();
    this.changeMarkerEmitter.dispose();
    this.changeStripMenuEmitter.dispose();
    this.diagnostics.dispose();
  }
}
