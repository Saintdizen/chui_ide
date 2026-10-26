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
import type { DocumentLinkEntry } from '../../../shared/lsp-document-links';
import type { LinkedRange } from '../../../shared/lsp-linked-editing';
import { type SelectionSpan, type SelectionStep, stepSelection } from '../../../shared/lsp-selection-range';
import type { SemanticToken } from '../../../shared/lsp-semantic-tokens';
import type { RunnableTest } from '../../../shared/python-tests';
import type { Snippet } from '../../../shared/snippets';
import { completeStatement } from '../complete/statement';
import type { TestOutcome } from '../../../shared/test-model';
import { spellProblemsInLine, type CharRange, type SpellProblem } from '../../../shared/spellcheck';
import type { BreakpointInput } from '../../core/debug';
import type { EditSource, TextDocument } from '../../core/document';
import { Emitter } from '../../core/events';
import type { SpellCheck } from '../../core/spellcheck';
import { CompletionAssistant } from '../complete/assistant';
import type { ProjectCompletion } from '../complete/assistant';
import type { CompletionItem } from '../complete/completions';
import { SignatureAssistant } from '../complete/signature';
import { TextBuffer } from '../core/text-buffer';
import { wordAt } from '../core/graphemes';
import { COMMENT, STRING } from '../highlight/tokens';
import { type EditorChange, EditorController } from '../input/editor-controller';
import { type CommandName, EditorInputBinding, type KeyInterceptor } from '../input/editor-input';
import type { CaseStyle } from '../input/case-convert';
import { blockCommentFor, lineCommentFor } from '../input/comments';
import { InlineCompletions } from '../input/inline-completions';
import { EmmetExpander } from '../input/emmet';
import type { SurroundOption } from '../input/surround';
import type { VimMode } from '../input/vim';
import type { CompletionTriggers } from './lsp-features';
import { EditorView, type DebugInlineValue } from '../view/editor-view';
import type { CursorStyle } from '../../../shared/cursor-style';
import type { MacroStep } from '../input/macro';
import { normalizeWhitespaceMode, type WhitespaceMode } from '../view/whitespace';
import { caret, isEmpty, type Selection } from '../view/selection';
import { FileDecorations, type LensDecoration, type LinkDecoration } from '../view/decorations';
import { FindWidget } from '../widgets/find-widget';
import { GotoLineWidget } from '../widgets/goto-widget';
import { HoverWidget, type HoverExternalInfo, type HoverProblem } from '../widgets/hover-widget';
import { problemsAt } from '../hover/problem-at';
import { wordInfoAt } from '../hover/word-info';
import { LocationsWidget } from '../widgets/locations-widget';
import { PeekWidget, type PeekAnchor } from '../widgets/peek-widget';
import { PeekController } from './peek-controller';
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

/** Пауза перед перезапросом связанных участков: связь ищем по движению курсора. */
const LINKED_REFRESH_DELAY_MS = 150;

/** Пауза перед перезапросом семантической подсветки: сервер разбирает файл целиком. */
const SEMANTIC_REFRESH_DELAY_MS = 300;

/** Пауза перед пересчётом орфографии: на каждую букву проверять файл незачем. */
const SPELL_REFRESH_DELAY_MS = 250;

/** Выше этого числа строк орфографию не проверяем: подчёркивания всего файла долги. */
const MAX_SPELL_LINES = 20000;

/** Языки, где текст — сама проза: проверяем всю строку, а не только комментарии. */
const PROSE_LANGUAGES = new Set(['markdown', 'plaintext', 'txt', 'log', 'csv', 'restructuredtext']);

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
// Профиль строк: путь и строки с уровнем «жара» (1..3). Уровень считает приложение
// (`shared/line-profile.ts`): редактор только красит, пороги в нём не живут.
export type ProfileLineEntry = readonly [path: string, rows: readonly { line: number; level: 1 | 2 | 3 }[]];

export interface EditorHostOptions {
  /** Сколько пробелов в шаге отступа (Tab). */
  tabSize?: number;
  /** Кегль текста в редакторе, px. */
  fontSize?: number;
  /** Высота строки, px; `0` — «по шрифту». */
  lineHeight?: number;
  /** Форма каретки: полоска, блок или подчёркивание. */
  cursorStyle?: CursorStyle;
  /** Мигает ли каретка. */
  cursorBlink?: boolean;
  /** Столбцы направляющих (ruler): вертикальные черты на этих столбцах. */
  rulers?: readonly number[];
  /** Показывать ли невидимые знаки: `none` (по умолчанию), `trailing` или `all`. */
  whitespace?: WhitespaceMode;
  /** Показывать ли миникарту — сжатый вид всего файла справа. */
  minimap?: boolean;
  /** Переносить ли длинные строки (word wrap). */
  wordWrap?: boolean;
  /** Плавная прокрутка: прыжок курсора ведёт текст разгоном. */
  smoothScroll?: boolean;
  /** Vim-режим: модальное управление клавишами (настройка `editor.vimMode`). */
  vimMode?: boolean;
  /** Режим Vim сменился — по нему приложение показывает значок в строке состояния. */
  onVimModeChange?: (mode: VimMode) => void;
  /** Emacs-режим: сочетания Ctrl/Alt поверх обычного ввода (настройка `editor.emacsMode`). */
  emacsMode?: boolean;
  /** Включать ли лигатуры шрифта. */
  ligatures?: boolean;
  /**
   * Подсказки-вставки файла (inlay hints) от языкового сервера: путь и текст → подсказки
   * (см. `shared/lsp-inlay-hints.ts`). Не задано — подсказок в коде нет вовсе.
   */
  inlayHints?: (path: string, text: string) => Promise<readonly InlayHint[]>;
  /** Схема оформления: цвета токенов и обвязки. */
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
   * Символы проекта по имени — карта символов. Ими расширяется список подсказок:
   * повторный Ctrl+Space показывает сначала свой проект, затем зависимости.
   * Не задано — расширять нечем, остаётся только файл.
   */
  projectSymbols?: (query: string, onlyIndex?: boolean) => Promise<readonly ProjectCompletion[]>;
  /**
   * Файлы проекта относительными путями — по ним подсказываются пути внутри импорта.
   * Не задано — в импорте подсказок нет, остаются слова.
   */
  projectFiles?: () => Promise<readonly string[]>;
  /**
   * Знаки-триггеры языкового сервера для файла (`@` в CSS, `:` в JSON, `.` в TS):
   * по ним попап открывается сразу после знака, а не только по набранным буквам.
   * Не задано — работает только наш путь (точка и буквы).
   */
  completionTriggers?: (path: string) => Promise<CompletionTriggers>;
  /**
   * Довести подсказку опозданием (`completionItem/resolve`): путь и исходный элемент
   * сервера → описание и уточнение. Не задано — список довольствуется первым ответом.
   */
  resolveCompletionItem?: (path: string, item: unknown) => Promise<{ detail?: string; documentation?: string } | null>;
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
  /**
   * Прочитать текст файла по пути: у открытого он уже есть, у прочего — с диска.
   * Нужно «заглядыванию» в определение (см. `peek-controller.ts`). Не задано —
   * заглядывания нет вовсе: показать нечего.
   */
  readText?: (path: string) => Promise<string | null>;
  /**
   * Показать выбор обёртки выделения («surround with»). Не задано — сочетание молчит:
   * список вариантов и модалка — дело вызывающего (см. `ui/surround-modal.ts`).
   */
  surroundWith?: () => void;
  /**
   * Отформатировать участок файла (`textDocument/rangeFormatting`): выделение или только
   * что вставленный кусок. Дело приложения — у него языковой сервер. Не задано —
   * форматирования участка нет вовсе.
   */
  formatRange?: (
    path: string,
    range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  ) => void;
  /**
   * Форматировать ли вставленный кусок. Живой геттер: настройку меняют в окне. Не задано —
   * не форматируем: правка чужого текста после вставки должна быть осознанной.
   */
  formatOnPaste?: () => boolean;
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
   * Ссылки внутри кода от языкового сервера (`textDocument/documentLink`): пути в
   * `import`, адреса в комментариях. Не задано — подчёркнутых ссылок нет вовсе.
   */
  documentLinks?: (path: string) => Promise<readonly DocumentLinkEntry[]>;
  /**
   * Клик по ссылке в тексте: что открыть (адрес или файл) решает приложение — у него
   * и системный обработчик ссылок, и открытие файлов.
   */
  openLink?: (target: string, path: string) => void;
  /**
   * Связанные участки (`linkedEditingRange`) в позиции курсора: имена парных тегов,
   * которые правятся вместе (см. `shared/lsp-linked-editing.ts`). Не задано — связи нет.
   */
  linkedEditing?: (path: string, position: { line: number; column: number }) => Promise<readonly LinkedRange[]>;
  /**
   * Цепочка участков вокруг позиции (`selectionRange`) — для «выделить по структуре»:
   * слово, выражение, строка, блок (см. `shared/lsp-selection-range.ts`). Не задано —
   * команды выделения по структуре нет, в палитре не появляется.
   */
  selectionRanges?: (path: string, position: { line: number; column: number }) => Promise<readonly SelectionSpan[]>;
  /**
   * Семантическая подсветка файла от сервера (`semanticTokens/full`): точные роли поверх
   * своей грамматики (см. `shared/lsp-semantic-tokens.ts`). Не задано — только грамматика.
   */
  semanticTokens?: (path: string, languageId: string) => Promise<readonly SemanticToken[]>;
  /**
   * Код-линзы файла от языкового сервера: путь и текст → подписи у строк (см.
   * `shared/lsp-code-lens.ts`). Не задано — линз нет вовсе.
   */
  codeLenses?: (path: string, text: string) => Promise<readonly CodeLensEntry[]>;
  /** Исполнить команду линзы: её выбирает сервер, а запускает приложение. */
  lensCommand?: (path: string, command: CodeLensCommand) => void;
  /**
   * Inline-подсказка «допиши за меня»: включение, задержка и запрос к модели. Не задана —
   * призрачного текста в панели нет вовсе (прежде это был провайдер движка).
   */
  inlineCompletion?: {
    enabled(): boolean;
    debounceMs(): number;
    /** Контекст вокруг курсора → готовый текст. `null`/пусто — подсказки нет. */
    complete(request: { path: string; language: string; prefix: string; suffix: string }): Promise<string | null>;
  };
  /**
   * Включён ли Emmet: раскрытие сокращений разметки и стилей по Tab (`ul>li*3` → список).
   * Не задано — считаем выключенным: раскрытие меняет текст по Tab, и включать его без
   * ведома человека невежливо (см. `input/emmet.ts`).
   */
  emmetEnabled?: () => boolean;
  /**
   * Проверка орфографии: словарь системы, слова человека и пропущенные слова (см.
   * `core/spellcheck.ts`). Не задано — проверки нет вовсе. `spellSaveWord` — приложение
   * запоминает слово в настройках, чтобы в следующий раз оно не было ошибкой.
   */
  spellcheck?: SpellCheck;
  spellcheckEnabled?: () => boolean;
  spellSaveWord?: (word: string) => void;
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
  /** Знаки-триггеры сервера для активного файла — отсюда их берёт попап подсказок. */
  /** Отступ одной ступени: им пользуется Emmet при раскрытии вложенных элементов. */
  private indentSize = 4;
  private readonly completionTriggersSource: ((path: string) => Promise<CompletionTriggers>) | undefined;
  /** Номер запроса триггеров: ответ на прежний файл не применяем. */
  private triggersRequestId = 0;
  private readonly suggest: SuggestWidget;
  /** Подсказка о параметрах вызова. `null` — источника нет, карточки не будет. */
  private readonly signature: SignatureAssistant | null;
  /** Список мест (определения, ссылки). `null` — источника нет, показывать нечего. */
  private readonly locations: LocationsWidget | null;
  /** Копия кода «на месте» (заглянуть в определение). `null` — показывать нечего. */
  private readonly peekWidget: PeekWidget | null;
  private readonly peek: PeekController | null;
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

  /** Ссылки в коде — от приложения (языковой сервер): источник, ответ и открытие. */
  private readonly documentLinkSource: ((path: string) => Promise<readonly DocumentLinkEntry[]>) | undefined;
  private readonly openLink: ((target: string, path: string) => void) | undefined;
  /** Связанные участки — от приложения (языковой сервер): источник и номер запроса. */
  private readonly linkedSource:
    | ((path: string, position: { line: number; column: number }) => Promise<readonly LinkedRange[]>)
    | undefined;
  private linkedRequestId = 0;
  private linkedTimer: number | null = null;
  /** Выделение по структуре — от приложения (языковой сервер): источник и номер запроса. */
  private readonly selectionSource:
    | ((path: string, position: { line: number; column: number }) => Promise<readonly SelectionSpan[]>)
    | undefined;
  private selectionRequestId = 0;
  /** Семантическая подсветка — от приложения (языковой сервер): источник и номер запроса. */
  private readonly semanticSource:
    | ((path: string, languageId: string) => Promise<readonly SemanticToken[]>)
    | undefined;
  private semanticRequestId = 0;
  private semanticTimer: number | null = null;
  /** Последний ответ по файлам: рисуем из него, клик ищет здесь же. */
  private readonly documentLinks = new Map<string, readonly DocumentLinkEntry[]>();
  private linkRequestId = 0;
  private linkTimer: number | null = null;
  /** Код-линзы — от приложения (языковой сервер): источник, исполнение и последний ответ. */
  private readonly codeLensSource: ((path: string, text: string) => Promise<readonly CodeLensEntry[]>) | undefined;
  private readonly lensCommand: ((path: string, command: CodeLensCommand) => void) | undefined;
  /** Последний ответ по файлам: рисуем из него, а команду на клик ищем здесь же. */
  private readonly codeLenses = new Map<string, readonly CodeLensEntry[]>();
  private lensRequestId = 0;
  private lensTimer: number | null = null;

  /** Поле прокрутки: на нём слушаем Ctrl+Click по слову (переход к определению). */
  private readonly viewport: HTMLElement | null;

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
  /** Горячие строки профиля: строка → уровень (1..3), для заливки. */
  private readonly profileLines = new Map<string, readonly { line: number; level: 1 | 2 | 3 }[]>();
  private blameLine: { path: string; line: number; text: string } | null = null;
  private readonly blameAll = new Map<string, readonly { line: number; text: string }[]>();
  private debugLine: { path: string; line: number } | null = null;
  /**
   * Значения отладчика для показа в строках: `x = 42`. Живут, пока программа стоит;
   * при смене файла не переносятся — их пришлёт приложение для нового (см. `setDebugInlineValues`).
   */
  private debugInlineValues: { path: string; values: readonly DebugInlineValue[] } | null = null;
  /** Пометки языкового сервера по файлам: рисуем волнистым подчёркиванием. */
  private readonly externalMarkers = new Map<string, readonly LspDiagnostic[]>();
  /** Шов выбора обёртки: список показывает вызывающий (см. `ui/surround-modal.ts`). */
  private readonly surroundWithHandler: (() => void) | undefined;
  /** Шов форматирования участка: сервер и применение правок — на стороне приложения. */
  private readonly formatRangeHandler: EditorHostOptions['formatRange'];
  /** Включено ли форматирование вставленного куска — живой геттер настройки. */
  private readonly formatOnPaste: (() => boolean) | undefined;
  /** Проверка орфографии: словарь и живая настройка. `undefined` — проверки нет. */
  private readonly spell: SpellCheck | undefined;
  private readonly spellEnabled: (() => boolean) | undefined;
  private readonly spellSaveWord: ((word: string) => void) | undefined;
  /** Ошибки орфографии по файлам: рисуем волнистым подчёркиванием (как пометки языка). */
  private readonly spellProblems = new Map<string, SpellProblem[]>();
  private spellTimer: number | null = null;
  private unsubscribeSpell: () => void = () => undefined;

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
    this.openPalette = options.openPalette ?? null;
    this.contextMenu = options.contextMenu;
    this.codeActions = options.codeActions;
    this.foldRanges = options.foldRanges;
    this.codeLensSource = options.codeLenses;
    this.lensCommand = options.lensCommand;
    this.inlayHintSource = options.inlayHints;
    this.documentLinkSource = options.documentLinks;
    this.openLink = options.openLink;
    this.linkedSource = options.linkedEditing;
    this.selectionSource = options.selectionRanges;
    this.semanticSource = options.semanticTokens;
    this.completionTriggersSource = options.completionTriggers;
    this.spell = options.spellcheck;
    this.spellEnabled = options.spellcheckEnabled;
    this.spellSaveWord = options.spellSaveWord;
    this.surroundWithHandler = options.surroundWith;
    this.formatRangeHandler = options.formatRange;
    this.formatOnPaste = options.formatOnPaste;

    // До первого `open` редактор держит пустой буфер: слои не терпят «нет документа», а
    // пустая вкладка — нормальное состояние панели, пока файл не открыт.
    const buffer = new TextBuffer('');
    this.view = new EditorView(container, buffer, {
      whitespace: normalizeWhitespaceMode(options.whitespace),
      minimap: options.minimap,
      ligatures: options.ligatures,
    });
    this.view.setWordWrap(options.wordWrap === true);
    this.view.setSmoothScroll(options.smoothScroll === true);
    if (options.fontSize !== undefined) this.view.setFontSize(options.fontSize);
    if (options.lineHeight !== undefined) this.view.setLineHeight(options.lineHeight);
    if (options.cursorStyle !== undefined) this.view.setCursorStyle(options.cursorStyle);
    if (options.cursorBlink !== undefined) this.view.setCursorBlink(options.cursorBlink);
    if (options.rulers) this.view.setRulers(options.rulers);
    this.viewport = this.view.element.querySelector<HTMLElement>('.own-editor-viewport');
    // Значок «только чтение» — поверх панели: файл большой, правки в нём выключены.
    this.readOnlyBadge = document.createElement('div');
    this.readOnlyBadge.className = 'own-editor-readonly';
    this.readOnlyBadge.textContent = 'Только чтение';
    this.readOnlyBadge.title = 'Файл слишком большой для правки — открыт только для чтения';
    this.readOnlyBadge.hidden = true;
    container.append(this.readOnlyBadge);
    this.indentSize = options.tabSize ?? 4;
    this.controller = new EditorController(buffer, { tabSize: options.tabSize });
    // Документ (истина о содержимом) узнаёт о правке ПЕРВЫМ — раньше попапов.
    // Иначе запрос подсказок уходит серверу раньше синхронизации (`lsp.change`), и тот
    // отвечает по тексту БЕЗ последнего набранного знака: позиция в нём уже другая, и
    // вместо членов объекта приходит что попало («BaseWebDriver» вместо «driver»).
    // Подписка стоит здесь, до создания ввода и попапов — они подписываются позже
    // и видят изменение уже после записи текста в документ (см. `sync` в editor-input).
    this.unsubscribe = this.controller.onChange((change) => this.onControllerChange(change));
    this.find = new FindWidget(this.view, this.controller, buffer);
    this.goto = new GotoLineWidget(this.view, this.controller, buffer);
    this.suggest = new SuggestWidget(container);
    this.assistant = new CompletionAssistant(this.view, this.controller, buffer, this.suggest, {
      snippets: options.snippets,
      // Подсказки сервера: путь берём активный — панель о нём знает, ассистент нет.
      projectSymbols: options.projectSymbols,
      // Пути в импорте считаются от открытого файла — по той же причине.
      projectFiles: options.projectFiles,
      currentPath: () => this.activePath,
      lsp: options.completionFromLanguage
        ? (_prefix, position) => {
            const path = this.activePath;
            if (!path) return Promise.resolve([]);
            // Текст — серверу ДО вопроса. Знак набран, а синхронизация могла ещё
            // не уехать (правка идёт разными путями): тогда сервер ответит по
            // устаревшему документу, и подсказка будет не про то место.
            this.registry.push(path);
            return options.completionFromLanguage!(path, position);
          }
        : undefined,
      // Дотягивание подсказки: путь берём активный — панель о нём знает, ассистент нет.
      resolve: options.resolveCompletionItem
        ? (item) => {
            const path = this.activePath;
            return path ? options.resolveCompletionItem!(path, item) : Promise.resolve(null);
          }
        : undefined,
    });
    this.hover = new HoverWidget(this.view, buffer, {
      // Пометки языка — текстом: волна под словом сама ничего не объясняет, а человек,
      // увидев её, хочет прочитать, в чём дело (см. `showAt` в `hover-widget.ts`).
      problems: (offset) => this.problemsAtOffset(offset),
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
    // Копия «на месте»: нужен текст файла (чтение). Места определения — от сервера;
    // без него заглядывание в определение недоступно, а просмотр файла работает.
    this.peekWidget = options.readText ? new PeekWidget(container) : null;
    this.peek =
      options.readText && this.peekWidget
        ? new PeekController({
            definition: options.symbols ? (path, position) => options.symbols!.definition(path, position) : undefined,
            readText: (path) => options.readText!(path),
            widget: this.peekWidget,
            anchor: () => this.caretAnchor(),
            label: (target) => (options.relativePath ?? ((path: string) => path))(target.path),
            reveal: (target) => options.revealLocation?.(target.path, target.line, target.column),
            notice: (text) => options.onNotice?.(text),
            position: () => {
              const position = this.cursorPosition();
              return { path: this.path, line: position.line, column: position.column };
            },
          })
        : null;
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
    // Заглядывание идёт после списка мест: видимый список забирает клавишу первым,
    // а копия — уже когда списка нет (при заглядывании он и не показывается).
    if (this.peek) interceptors.push(this.peek);
    // Emmet — после попапов: видимый список подсказок забирает Tab себе, а уже потом
    // Tab раскрывает сокращение (см. `input/emmet.ts`).
    if (options.emmetEnabled) {
      interceptors.push(
        new EmmetExpander({
          controller: this.controller,
          language: () => this.languageId,
          indent: () => ' '.repeat(this.indentSize),
          enabled: options.emmetEnabled,
        }),
      );
    }
    if (this.inline) interceptors.push(this.inline);
    this.input = new EditorInputBinding(this.view, this.controller, {
      onCommand: (command) => this.runCommand(command),
      interceptors,
      // Язык: по нему ввод выбирает знак комментария для Ctrl+/.
      language: () => this.languageId,
      // Вставили кусок — говорим приложению, где он лёг: оно решает, форматировать ли
      // (настройка `editor.formatOnPaste`) и умеет ли это сервер для языка файла.
      onPasted: (range) => this.afterPaste(range),
      // Vim-режим: модальный разбор клавиш снаружи обычной раскладки.
      vimMode: options.vimMode,
      onVimModeChange: options.onVimModeChange,
      // Vim `/`, `?`, `n`, `N`: строку поиска ведёт панель поиска редактора, а не Vim.
      onVimSearch: (action) => {
        if (action.kind === 'open') this.find.show('find');
        else this.find.searchStep(action.forward ? 1 : -1);
      },
      // Emacs-режим: сочетания Ctrl/Alt поверх обычного ввода.
      emacsMode: options.emacsMode,
    });
    // После закрытия панели фокус возвращается в текст: работа продолжается там.
    this.find.onClose = () => this.input.focus();
    this.goto.onClose = () => this.input.focus();
    // Ctrl+Click по слову — переход к определению (жест от обработчика открытия).
    // Слушаем в фазе захвата: иначе ввод успеет начать выделение.
    this.viewport?.addEventListener('mousedown', this.onViewMouseDown, true);

    // Внешняя замена буфера (диск, форматирование, правки агента) прошла мимо контроллера:
    // текст на экране устарел, и о ней надо перерисовать самим.
    const bufferSubscription = this.registry.onDidChangeBuffer((path) => this.onExternalBufferChange(path));
    this.unsubscribeBuffer = () => bufferSubscription.dispose();
    // Словарь пополнился словом — прежние отметки могли устареть, перепроверяем.
    const spellSubscription = this.spell?.onDidChange(() => this.refreshSpell());
    this.unsubscribeSpell = () => spellSubscription?.dispose();
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
    // Копия «заглянуть» относилась к прежнему файлу — прячем её вместе с ним.
    this.peek?.hide();

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
    // Орфография у файла своя: проверяем заново по языку и тексту нового документа.
    this.refreshSpell();
    if (!document.readOnly) {
      // Свёртка — тоже про файл: диапазоны нового берём у сервера или считаем по отступам.
      void this.refreshFolds();
      // Код-линзы, как и свёртка, про конкретный файл: прежние к новому не относятся.
      void this.refreshLenses();
      // Подсказки-вставки — тоже про файл: у прежнего они свои.
      void this.refreshInlayHints();
      // Знаки-триггеры сервера — про язык файла: по ним попап открывается после знака.
      void this.refreshTriggerCharacters(document.path);
      // Ссылки в коде — про файл: у прежнего они свои.
      void this.refreshDocumentLinks();
      // Семантическая подсветка — про файл: у прежнего роли свои.
      void this.refreshSemanticTokens();
      // Значения отладчика принадлежат остановленному файлу: у нового их нет.
      this.view.setInlineValues(this.debugInlineValues?.path === document.path ? this.debugInlineValues.values : []);
    }
    this.input.focus();
    this.emitCursor();
  }

  /**
   * Правки извне — ассистент, языковой сервер. Переводим позиции LSP в смещения буфера и
   * применяем ОДНИМ шагом истории: отмена должна вернуть всё разом.
   *
   * Применяет кто-то ОДИН. Открытый файл правит контроллер: правка ложится в историю и
   * уходит в документ (см. `onControllerChange`). Файл за кадром правит сам документ —
   * в буфер его донесёт реестр, и о замене узнают все панели с этим файлом. Двух
   * применений быть не должно: дошедшая второй раз правка ложится в текст повторно,
   * а совпавший `oldText` повтор не отсекает — от этого в файлах задваивались строки.
   */
  applyEdits(document: TextDocument, edits: readonly TextEdit[], source: EditSource = 'programmatic'): TranslatedEdits {
    // Файл только для чтения правок не принимает — ни от ассистента, ни от сервера.
    if (document.readOnly) return { changes: [], skipped: [] };
    const buffer = this.registry.resolve(document);
    const translated = translateEdits(buffer, edits);
    if (translated.changes.length === 0) return translated;

    if (this.path === document.path) {
      this.controller.applyEdits(translated.changes);
    } else {
      // За кадром: текст правит документ — истина о содержимом, а буфер подтянет реестр.
      // Так же приходят правки с диска и форматирование при сохранении.
      document.applyEdits(edits, source);
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

  /** Запись макроса идёт? Об этом приложению говорит ввод — он её и ведёт. */
  isRecordingMacro(): boolean {
    return this.input.isRecordingMacro();
  }

  /** Записанные шаги макроса: столько действий повторит «выполнить макрос». */
  macroSteps(): readonly MacroStep[] {
    return this.input.macroSteps();
  }

  /** Начать запись макроса. */
  startMacro(): void {
    this.input.startMacro();
  }

  /** Закончить запись и отдать записанное. */
  stopMacro(): readonly MacroStep[] {
    return this.input.stopMacro();
  }

  /** Выполнить макрос (без аргумента — записанный). Возврат — сколько шагов выполнено. */
  playMacro(steps?: readonly MacroStep[]): number {
    return this.input.playMacro(steps);
  }

  /** Взять макрос из сессии проекта: повтор доступен сразу после перезапуска. */
  restoreMacro(steps: readonly MacroStep[]): void {
    this.input.restoreMacro(steps);
  }

  /** Текущий режим Vim панели (при выключенном — «вставка»). */
  vimMode(): VimMode {
    return this.input.vimMode();
  }

  /** Включить или выключить Vim-режим (настройка `editor.vimMode`). */
  setVimMode(on: boolean): void {
    this.input.setVimMode(on);
  }

  /** Включить или выключить Emacs-режим (настройка `editor.emacsMode`). */
  setEmacsMode(on: boolean): void {
    this.input.setEmacsMode(on);
  }

  /** Настройки редактора, влияющие на вид: отступ (Tab), кегль, высота строки и каретка. */
  applyOptions(options: {
    tabSize?: number;
    fontSize?: number;
    lineHeight?: number;
    cursorStyle?: CursorStyle;
    cursorBlink?: boolean;
    rulers?: readonly number[];
    whitespace?: WhitespaceMode;
    minimap?: boolean;
    wordWrap?: boolean;
    smoothScroll?: boolean;
    vimMode?: boolean;
    emacsMode?: boolean;
    ligatures?: boolean;
    spellcheck?: boolean;
  }): void {
    if (options.tabSize !== undefined) {
      this.indentSize = options.tabSize;
      this.controller.setTabSize(options.tabSize);
      this.view.setTabSize(options.tabSize);
    }
    if (options.fontSize !== undefined) this.view.setFontSize(options.fontSize);
    if (options.lineHeight !== undefined) this.view.setLineHeight(options.lineHeight);
    if (options.cursorStyle !== undefined) this.view.setCursorStyle(options.cursorStyle);
    if (options.cursorBlink !== undefined) this.view.setCursorBlink(options.cursorBlink);
    if (options.rulers !== undefined) this.view.setRulers(options.rulers);
    if (options.whitespace !== undefined) this.view.setWhitespace(normalizeWhitespaceMode(options.whitespace));
    if (options.minimap !== undefined) this.view.setMinimap(options.minimap);
    if (options.wordWrap !== undefined) this.view.setWordWrap(options.wordWrap);
    if (options.smoothScroll !== undefined) this.view.setSmoothScroll(options.smoothScroll);
    if (options.vimMode !== undefined) this.input.setVimMode(options.vimMode);
    if (options.emacsMode !== undefined) this.input.setEmacsMode(options.emacsMode);
    if (options.ligatures !== undefined) this.view.setLigatures(options.ligatures);
    // Проверку включили или выключили: отметки пересчитываем или снимаем.
    if (options.spellcheck !== undefined) this.refreshSpell();
  }

  /** Текущий текст файла по буферу (`null` — файл в реестре не открыт). */
  currentText(path: string): string | null {
    return this.registry.get(path)?.text ?? null;
  }

  /** Сменить схему оформления: цвета токенов переставляются на слое вида. */
  refreshTheme(): void {
    this.view.refreshTheme();
    // Копия красится той же палитрой — переставляем и её цвета.
    this.peekWidget?.refreshTheme();
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

  /** Независимая отмена: убирает правку только главной каретки. */
  undoAtCursor(): void {
    this.controller.undoAtCursor();
  }

  /** Независимый повтор для главной каретки. */
  redoAtCursor(): void {
    this.controller.redoAtCursor();
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

  /**
   * Ctrl+Alt+Enter — закончить текущий оператор: закрыть скобки, поставить двоеточие
   * у заголовка блока Python или точку с запятой у JS и перейти на новую строку.
   *
   * Выделение не трогаем: закончить оператор можно только там, где стоит одна каретка.
   */
  completeStatement(): void {
    const { anchor, active } = this.controller.selection;
    if (anchor !== active) return;
    const file = this.path;
    if (file === null) return;
    const text = this.currentText(file);
    if (text === null) return;
    const done = completeStatement(text, active, this.languageId, ' '.repeat(this.indentSize));
    if (!done) return;
    const caret = active + (done.caret ?? done.insert.length);
    this.controller.applyEdits([{ start: active, removed: '', inserted: done.insert }], {
      anchor: caret,
      active: caret,
    });
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
   * Вставка легла в буфер. Превращаем смещения в 1-based диапазон и отдаём приложению,
   * если оно умеет форматировать участок: сам редактор о настройках не знает.
   */
  private afterPaste(range: { start: number; end: number }): void {
    if (!this.formatRangeHandler || !this.path) return;
    // Форматирование на вставке — настройка: без неё вставка текста остаётся как была.
    if (this.formatOnPaste?.() !== true) return;
    const buffer = this.controller.bufferRef;
    const from = buffer.positionAt(range.start);
    const to = buffer.positionAt(range.end);
    this.formatRangeHandler(this.path, {
      startLine: from.line,
      startColumn: from.column,
      endLine: to.line,
      endColumn: to.column,
    });
  }

  /** Обернуть выделение парой знаков. `false` — оборачивать нечем (нет буфера). */
  surroundSelection(option: SurroundOption): boolean {
    if (!this.path) return false;
    this.controller.surroundSelection(option);
    return true;
  }

  /** Есть ли сейчас непустое выделение — по нему решают, оборачивать или вставлять. */
  hasSelection(): boolean {
    return !isEmpty(this.controller.selection);
  }

  /**
   * Диапазон выделения в 1-based виде — таким его ждёт форматирование участка
   * (`textDocument/rangeFormatting`). Пустое выделение даёт нулевую ширину.
   */
  selectionRange(): { startLine: number; startColumn: number; endLine: number; endColumn: number } {
    const selection = this.controller.selection;
    const buffer = this.controller.bufferRef;
    const start = Math.min(selection.anchor, selection.active);
    const end = Math.max(selection.anchor, selection.active);
    const from = buffer.positionAt(start);
    const to = buffer.positionAt(end);
    return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
  }

  /** Язык открытого файла: по нему выбираются доступные обёртки. */
  get documentLanguage(): string {
    return this.languageId;
  }

  /**
   * Отформатировать выделение (или строку под кареткой, если ничего не выделено).
   * `false` — форматировать участок нечем: нет шва или открытого файла.
   */
  formatSelection(): boolean {
    if (!this.formatRangeHandler || !this.path) return false;
    // Выделения нет — берём строку под кареткой: форматировать «ничего» бессмысленно,
    // а форматировать весь файл — это другая команда (`format.document`).
    const range = this.selectionRange();
    const buffer = this.controller.bufferRef;
    const line = buffer.lineAt(this.controller.caret);
    const text = buffer.lineText(line);
    const effective =
      range.startLine === range.endLine && range.startColumn === range.endColumn
        ? { startLine: line, startColumn: 1, endLine: line, endColumn: text.length + 1 }
        : range;
    this.formatRangeHandler(this.path, effective);
    return true;
  }

  /**
   * Показать файлы «на месте», не открывая вкладок (просмотр из дерева). Якорь — у
   * строки дерева (если задан), иначе у каретки. `false` — показывать нечем.
   */
  peekFiles(paths: readonly string[], anchor?: PeekAnchor): boolean {
    if (!this.peek || paths.length === 0) return false;
    this.navigation?.hide();
    this.peek.peekFiles(paths, anchor);
    return true;
  }

  /** Отдать клавишу показанной копии (фокус бывает вне редактора — например, в дереве). */
  handlePeekKey(event: KeyboardEvent): boolean {
    return this.peek?.handleKey(event) ?? false;
  }

  /** Заглянуть в определение, не уходя из файла. `false` — заглядывать нечем. */
  peekDefinition(): boolean {
    if (!this.peek) return false;
    // Список мест — другой способ показать то же самое: два попапа разом не нужны.
    this.navigation?.hide();
    this.peek.peekDefinition();
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
    decorations.setLinks(this.buildLinks(path));

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
    for (const item of this.profileLines.get(path) ?? []) {
      backgrounds.push({ line: item.line, className: `profile-line is-hot-${item.level}` });
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

  /**
   * Волнистые подчёркивания: пометки языка (серьёзность — класс) и ошибки орфографии
   * (класс `is-spelling`). Оба вида рисуются одинаково, поэтому идят одним списком.
   */
  private buildSquiggles(path: string) {
    const items = (this.externalMarkers.get(path) ?? []).map((item) => ({
      line: item.line,
      startColumn: item.column,
      // Многострочная пометка подчёркивается до конца своей первой строки.
      endColumn: item.endLine === item.line ? Math.max(item.endColumn, item.column + 1) : Number.MAX_SAFE_INTEGER,
      className: severityClass(item.severity),
    }));
    for (const problem of this.spellProblems.get(path) ?? []) {
      items.push({
        line: problem.line,
        startColumn: problem.startColumn,
        endColumn: problem.endColumn,
        className: 'is-spelling',
      });
    }
    return items;
  }

  // — проверка орфографии —

  /**
   * Пересчитать ошибки орфографии активного файла и показать их волнистым
   * подчёркиванием. Проверяем только открытый файл: у прочих нет ни буфера под рукой,
   * ни языка. Файл только для чтения не проверяем — как и всё прочее для него.
   */
  private refreshSpell(): void {
    const path = this.path;
    if (!path) return;
    const enabled = this.spell !== undefined && this.spellEnabled?.() === true && !this.readOnly;
    if (!enabled) {
      if (this.spellProblems.delete(path)) this.refreshDecorations(path);
      return;
    }
    const buffer = this.registry.get(path);
    if (!buffer) return;
    const problems = this.computeSpellProblems(buffer);
    if (problems.length === 0) this.spellProblems.delete(path);
    else this.spellProblems.set(path, problems);
    this.refreshDecorations(path);
  }

  /** Пересчитать с паузой: на каждую букву проверять целый файл незачем. */
  private scheduleSpell(): void {
    if (!this.spell || this.spellEnabled?.() !== true) return;
    if (this.spellTimer !== null) window.clearTimeout(this.spellTimer);
    this.spellTimer = window.setTimeout(() => {
      this.spellTimer = null;
      this.refreshSpell();
    }, SPELL_REFRESH_DELAY_MS);
  }

  /** Все ошибки буфера: по строкам, в участках, которые для этого языка — проза. */
  private computeSpellProblems(buffer: TextBuffer): SpellProblem[] {
    const lexicon = this.spell;
    if (!lexicon) return [];
    const problems: SpellProblem[] = [];
    const lines = Math.min(buffer.lineCount, MAX_SPELL_LINES);
    for (let line = 1; line <= lines; line += 1) {
      const text = buffer.lineText(line);
      if (!text) continue;
      const ranges = this.spellScopesFor(line);
      for (const problem of spellProblemsInLine(line, text, (word) => lexicon.knows(word), ranges)) {
        problems.push(problem);
      }
    }
    return problems;
  }

  /**
   * Где в строке искать слова. В коде — только в комментариях и строках: имена и
   * ключевые слова там не проза, проверять их значило бы шуметь. Текст без грамматики
   * и «прозаические» языки (markdown, простой текст) проверяем целиком.
   */
  private spellScopesFor(line: number): readonly CharRange[] | undefined {
    if (PROSE_LANGUAGES.has(this.languageId) || !this.view.hasHighlighting()) return undefined;
    const ranges: CharRange[] = [];
    for (const token of this.view.tokensFor(line)) {
      if (token.type === COMMENT || token.type === STRING) ranges.push({ start: token.start, end: token.end });
    }
    return ranges;
  }

  /**
   * Слово под кареткой (`null` — под ней не слово). Нужно команде «где экспортируется»:
   * имя берётся оттуда, где стоит человек, а не из отдельного поля ввода.
   */
  wordAtCursor(): string | null {
    const info = wordInfoAt(this.controller.bufferRef, this.controller.caret);
    return info ? info.word : null;
  }

  /** Слово под курсором, если оно отмечено как ошибка орфографии (`null` — нет). */
  spellingWordAtCursor(): string | null {
    const path = this.path;
    if (!path) return null;
    return this.spellingProblemAtCursor(path)?.word ?? null;
  }

  /** Добавить слово под курсором в словарь человека. `false` — под курсором не ошибка. */
  addSpellingWordToDictionary(): boolean {
    const word = this.spellingWordAtCursor();
    if (!word) return false;
    this.spellSaveWord?.(word);
    this.spell?.addUserWord(word);
    return true;
  }

  /** Пропустить слово под курсором на этот сеанс. `false` — под курсором не ошибка. */
  ignoreSpellingWord(): boolean {
    const word = this.spellingWordAtCursor();
    if (!word) return false;
    this.spell?.ignore(word);
    return true;
  }

  /**
   * Слово под курсором с ошибкой и похожие слова из словаря — свои быстрые правки без
   * языкового сервера. `null` — под курсором не слово с ошибкой (или словаря нет).
   */
  spellingSuggestionsAtCursor(limit = 5): { word: string; suggestions: string[] } | null {
    const word = this.spellingWordAtCursor();
    if (!word) return null;
    return { word, suggestions: this.spell?.suggest(word, limit) ?? [] };
  }

  /** Заменить слово под курсором одним шагом истории. `false` — под курсором не ошибка. */
  replaceSpellingWord(replacement: string): boolean {
    const path = this.path;
    if (!path || replacement.length === 0) return false;
    const problem = this.spellingProblemAtCursor(path);
    if (!problem) return false;
    const buffer = this.controller.bufferRef;
    const start = buffer.offsetAt({ line: problem.line, column: problem.startColumn });
    const end = buffer.offsetAt({ line: problem.line, column: problem.endColumn });
    const removed = buffer.getText(start, end);
    if (removed === replacement) return false;
    const caret = start + replacement.length;
    this.controller.applyEdit({ start, removed, inserted: replacement }, { anchor: caret, active: caret });
    return true;
  }

  /** Ошибка орфографии ровно под кареткой (`null` — под ней нет слова с ошибкой). */
  private spellingProblemAtCursor(path: string): SpellProblem | null {
    const problems = this.spellProblems.get(path);
    if (!problems || problems.length === 0) return null;
    const position = this.cursorPosition();
    for (const problem of problems) {
      if (problem.line !== position.line) continue;
      if (position.column >= problem.startColumn && position.column <= problem.endColumn) return problem;
    }
    return null;
  }

  /** Пересчитать проверку (настройку включили/выключили или словарь подгрузился). */
  refreshSpellcheck(): void {
    this.refreshSpell();
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

  /**
   * Горячие строки профиля: наборы по файлам, целиком. Пусто — подсветку снять.
   * Уровень «жара» считает приложение: тут он уже готов, редактор только красит.
   */
  setLineProfile(files: Iterable<ProfileLineEntry>): void {
    const affected = new Set(this.profileLines.keys());
    this.profileLines.clear();
    for (const [path, rows] of files) {
      if (rows.length === 0) continue;
      this.profileLines.set(path, rows);
      affected.add(path);
    }
    for (const path of affected) this.refreshDecorations(path);
  }

  /** Красная строка на строке отладчика. `null` — подсветку убрать. */
  /**
   * Показать значения переменных в строках файла (во время останова отладки). Значения
   * считает приложение (у него и языковой сервер, и отладчик); сюда они приходят готовыми.
   * Пустой список или `null` — снять показ.
   */
  setDebugInlineValues(path: string | null, values: readonly DebugInlineValue[]): void {
    if (!path || values.length === 0) {
      if (this.debugInlineValues && (path === null || this.debugInlineValues.path === path)) {
        this.debugInlineValues = null;
        this.view.setInlineValues([]);
      }
      return;
    }
    this.debugInlineValues = { path, values };
    this.view.setInlineValues(this.path === path ? values : []);
  }

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
    this.view.onLinkClick = (line, column) => this.onLinkClick(line, column);
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
    // Ассистент держит отложенный запрос к серверу — снимаем его вместе с видом.
    this.assistant.dispose();
    this.locations?.dispose();
    this.peekWidget?.dispose();
    this.inline?.dismiss();
    if (this.foldTimer !== null) window.clearTimeout(this.foldTimer);
    if (this.lensTimer !== null) window.clearTimeout(this.lensTimer);
    if (this.inlayTimer !== null) window.clearTimeout(this.inlayTimer);
    if (this.linkTimer !== null) window.clearTimeout(this.linkTimer);
    if (this.linkedTimer !== null) window.clearTimeout(this.linkedTimer);
    if (this.semanticTimer !== null) window.clearTimeout(this.semanticTimer);
    if (this.spellTimer !== null) window.clearTimeout(this.spellTimer);
    this.unsubscribeSpell();
    this.view.dispose();
    this.cursorEmitter.dispose();
    this.changeTextEmitter.dispose();
    this.changeStripMenuEmitter.dispose();
  }

  /**
   * Показать панель или пойти по символу по команде ввода (`Ctrl+F`, `Ctrl+G`, `F1`,
   * `F12`, `Shift+F12`, `Ctrl+Shift+F12`).
   */
  private runCommand(command: CommandName): void {
    if (command === 'gotoLine') this.goto.show();
    else if (command === 'palette') this.openPalette?.();
    else if (command === 'codeActions') {
      // Быстрые исправления — дело приложения: ему и сервер, и список, и правки.
      if (this.path) this.codeActions?.(this.path, this.cursorPosition());
    } else if (command === 'goToDefinition') this.goToDefinition();
    else if (command === 'references') this.findReferences();
    else if (command === 'peekDefinition') this.peekDefinition();
    else if (command === 'surroundWith') this.surroundWithHandler?.();
    else if (command === 'formatSelection') this.formatSelection();
    else if (command === 'expandSelection') this.expandSelection();
    else if (command === 'shrinkSelection') this.shrinkSelection();
    else if (command === 'completeStatement') this.completeStatement();
    else this.find.show(command === 'replace' ? 'replace' : 'find');
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
        // Ссылки в коде привязаны к тексту — после правки перезапрашиваем.
        this.scheduleDocumentLinks();
        // Связанные участки держит контроллер; виду отдаём их смещения сразу, а у
        // сервера переспросим с паузой (см. scheduleLinkedEditing).
        this.view.setLinkedRanges(this.controller.linkedRanges ?? []);
        // Семантические роли привязаны к тексту — после правки переспрашиваем с паузой.
        this.scheduleSemanticTokens();
        // Орфография — своя, локальная: пересчитываем по тексту с паузой.
        this.scheduleSpell();
      }
      this.cursors.set(this.path, this.cursorPosition());
    }
    this.scheduleLinkedEditing();
    this.emitCursor();
  }

  // — ссылки в коде —

  /** Ссылки файла в виде украшений: участок и подпись наведения. */
  private buildLinks(path: string): readonly LinkDecoration[] {
    return (this.documentLinks.get(path) ?? []).map((link) => ({
      line: link.line,
      startColumn: link.startColumn,
      endColumn: link.endColumn,
      ...((link.target ?? link.tooltip) ? { tooltip: link.target ?? link.tooltip } : {}),
    }));
  }

  /** Ссылки файла: спросить у приложения и перерисовать украшения. */
  private async refreshDocumentLinks(): Promise<void> {
    if (this.readOnly) return;
    const source = this.documentLinkSource;
    const path = this.path;
    if (!source || !path) return;
    const id = (this.linkRequestId += 1);
    const links = await source(path).catch(() => []);
    // Пока спрашивали, файл сменился — ответ уже не к месту.
    if (id !== this.linkRequestId || this.path !== path) return;
    if (links.length === 0) this.documentLinks.delete(path);
    else this.documentLinks.set(path, links);
    this.refreshDecorations(path);
  }

  /** Пересчитать ссылки с паузой: на каждое нажатие дёргать сервер незачем. */
  private scheduleDocumentLinks(): void {
    if (!this.documentLinkSource) return;
    if (this.linkTimer !== null) window.clearTimeout(this.linkTimer);
    this.linkTimer = window.setTimeout(() => {
      this.linkTimer = null;
      void this.refreshDocumentLinks();
    }, LENS_REFRESH_DELAY_MS);
  }

  /** Клик по ссылке: находим свою по строке и столбцу — и отдаём адрес приложению. */
  private onLinkClick(line: number, column: number): void {
    const path = this.path;
    if (!path || !this.openLink) return;
    const link = (this.documentLinks.get(path) ?? []).find(
      (item) => item.line === line && column >= item.startColumn && column < item.endColumn,
    );
    if (link?.target) this.openLink(link.target, path);
  }

  // — связанные участки (linkedEditing) —

  /** Связанные участки с паузой: по движению курсора дёргать сервер незачем. */
  private scheduleLinkedEditing(): void {
    if (!this.linkedSource) return;
    if (this.linkedTimer !== null) window.clearTimeout(this.linkedTimer);
    this.linkedTimer = window.setTimeout(() => {
      this.linkedTimer = null;
      void this.refreshLinkedEditing();
    }, LINKED_REFRESH_DELAY_MS);
  }

  /**
   * Спросить у сервера связанные участки под курсором и поставить их контроллеру и виду.
   * Связь — только для одной каретки без выделения: при выделении «править вместе» нечего,
   * и подсветка была бы непонятной. Пустой ответ (или несколько кареток) снимает связь.
   */
  private async refreshLinkedEditing(): Promise<void> {
    const source = this.linkedSource;
    const path = this.path;
    const single = this.controller.selections.length === 1 && isEmpty(this.controller.selection);
    if (!source || !path || this.readOnly || !single) {
      this.clearLinked();
      return;
    }
    const id = (this.linkedRequestId += 1);
    const buffer = this.controller.bufferRef;
    const ranges = await source(path, this.cursorPosition()).catch(() => []);
    if (id !== this.linkedRequestId || this.path !== path) return;
    const offsets = ranges.map((range) => ({
      start: buffer.offsetAt({ line: range.line, column: range.startColumn }),
      end: buffer.offsetAt({ line: range.line, column: range.endColumn }),
    }));
    this.controller.setLinkedRanges(offsets);
    this.view.setLinkedRanges(this.controller.linkedRanges ?? []);
  }

  /** Снять связь: её больше не держат ни сервер, ни контроллер, ни вид. */
  private clearLinked(): void {
    this.controller.setLinkedRanges(null);
    this.view.setLinkedRanges([]);
  }

  // — выделение по структуре (Expand/Shrink Selection) —

  /** Выделить по структуре ШИРЕ: следующий объёмлющий участок от сервера. */
  expandSelection(): void {
    void this.stepSelection('expand');
  }

  /** Выделить УЖЕ: вернуться к вложенному участку, а с самого узкого — к каретке. */
  shrinkSelection(): void {
    void this.stepSelection('shrink');
  }

  /**
   * Шаг «выделить по структуре»: спросить у сервера цепочку участков вокруг выделения
   * и перейти на соседний по направлению.
   *
   * Состояния не держим: и «шире», и «уже» считаются от ТЕКУЩЕГО выделения и свежей
   * цепочки (`stepSelection`). Так команда не разъезжается с тем, что человек выделил
   * руками: шире берётся ближайший объемлющий узел, уже — самый глубокий вложенный.
   */
  private async stepSelection(direction: SelectionStep): Promise<void> {
    const source = this.selectionSource;
    const path = this.path;
    if (!source || !path) return;

    const buffer = this.controller.bufferRef;
    const selection = this.controller.selection;
    const current = isEmpty(selection) ? null : spanOfSelection(buffer, selection);
    // Спрашиваем у САМОГО ЛЕВОГО края выделения: он точно внутри нужных узлов, а край
    // промежутка может уже выпасть из узкого участка.
    const from = buffer.positionAt(Math.min(selection.anchor, selection.active));

    const id = (this.selectionRequestId += 1);
    const spans = await source(path, { line: from.line, column: from.column }).catch(() => []);
    if (id !== this.selectionRequestId || this.path !== path) return;

    const next = stepSelection(spans, current, direction);
    if (next) {
      const start = buffer.offsetAt({ line: next.startLine, column: next.startColumn });
      const end = buffer.offsetAt({ line: next.endLine, column: next.endColumn });
      this.controller.setSelection({ anchor: start, active: end });
    } else if (direction === 'shrink' && current) {
      // Уже самого узкого участка нет — сворачиваем выделение к каретке.
      this.controller.setSelection(caret(selection.active));
    }
  }

  // — семантическая подсветка —

  /** Семантические токены с паузой: сервер разбирает файл целиком — не на каждую букву. */
  private scheduleSemanticTokens(): void {
    if (!this.semanticSource) return;
    if (this.semanticTimer !== null) window.clearTimeout(this.semanticTimer);
    this.semanticTimer = window.setTimeout(() => {
      this.semanticTimer = null;
      void this.refreshSemanticTokens();
    }, SEMANTIC_REFRESH_DELAY_MS);
  }

  /** Спросить у сервера семантическую подсветку файла и отдать её виду. */
  private async refreshSemanticTokens(): Promise<void> {
    if (this.readOnly) return;
    const source = this.semanticSource;
    const path = this.path;
    if (!source || !path) return;
    const id = (this.semanticRequestId += 1);
    const tokens = await source(path, this.languageId).catch(() => []);
    // Пока спрашивали, файл сменился — ответ уже не к месту.
    if (id !== this.semanticRequestId || this.path !== path) return;
    this.view.setSemanticTokens(tokens);
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

  /**
   * Знаки-триггеры сервера для открытого файла. Запоминаем их в попапе подсказок:
   * по ним список открывается сразу после знака (`@`, `:`), а не только по точке.
   */
  private async refreshTriggerCharacters(path: string, attempt = 0): Promise<void> {
    const source = this.completionTriggersSource;
    if (!source) return;
    const id = (this.triggersRequestId += 1);
    const triggers = await source(path).catch(() => null);
    // Пока спрашивали, файл сменился — знаки прошлого к этому не относятся.
    if (id !== this.triggersRequestId || this.path !== path) return;
    const characters = triggers?.triggerCharacters ?? [];
    this.assistant.setTriggerCharacters(characters);
    // Пусто — сервер мог ещё не подняться (его стартует main при открытии файла):
    // один повтор, когда он наверняка готов; за это время файл мог смениться.
    if (characters.length === 0 && attempt === 0) {
      window.setTimeout(() => {
        if (this.path === path) void this.refreshTriggerCharacters(path, 1);
      }, 800);
    }
  }

  /** Клик по линзе строки: исполняем команду, которую положил в неё сервер. */
  private onLensClick(line: number): void {
    const path = this.path;
    if (!path || !this.lensCommand) return;
    const entry = (this.codeLenses.get(path) ?? []).find((item) => item.range.start.line + 1 === line);
    if (entry?.command) this.lensCommand(path, entry.command);
  }

  /**
   * Пометки активного файла, накрывающие смещение: их текст показывает карточка
   * наведения. Координаты пометок — строка и столбец с единицы, как их видит редактор.
   */
  private problemsAtOffset(offset: number): readonly HoverProblem[] {
    const path = this.path;
    if (!path) return [];
    const markers = this.externalMarkers.get(path);
    if (!markers || markers.length === 0) return [];
    const position = this.controller.bufferRef.positionAt(offset);
    return problemsAt(markers, position);
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

/** Выделение в виде участка (строка/столбец, 1-based) — для сравнения с ответом сервера. */
function spanOfSelection(buffer: TextBuffer, selection: Selection): SelectionSpan {
  const start = buffer.positionAt(Math.min(selection.anchor, selection.active));
  const end = buffer.positionAt(Math.max(selection.anchor, selection.active));
  return { startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column };
}

/** Класс серьёзности пометки для волнистого подчёркивания (`editor.css`). */
function severityClass(severity: LspDiagnostic['severity']): string {
  if (severity === 'error') return 'is-error';
  if (severity === 'warning') return 'is-warning';
  return 'is-info';
}
