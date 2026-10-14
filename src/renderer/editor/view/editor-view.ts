/**
 * Представление редактора: текст на экране.
 *
 * Модель текста (`core/text-buffer.ts`) знает, что где лежит, но ничего не знает о
 * пикселях. Этот слой переводит её в картинку: держит прокрутку, рисует видимые
 * строки, ставит каретку и заливает выделение.
 *
 * Виртуализация — главное решение здесь. Файл бывает в сто тысяч строк, а узлов в
 * DOM держим полсотни: только видимые строки плюс запас (`viewport.ts`). Остальная
 * высота — пустая распорка нужного размера, чтобы полоса прокрутки показывала
 * настоящую длину файла. Строки за экраном в DOM не существуют вовсе — поэтому
 * прокрутка большого файла не тормозит.
 *
 * Строки лежат слоем, который просто СДВИГАЕТСЯ по вертикали на высоту первой
 * видимой строки (`translateY`). Пересобирать их при каждой прокрутке не нужно —
 * двигаем готовое. Номера строк живут отдельным слоем слева: он не едет по
 * горизонтали, поэтому при прокрутке вбок номера остаются на месте, как в любом
 * редакторе.
 *
 * Каретка и выделение — абсолютно расположенные прямоугольники НАД текстом, а не
 * разметка внутри него. Заливать знаки фоном значило бы перерисовывать строку на
 * каждое движение каретки; отдельные прямоугольники дёшевы и не трогают текст.
 *
 * Модуль требует DOM: он браузерный. Арифметика вынесена в чистые модули рядом
 * (`line-layout.ts`, `viewport.ts`, `selection.ts`) и проверяется в тестах без окна.
 */

import type { TextBuffer } from '../core/text-buffer';
import { LineHighlighter } from '../highlight/highlighter';
import { sharedTokens } from '../highlight/token-cache';
import { grammarFor } from '../highlight/registry';
import type { Token } from '../highlight/tokens';
import { paletteOf, roleOfToken, type Scheme } from '../highlight/style';
import { overlayRanges, type RoleRange } from '../highlight/overlay';
import { semanticTokenRole, type SemanticToken } from '../../../shared/lsp-semantic-tokens';
import type { CursorStyle } from '../../../shared/cursor-style';
import { measureFont, monospaceMetrics, type GlyphMetrics } from './glyph-metrics';
import { scrollFinished, scrollStep } from './smooth-scroll';
import { columnForX, layoutLine, xForColumn } from './line-layout';
import { FileDecorations, squigglyRect, type LensDecoration, type LinkDecoration } from './decorations';
import { findBracketPair, findOccurrences, type BracketPair } from './context-highlight';
import { caret, isEmpty, rangesRects, selectionEnd, selectionStart, type Selection } from './selection';
import { clamp, contentHeight, lineAtY, maxScrollLeft, maxScrollTop, revealLine, visibleLines } from './viewport';
import { FoldModel } from './fold-model';
import { RowMap } from './row-map';
import { segmentIndexForColumn, wrapSegments, type WrapSegment } from './wrap-model';
import { BracketDepth, RAINBOW_SIZE } from './bracket-rainbow';
import { todoMarks } from '../../../shared/todo-comments';
import type { InlayHint } from '../../../shared/lsp-inlay-hints';
import { enclosingFoldRanges, type FoldRange } from '../../../shared/fold-ranges';
import { whitespaceMarks, type WhitespaceMode } from './whitespace';
import { Minimap } from './minimap';

/** Класс корня и его частей — за него цепляется оформление (`styles/editor.css`). */
const ROOT_CLASS = 'own-editor';

export interface EditorViewOptions {
  /** Метрики шрифта. Если не заданы, измеряются в браузере по `font-family` корня. */
  metrics?: GlyphMetrics;
  /** Показывать номера строк слева. По умолчанию — да. */
  gutter?: boolean;
  /** Сколько строк держать сверх видимых (см. `viewport.ts`). */
  overscan?: number;
  /** Язык подсветки (идентификатор из реестра языков). Без него текст показывается как простой. */
  language?: string;
  /** Схема оформления: от неё зависят цвета токенов. */
  scheme?: Scheme;
  /** Ширина поля значков (точек останова, запуска, тестов) в пикселях. */
  glyphWidth?: number;
  /** Показывать ли невидимые знаки (пробелы точками, табуляции стрелкой). */
  whitespace?: WhitespaceMode;
  /** Показывать ли миникарту — сжатый вид всего файла у правого края. */
  minimap?: boolean;
  /** Включать ли лигатуры шрифта (`=>`, `!=`, `->` одним знаком). */
  ligatures?: boolean;
}

/** Ширина полосы украшений (черта изменений git) — узкая, как в Monaco. */
const STRIP_WIDTH = 3;

/** Вставка строки: что показать, где и сколько места она занимает. */
/** Значение отладчика для показа в строке: место (строка и столбец с нуля) и подпись. */
export interface DebugInlineValue {
  readonly line: number;
  readonly column: number;
  readonly label: string;
}

interface InlayItem {
  /** Смещение-граница в строке (с нуля): после него идёт вставка. */
  readonly column: number;
  readonly text: string;
  readonly width: number;
  readonly className: string;
}

/** Строка, уже разложенная по x (кэш раскладки на видимых строк). */
interface LineLayoutCache {
  version: number;
  line: number;
  offsets: number[];
}

export class EditorView {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly linesLayer: HTMLElement;
  /** Вертикальные направляющие столбцов (ruler) — тонкие черты через всю высоту. */
  private readonly rulerLayer: HTMLElement;
  private readonly backgroundLayer: HTMLElement;
  private readonly selectionLayer: HTMLElement;
  private readonly searchLayer: HTMLElement;
  /** Вхождения слова под курсором и подсветка парной скобки — фоном под текстом. */
  private readonly highlightLayer: HTMLElement;
  private readonly squigglyLayer: HTMLElement;
  /** Слой ссылок в тексте (`documentLink`): подчёркнутые и кликабельные участки. */
  private readonly linkLayer: HTMLElement;
  private readonly ghostLayer: HTMLElement;
  /** Слой кареток: у мультикурсора их несколько, поэтому каретка — узел внутри слоя. */
  private readonly caretLayer: HTMLElement;
  /** Закреплённые заголовки блоков сверху (sticky scroll) — отдельный слой над полем прокрутки. */
  private readonly stickyLayer: HTMLElement;
  private readonly gutter: HTMLElement | null;
  private readonly gutterLines: HTMLElement | null;
  private readonly glyphMargin: HTMLElement | null;
  private readonly glyphLines: HTMLElement | null;
  private readonly strip: HTMLElement | null;
  private readonly stripLines: HTMLElement | null;
  private readonly overscan: number;
  private readonly resizeObserver: ResizeObserver | null;

  private buffer: TextBuffer;
  /** Метрики меняются один раз — когда догрузится шрифт (см. конструктор). */
  private metrics: GlyphMetrics;
  /** Курсоры. Обычно один; при мультикурсоре — несколько (последний — главный). */
  private selections: Selection[] = [caret(0)];
  private scrollTop = 0;
  /** Плавная прокрутка включена настройкой (и не отменена системой). */
  private smooth = false;
  /**
   * Узлы кареток: их переиспользуем, а не пересоздаём. Новый узел появляется сразу
   * на месте (переходу нечего анимировать), а тот же самый — переезжает: движение
   * каретки читается глазом (см. `.own-editor-caret` в оформлении).
   */
  private caretNodes: HTMLElement[] = [];
  /** Идущая анимация прокрутки (`null` — не идёт). */
  private scrollAnimation: { from: number; to: number; startedAt: number; frame: number; last: number } | null = null;
  private disposed = false;
  /**
   * Перенос длинных строк. Пока выключен, одна строка занимает один ряд и вся
   * арифметика рядов — прежняя; ради этого перевод «столбец → ряд» отделён
   * (`wrap-model.ts`).
   */
  private wrapOn = false;
  /** Таблица визуальных рядов с учётом переноса: строится, только когда перенос включён. */
  private readonly rows = new RowMap();
  /** Ключ, при котором построена таблица рядов (версия, ширина, табуляция, свёртка). */
  private rowsKey = '';
  /** Подсветка видимых строк: кэш токенов по строкам (см. `highlight/highlighter.ts`). */
  private readonly highlighter: LineHighlighter;
  /** Вложенность скобок по строкам — для радужных скобок (см. `bracket-rainbow.ts`). */
  private readonly bracketDepth: BracketDepth;
  private scheme: Scheme;
  /** Сколько строк было в документе: по смене числа понимаем, сдвинулись ли строки. */
  private lineCount = 0;
  /** Совпадения поиска и номер текущего: перерисовываются вместе со строками. */
  private searchMatches: readonly { start: number; end: number }[] = [];
  private searchCurrent = -1;
  /** Вхождения слова под курсором: пересчитываются только когда меняется само слово. */
  private occurrences: readonly { start: number; end: number }[] = [];
  /** Связанные участки (linkedEditing): имена парных тегов, подсвечены все сразу. */
  private linked: readonly { start: number; end: number }[] = [];
  /**
   * Семантические токены сервера по строкам (ключ — строка с нуля, столбцы с нуля).
   * Накладываются поверх грамматики: где сервер высказался, его роль важнее (см.
   * `highlight/overlay.ts`).
   */
  private semantic = new Map<number, RoleRange[]>();
  /** Парная скобка у курсора и её состояние (есть пара или нет). */
  private brackets: BracketPair | null = null;
  /** Самая широкая известная строка: ширину полотна узнаём по мере отрисовки. */
  private widest = 0;
  /** Что сейчас в DOM: версия буфера, границы видимых строк и версия украшений — чтобы не пересобирать зря. */
  private rendered = { version: -1, first: -1, last: -1, decorations: -1, wrap: '', semantic: -1, folds: -1 };
  /** Версия семантической подсветки: она меняет цвета строк, минуя правку текста. */
  private semanticVersion = 0;
  private layoutCache: LineLayoutCache | null = null;
  /**
   * Свёрнутые строки. Пока ничего не свёрнуто, ряд совпадает со строкой и вся
   * арифметика ниже — прежняя; ради этого перевод «строка ↔ ряд» и вынесен сюда.
   */
  private readonly folds = new FoldModel();

  /** Украшения текущего файла: значки, полоски, фон, подписи, подчёркивания. */
  private decorations = new FileDecorations();
  /** Меняется на каждую смену набора украшений: по ней строки пересобираются. */
  private decorationsVersion = 0;
  /** Столбцы направляющих (ruler): у каждого рисуется вертикальная черта. */
  private rulers: readonly number[] = [];
  /** Что из невидимых знаков показывать: ничего, хвостовые или все. */
  private whitespace: WhitespaceMode = 'none';
  /** Миникарта: холст со сжатыми строками и ползунком видимой части. */
  private readonly minimap: Minimap;
  private minimapVisible = false;
  /** Подсказки-вставки по строкам (inlay hints): место, текст, ширина и класс. */
  private inlayByLine = new Map<number, readonly InlayItem[]>();
  /**
   * Значения переменных во время отладки: `x = 42` после имени. Показываются как вставки,
   * но живут отдельно от подсказок языка: те приходят с сервера, эти — от отладчика, и
   * обновление одних не должно затирать другие.
   */
  private inlineValueByLine = new Map<number, readonly InlayItem[]>();
  /** Призрачный текст подсказки «допиши за меня»: смещение и сам текст. */
  private ghost: { offset: number; text: string } | null = null;

  /**
   * Клики по местам украшений. Представление только сообщает «строка и область»:
   * что это значит (запустить файл, переключить точку останова, открыть различие) —
   * дело хозяина. Клик и правый клик разные: у точки останова правый открывает меню,
   * а левый включает и выключает её.
   */
  onGlyphClick: ((line: number, event: MouseEvent) => void) | null = null;
  onGlyphContextMenu: ((line: number, event: MouseEvent) => void) | null = null;
  onStripClick: ((line: number, event: MouseEvent) => void) | null = null;
  onStripContextMenu: ((line: number, event: MouseEvent) => void) | null = null;
  onGutterClick: ((line: number, event: MouseEvent) => void) | null = null;
  onGutterContextMenu: ((line: number, event: MouseEvent) => void) | null = null;
  /** Клик по код-линзе строки: что исполнить — решает хозяин, а не представление. */
  onLensClick: ((line: number) => void) | null = null;
  /** Клик по ссылке в тексте: номер в списке ссылок файла — что делать, решает хозяин. */
  onLinkClick: ((line: number, column: number) => void) | null = null;
  /** Правый клик по самому тексту: меню собирает хозяин, представление только сообщает. */
  onContextMenu: ((event: MouseEvent) => void) | null = null;

  constructor(host: HTMLElement, buffer: TextBuffer, options: EditorViewOptions = {}) {
    this.host = host;
    this.buffer = buffer;
    this.overscan = options.overscan ?? 2;
    this.selections = [caret(0)];
    this.scheme = options.scheme ?? 'dark';
    this.whitespace = options.whitespace ?? 'none';
    this.lineCount = buffer.lineCount;
    // Текст строки подсветка берёт сама — ей довольно функции: так её можно проверить
    // в тестах без модели текста (см. `highlight/highlighter.ts`).
    this.highlighter = new LineHighlighter(
      options.language ? grammarFor(options.language) : null,
      (line) => this.buffer.lineText(line + 1),
      sharedTokens,
    );
    // Радужные скобки берут текст и токены той же строки: разбор подсветки уже есть,
    // второй раз строку не разбираем. Вложенность ведём по всему документу.
    this.bracketDepth = new BracketDepth(
      (line) => this.buffer.lineText(line + 1),
      (line) => this.highlighter.tokensFor(line),
    );

    this.root = document.createElement('div');
    this.root.className = ROOT_CLASS;
    this.root.tabIndex = 0;

    const showGutter = options.gutter ?? true;
    this.gutter = showGutter ? document.createElement('div') : null;
    this.gutterLines = showGutter ? document.createElement('div') : null;
    // Поле значков и полоса украшений — слева и справа от номеров строк.
    this.glyphMargin = document.createElement('div');
    this.glyphLines = document.createElement('div');
    this.strip = document.createElement('div');
    this.stripLines = document.createElement('div');
    // Слой закреплённых заголовков лежит рядом с полем прокрутки (не внутри него):
    // заголовки не должны ехать при прокрутке, поэтому сдвигаем их вручную.
    this.stickyLayer = document.createElement('div');

    this.viewport = document.createElement('div');
    this.viewport.className = `${ROOT_CLASS}-viewport`;
    this.content = document.createElement('div');
    this.content.className = `${ROOT_CLASS}-content`;
    this.rulerLayer = document.createElement('div');
    this.rulerLayer.className = `${ROOT_CLASS}-rulers`;
    this.backgroundLayer = document.createElement('div');
    this.backgroundLayer.className = `${ROOT_CLASS}-backgrounds`;
    this.selectionLayer = document.createElement('div');
    this.selectionLayer.className = `${ROOT_CLASS}-selection`;
    this.searchLayer = document.createElement('div');
    this.searchLayer.className = `${ROOT_CLASS}-search`;
    this.highlightLayer = document.createElement('div');
    this.highlightLayer.className = `${ROOT_CLASS}-highlight`;
    this.squigglyLayer = document.createElement('div');
    this.squigglyLayer.className = `${ROOT_CLASS}-squiggly`;
    this.linkLayer = document.createElement('div');
    this.linkLayer.className = `${ROOT_CLASS}-links`;
    this.linkLayer.addEventListener('click', this.onLinkLayerClick);
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = `${ROOT_CLASS}-ghost-layer`;
    this.linesLayer = document.createElement('div');
    this.linesLayer.className = `${ROOT_CLASS}-lines`;
    this.caretLayer = document.createElement('div');
    this.caretLayer.className = `${ROOT_CLASS}-carets`;

    // Порядок слоёв, снизу вверх: заливка строки, совпадения, выделение, подчёркивания,
    // текст, призрачная подсказка, каретка. Текст читается поверх заливок, а волнистые
    // подчёркивания лежат под ним, но над выделением: пометка важнее заливки, но не
    // закрывает буквы. Призрачная подсказка — над текстом (она дописывает за кареткой),
    // но под кареткой, чтобы та оставалась видна.
    this.content.append(
      this.rulerLayer,
      this.backgroundLayer,
      this.searchLayer,
      this.highlightLayer,
      this.selectionLayer,
      this.squigglyLayer,
      this.linesLayer,
      this.linkLayer,
      this.ghostLayer,
      this.caretLayer,
    );
    this.viewport.append(this.content);

    // Слева направо: поле значков, номера строк, полоса украшений, полотно с кодом.
    this.glyphMargin.className = `${ROOT_CLASS}-glyphs`;
    this.glyphMargin.style.width = `${options.glyphWidth ?? 16}px`;
    this.glyphLines.className = `${ROOT_CLASS}-glyph-lines`;
    this.glyphMargin.append(this.glyphLines);
    this.root.append(this.glyphMargin);

    if (this.gutter && this.gutterLines) {
      this.gutter.className = `${ROOT_CLASS}-gutter`;
      this.gutterLines.className = `${ROOT_CLASS}-gutter-lines`;
      this.gutter.append(this.gutterLines);
      this.root.append(this.gutter);
    }

    this.strip.className = `${ROOT_CLASS}-strip`;
    this.strip.style.width = `${STRIP_WIDTH}px`;
    this.stripLines.className = `${ROOT_CLASS}-strip-lines`;
    this.strip.append(this.stripLines);
    this.stickyLayer.className = `${ROOT_CLASS}-sticky`;
    this.stickyLayer.hidden = true;
    this.root.append(this.strip, this.viewport, this.stickyLayer);
    // Миникарта — узкая колонка справа от поля прокрутки. Живёт всегда, но по
    // умолчанию скрыта: показать её дёшево, а показанная она читает текст каждый кадр.
    this.minimap = new Minimap({
      text: (line) => this.buffer.lineText(line),
      rowCount: () => this.rowCount(),
      lineHeight: () => this.metrics.lineHeight,
      scrollTop: () => this.viewport.scrollTop,
      viewportHeight: () => this.viewport.clientHeight,
      color: () => window.getComputedStyle(this.root).color,
      scrollToRow: (row) => {
        this.stopScrollAnimation();
        this.viewport.scrollTop = row * this.metrics.lineHeight;
      },
    });
    this.root.insertBefore(this.minimap.element, this.stickyLayer);
    this.minimapVisible = options.minimap ?? false;
    this.minimap.element.hidden = !this.minimapVisible;
    this.setLigatures(options.ligatures ?? false);
    this.host.append(this.root);

    this.bindAreaEvents();

    // Метрики снимаем с самого редактора (`.own-editor`), а не с места, куда его
    // положили: шрифт и кегль задаёт именно он, и мерять надо уже вставленный узел —
    // у узла вне DOM вычисленный стиль пуст.
    this.metrics = options.metrics ?? measureFromHost(this.root);

    this.applyMetrics();
    this.applyTheme();
    this.viewport.addEventListener('scroll', this.onScroll);
    // Размер окна меняется (перенос панели, масштаб) — видимых строк становится
    // больше или меньше, и картинку надо пересобрать. Наблюдаем за полем прокрутки.
    this.resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.render()) : null;
    this.resizeObserver?.observe(this.viewport);
    this.render();

    // Шрифт кода — свой файл (`fonts.css`), и к моменту создания редактора он может
    // быть ещё не загружен. Тогда меряется запасной моноширинный, и ширина клетки
    // получается неверной — каретка и выделение съезжают, тем сильнее, чем длиннее
    // строка. Поэтому, когда шрифты доросли, перемеряем и перерисовываем.
    if (!options.metrics && typeof document.fonts?.ready?.then === 'function') {
      void document.fonts.ready.then(() => {
        if (this.disposed) return;
        this.remeasure();
      });
    }
  }

  /** Перемерить шрифт и перерисовать. Нужно после догрузки шрифта и при смене кегля. */
  remeasure(): void {
    this.metrics = measureFromHost(this.root);
    this.layoutCache = null;
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1, wrap: '', semantic: -1, folds: -1 };
    this.applyMetrics();
    this.render();
  }

  get element(): HTMLElement {
    return this.root;
  }

  /** Текущее выделение (главное). Пустое — каретка. */
  get selectionState(): Selection {
    return this.primarySelection;
  }

  /** Главное выделение — последнее из поставленных. */
  private get primarySelection(): Selection {
    return this.selections[this.selections.length - 1]!;
  }

  /** Поставить выделение и перерисовать каретку с заливкой. */
  setSelection(selection: Selection): void {
    this.setSelections([selection]);
  }

  /**
   * Поставить все курсоры (мультикурсор) и перерисовать каретки с заливкой. Последний —
   * главный: у него мигает каретка, по нему идут IME и попапы.
   */
  setSelections(selections: readonly Selection[]): void {
    this.selections = selections.length > 0 ? [...selections] : [caret(0)];
    this.updateCaretAndSelection();
    this.updateContextHighlights();
  }

  /**
   * Показать совпадения поиска. Рисуем только те, что попадают в видимые строки: у
   * запроса вроде `.` совпадений столько же, сколько знаков в файле, и строить
   * прямоугольник на каждое — работа впустую, их всё равно не видно.
   *
   * `current` — индекс текущего совпадения: оно подсвечивается ярче, чтобы при
   * переходе «вниз» взгляд сразу находил, куда переехали.
   */
  setSearchHighlights(matches: readonly { start: number; end: number }[], current = -1): void {
    this.searchMatches = matches;
    this.searchCurrent = current;
    this.renderSearch();
  }

  /** Убрать подсветку поиска. */
  clearSearchHighlights(): void {
    this.searchMatches = [];
    this.searchCurrent = -1;
    this.renderSearch();
  }

  /**
   * Пересчитать и нарисовать подсветку контекста: вхождения слова под кареткой и пара
   * скобок. Зовётся при каждом переезде курсора.
   */
  private updateContextHighlights(): void {
    this.occurrences = findOccurrences(this.buffer, this.primarySelection);
    this.brackets = findBracketPair(this.buffer, this.primarySelection.active);
    this.renderHighlight();
  }

  /** Слой подсветки контекста: прямоугольники вхождений и подсветка скобок. */
  private renderHighlight(): void {
    if (this.occurrences.length === 0 && this.brackets === null && this.linked.length === 0) {
      this.highlightLayer.replaceChildren();
      return;
    }
    const { first, last } = this.renderedLines();
    const fragment = document.createDocumentFragment();

    const paint = (range: { start: number; end: number }, className: string): void => {
      // Строка с единицы — как first/last из renderedLines и как ждут renderLines/renderLinks.
      const line = this.buffer.lineAt(range.start);
      if (line < first || line > last) return;
      if (this.isHidden(line)) return;
      for (const rect of this.rangeRects(range.start, range.end)) {
        const node = document.createElement('div');
        node.className = `${ROOT_CLASS}-highlight-rect ${className}`;
        node.style.transform = `translate(${rect.left}px, ${this.yOfRow(rect.row)}px)`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
        fragment.append(node);
      }
    };

    for (const range of this.linked) paint(range, 'is-linked');
    for (const range of this.occurrences) paint(range, 'is-occurrence');
    if (this.brackets) {
      const kind = this.brackets.unmatched ? 'is-bracket is-bracket-bad' : 'is-bracket';
      paint(this.brackets.open, kind);
      if (!this.brackets.unmatched) paint(this.brackets.close, kind);
    }
    this.highlightLayer.replaceChildren(fragment);
  }

  /**
   * Поставить семантические токены сервера: точные роли поверх грамматики. Пусто снимает
   * наложение — остаётся своя подсветка. Строки и столбцы переводим в нулевые (как их
   * считает отрисовка) и группируем по строкам: в строке их ищут по номеру.
   */
  setSemanticTokens(tokens: readonly SemanticToken[]): void {
    const grouped = new Map<number, RoleRange[]>();
    for (const token of tokens) {
      const line = token.line - 1;
      const range: RoleRange = {
        start: token.startColumn - 1,
        end: token.endColumn - 1,
        role: semanticTokenRole(token.type),
      };
      if (range.end <= range.start) continue;
      const list = grouped.get(line);
      if (list) list.push(range);
      else grouped.set(line, [range]);
    }
    if (sameSemantic(this.semantic, grouped)) return;
    this.semantic = grouped;
    // Наложение меняет цвета строк, но не их текст: без смены версии кадр счёл бы
    // строки прежними и не пересобрал бы их.
    this.semanticVersion += 1;
    this.render();
  }

  /**
   * Поставить связанные участки (linkedEditing) для подсветки. Смещения в тексте;
   * пусто снимает подсветку. Саму правку в них повторяет контроллер — здесь только вид.
   */
  setLinkedRanges(ranges: readonly { start: number; end: number }[]): void {
    const same =
      this.linked.length === ranges.length &&
      this.linked.every((range, index) => range.start === ranges[index]!.start && range.end === ranges[index]!.end);
    if (same) return;
    this.linked = ranges;
    this.renderHighlight();
  }

  /**
   * Показать призрачный текст подсказки «допиши за меня»: серый текст, будто уже
   * набранный, сразу за кареткой. Это только вид — решает, когда его поставить и
   * когда принять, отдельный слой (`input/inline-completions.ts`).
   */
  setGhostText(offset: number, text: string): void {
    if (text.length === 0) {
      this.clearGhostText();
      return;
    }
    this.ghost = { offset, text };
    this.renderGhost();
  }

  /** Убрать призрачный текст (человек печатает дальше, ушёл с места или принял подсказку). */
  clearGhostText(): void {
    if (!this.ghost) return;
    this.ghost = null;
    this.ghostLayer.replaceChildren();
    // Вхождения слова и пара скобок были о прошлом файле — начинаем с чистого листа.
    this.occurrences = [];
    this.brackets = null;
    this.highlightLayer.replaceChildren();
  }

  /**
   * Нарисовать призрачный текст у каретки. Многострочная подсказка: первая строка
   * начинается у каретки, остальные — с начала строки (как дописанный ниже код),
   * поэтому их сдвигаем влево на x каретки.
   */
  private renderGhost(): void {
    if (!this.ghost || this.ghost.text.length === 0) {
      this.ghostLayer.replaceChildren();
      return;
    }
    const { offset, text } = this.ghost;
    const line = this.buffer.lineAt(offset);
    const column = offset - this.buffer.lineStart(line);
    const offsets = this.offsetsFor(line);
    const segments = this.segmentsFor(line);
    const segment = segmentIndexForColumn(segments, column);
    const origin = offsets[segments[segment]?.startColumn ?? 0] ?? 0;
    const left = (offsets[column] ?? origin) - origin;

    const container = document.createElement('div');
    container.className = `${ROOT_CLASS}-ghost`;
    container.style.transform = `translate(${left}px, ${this.yOfRow(this.rowOf(line) + segment)}px)`;

    const rows = text.split('\n');
    for (let index = 0; index < rows.length; index += 1) {
      const row = document.createElement('span');
      row.className = `${ROOT_CLASS}-ghost-line`;
      row.textContent = rows[index]!;
      // Строки после первой начинаются с начала строки файла, а не от каретки.
      if (index > 0) row.style.marginLeft = `${-left}px`;
      container.append(row);
    }
    this.ghostLayer.replaceChildren(container);
  }

  /**
   * Прямоугольники совпадений, попадающих в видимые строки. Считаем по каждому
   * совпадению отдельно, а не общим списком: у многострочного совпадения
   * прямоугольников несколько, и так видно, какому из них какой принадлежит (нужно,
   * чтобы отметить текущее).
   */
  private renderSearch(): void {
    if (this.searchMatches.length === 0) {
      this.searchLayer.replaceChildren();
      return;
    }
    const { first, last } = this.renderedLines();
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < this.searchMatches.length; index += 1) {
      const match = this.searchMatches[index]!;
      const line = this.buffer.lineAt(match.start) - 1;
      if (line < first || line > last) continue;
      if (this.isHidden(line + 1)) continue;
      for (const rect of this.rangeRects(match.start, match.end)) {
        const node = document.createElement('div');
        node.className =
          index === this.searchCurrent ? `${ROOT_CLASS}-search-rect is-current` : `${ROOT_CLASS}-search-rect`;
        node.style.transform = `translate(${rect.left}px, ${this.yOfRow(rect.row)}px)`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
        fragment.append(node);
      }
    }
    this.searchLayer.replaceChildren(fragment);
  }

  /** Границы строк, лежащих в DOM: по ним решаем, что рисовать. */
  private renderedLines(): { first: number; last: number } {
    const { first, last } = this.rendered;
    return { first: first < 0 ? 0 : first, last: last < 0 ? 0 : last };
  }

  /** Прокрутить так, чтобы смещение (каретка) попало в экран. */
  revealOffset(offset: number): void {
    const line = this.buffer.lineAt(offset);
    if (!this.wrapOn) {
      this.revealLineInternal(line);
      return;
    }
    // Со переносом ведём каретку на её собственный ряд, а не на первый ряд строки.
    const column = offset - this.buffer.lineStart(line);
    this.revealRowInternal(this.rowOf(line) + this.segmentOfColumn(line, column));
  }

  /**
   * Смещение под точкой экрана — перевод клика мышью в позицию в тексте. Работает
   * и за пределами строки: столбец прижимается к её концу, как при клике мимо текста.
   */
  offsetAt(clientX: number, clientY: number): number {
    const rect = this.viewport.getBoundingClientRect();
    const x = clientX - rect.left + this.viewport.scrollLeft;
    const y = clientY - rect.top + this.viewport.scrollTop;
    const { line, segment } = this.rowInfo(lineAtY(y, this.metrics.lineHeight, this.rowCount()));
    const offsets = this.offsetsFor(line);
    const segments = this.segmentsFor(line);
    const span = segments[segment] ?? segments[0]!;
    const origin = offsets[span.startColumn] ?? 0;
    // Клик по ряду-продолжению: x отсчитывается от начала отрезка, а не строки.
    let column = columnForX(offsets, x + origin);
    if (column < span.startColumn) column = span.startColumn;
    if (column > span.endColumn) column = span.endColumn;
    return this.buffer.lineStart(line) + column;
  }

  /** Сколько строк влезает в экран — шаг для PageUp/PageDown. */
  visibleLineCount(): number {
    return Math.max(1, Math.floor(this.viewport.clientHeight / this.metrics.lineHeight) - 1);
  }

  /**
   * Где на полотне стоит каретка — в координатах содержимого. Нужно, чтобы поставить
   * рядом скрытое поле ввода (там живёт IME): окно выбора иероглифов появляется возле
   * курсора, а для этого браузеру надо знать, где он.
   */
  caretPoint(offset: number): { left: number; top: number; height: number } {
    const line = this.buffer.lineAt(offset);
    const column = offset - this.buffer.lineStart(line);
    const offsets = this.offsetsFor(line);
    const segments = this.segmentsFor(line);
    const segment = segmentIndexForColumn(segments, column);
    const origin = offsets[segments[segment]?.startColumn ?? 0] ?? 0;
    const left = (offsets[column] ?? origin) - origin;
    return { left, top: this.yOfRow(this.rowOf(line) + segment), height: this.metrics.lineHeight };
  }

  /**
   * Координаты смещения в СИСТЕМЕ ОКНА — для попапов. Они живут рядом с редактором, а
   * не внутри полотна, поэтому им нужны координаты, а не сдвиг слоя: попап, поставленный
   * внутри полотна, ехал бы вместе с прокруткой и оставался бы у края экрана.
   */
  clientPoint(offset: number): { left: number; top: number; height: number; bottom: number } {
    const point = this.caretPoint(offset);
    const rect = this.viewport.getBoundingClientRect();
    const top = rect.top + point.top - this.viewport.scrollTop;
    const left = rect.left + point.left - this.viewport.scrollLeft;
    return { left, top, height: point.height, bottom: top + point.height };
  }

  /**
   * Тип токена под смещением — из подсветки. Нужен, чтобы не показывать подсказки
   * посреди строки или комментария (там они только мешают) и чтобы наведение сказало,
   * что это за слово. `null` — подсветки нет или под смещением бесцветный знак.
   */
  tokenTypeAt(offset: number): string | null {
    const line = this.buffer.lineAt(offset);
    const column = offset - this.buffer.lineStart(line);
    for (const token of this.highlighter.tokensFor(line - 1)) {
      if (column >= token.start && column < token.end) return token.type;
    }
    return null;
  }

  /**
   * Токены подсветки строки (номер с единицы). По ним проверка орфографии решает,
   * что проверять: в коде слова берём только из комментариев и строк.
   */
  tokensFor(line: number): readonly Token[] {
    return this.highlighter.tokensFor(line - 1);
  }

  /** Есть ли для языка грамматика: без неё текст показывается простым. */
  hasHighlighting(): boolean {
    return this.highlighter.active;
  }

  /**
   * Обновить после правки текста. Раскладку строк сбрасываем: она привязана к версии
   * буфера, а версия после правки выросла.
   *
   * `fromOffset` — смещение, с которого началась правка. По нему подсветка понимает,
   * с какой строки переразбирать: строки выше правки не изменились, и их токены
   * остаются верными, даже если файл в тысячу строк.
   */
  refresh(fromOffset?: number): void {
    this.layoutCache = null;
    if (fromOffset !== undefined) {
      // Правка, изменившая число строк, сдвигает всё ниже: подсветке об этом надо сказать.
      const structural = this.buffer.lineCount !== this.lineCount;
      this.highlighter.invalidate(this.buffer.lineAt(fromOffset) - 1, structural);
      this.bracketDepth.invalidate(this.buffer.lineAt(fromOffset) - 1, structural);
    }
    this.lineCount = this.buffer.lineCount;
    this.render();
  }

  /** Сменить язык подсветки (открыли другой файл в этой же вкладке). */
  setLanguage(languageId: string): void {
    this.highlighter.setGrammar(grammarFor(languageId));
    // Вложенность зависит от того, что подсветка считает строкой/комментарием, —
    // со сменой языка пересчитываем с нуля.
    this.bracketDepth.reset();
    this.rerender();
  }

  /** Сменить схему оформления: цвета токенов берутся из темы и её надо переставить. */
  setScheme(scheme: Scheme): void {
    this.scheme = scheme;
    this.applyTheme();
    this.rerender();
  }

  /** Сменить ширину табуляции: метрики и раскладка пересобираются заново. */
  setTabSize(tabSize: number): void {
    const size = Math.max(1, Math.floor(tabSize));
    if (size === this.metrics.tabSize) return;
    this.metrics = monospaceMetrics(this.metrics.charWidth, this.metrics.lineHeight, size);
    this.applyMetrics();
    this.rerender();
  }

  /**
   * Плавная прокрутка: дальний прыжок курсора ведёт текст разгоном. Просьба системы
   * «меньше движения» сильнее настройки: при ней прокрутка едет мгновенно.
   */
  setSmoothScroll(on: boolean): void {
    this.smooth = on && !prefersReducedMotion();
    if (!this.smooth) this.stopScrollAnimation();
  }

  /** Остановить анимацию прокрутки — перед любой неанимированной записью прокрутки. */
  private stopScrollAnimation(): void {
    if (!this.scrollAnimation) return;
    cancelAnimationFrame(this.scrollAnimation.frame);
    this.scrollAnimation = null;
  }

  /**
   * Поставить прокрутку на нужное место: мгновенно или разгоном. Разгон — только для
   * дальних прыжков: на строку-две плавность мешала бы набору, а прыжок на сотню строк
   * без неё непонятно откуда взялся.
   */
  private setScrollTop(target: number, animated: boolean): void {
    const distance = Math.abs(target - this.viewport.scrollTop);
    this.stopScrollAnimation();
    if (!animated || !this.smooth || distance <= this.metrics.lineHeight) {
      this.viewport.scrollTop = target;
      return;
    }
    const from = this.viewport.scrollTop;
    const animation = { from, to: target, startedAt: 0, frame: 0, last: from };
    const step = (now: number): void => {
      if (this.scrollAnimation !== animation) return;
      if (animation.startedAt === 0) animation.startedAt = now;
      const elapsed = now - animation.startedAt;
      animation.last = scrollStep(from, target, elapsed);
      this.viewport.scrollTop = animation.last;
      if (scrollFinished(elapsed)) {
        this.viewport.scrollTop = target;
        this.scrollAnimation = null;
        return;
      }
      animation.frame = requestAnimationFrame(step);
    };
    this.scrollAnimation = animation;
    animation.frame = requestAnimationFrame(step);
  }

  /** Сменить кегль текста: меняется ширина клетки и высота строки — метрики перемеряем. */
  setFontSize(fontSize: number): void {
    const size = Math.max(1, Math.floor(fontSize));
    if (this.root.style.fontSize === `${size}px`) return;
    this.root.style.fontSize = `${size}px`;
    this.remeasure();
  }

  /**
   * Высота строки, px. `0` — «по шрифту»: своё значение снимаем, и высота считается
   * от кегля (1.4, из таблицы стилей). Метрики после этого перемеряем: от них зависит
   * вся раскладка — прокрутка, попадание мышью и слой кареток.
   */
  setLineHeight(lineHeight: number): void {
    const px = Math.round(lineHeight);
    const next = px > 0 ? `${px}px` : '';
    if (this.root.style.lineHeight === next) return;
    this.root.style.lineHeight = next;
    this.remeasure();
  }

  /** Форма каретки: полоска, блок или подчёркивание. Вид рисует CSS по `data-cursor`. */
  setCursorStyle(style: CursorStyle): void {
    if (this.root.dataset.cursor === style) return;
    this.root.dataset.cursor = style;
  }

  /** Мигание каретки: выключенное спокойнее глазу при долгом чтении. */
  setCursorBlink(blink: boolean): void {
    this.root.dataset.cursorBlink = blink ? 'on' : 'off';
  }

  /** Язык, для которого сейчас есть подсветка (`null` — текст показывается как простой). */
  get highlightLanguage(): string | null {
    return this.highlighter.language;
  }

  /** Заставить пересобрать строки: сменилась подсветка или схема, а версия текста та же. */
  private rerender(): void {
    this.widest = 0;
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1, wrap: '', semantic: -1, folds: -1 };
    this.render();
  }

  /** Сменить документ (новая вкладка). Прокрутку и выделение сбрасываем к началу. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.selections = [caret(0)];
    // Связанные участки принадлежали прошлому файлу — хозяин задаст их для нового.
    this.linked = [];
    // Семантические токены — тоже про прошлый файл: их пришлёт хозяин для нового.
    this.semantic = new Map();
    this.scrollTop = 0;
    this.widest = 0;
    this.layoutCache = null;
    this.rowsKey = '';
    this.lineCount = buffer.lineCount;
    // Диапазоны свёртки и схлопнутое состояние — прошлого файла: начинаем с чистого листа.
    this.folds.reset();
    this.highlighter.reset();
    this.bracketDepth.reset();
    // Подсказки-вставки принадлежали прошлому файлу: их поставит хозяин для нового.
    this.inlayByLine.clear();
    this.inlineValueByLine.clear();
    this.stopScrollAnimation();
    this.viewport.scrollTo({ top: 0, left: 0 });
    // Украшения принадлежали прошлому файлу (полоски git, точки останова): их
    // рисует хозяин уже для нового — до этого не должно остаться чужих значков.
    this.decorations = new FileDecorations();
    this.decorationsVersion += 1;
    // Призрачная подсказка говорила о прошлом файле — к новому она не относится.
    this.ghost = null;
    this.ghostLayer.replaceChildren();
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1, wrap: '', semantic: -1, folds: -1 };
    this.render();
  }

  focus(): void {
    this.root.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.linkLayer.removeEventListener('click', this.onLinkLayerClick);
    this.resizeObserver?.disconnect();
    this.root.remove();
  }

  // — свёртка —

  /**
   * Диапазоны свёртки файла: от языкового сервера или по отступам — считает
   * вызывающий. Схлопнутое состояние сохраняется: правка файла не должна раскрывать
   * то, что человек сложил сам.
   */
  setFoldRanges(ranges: readonly FoldRange[]): void {
    this.folds.setRanges(ranges);
    this.render();
  }

  /** Сложить или раскрыть блок, начинающийся на этой строке (значок в жёлобе). */
  toggleFold(line: number): void {
    if (!this.folds.all.some((range) => range.startLine === line)) return;
    this.folds.toggle(line);
    this.render();
  }

  /** Сложить блок у этой позиции: начинающийся тут или вмещающий её. */
  foldAt(offset: number): boolean {
    const region = this.folds.regionAt(this.buffer.lineAt(offset));
    if (!region) return false;
    if (!this.folds.isCollapsed(region.startLine)) this.folds.toggle(region.startLine);
    this.render();
    return true;
  }

  /** Раскрыть блок, который закрывает эту позицию. */
  unfoldAt(offset: number): boolean {
    const region = this.folds.collapsedAt(this.buffer.lineAt(offset));
    if (!region) return false;
    this.folds.toggle(region.startLine);
    this.render();
    return true;
  }

  foldAll(): void {
    this.folds.collapseAll();
    this.render();
  }

  unfoldAll(): void {
    this.folds.expandAll();
    this.render();
  }

  /** Что со свёрткой сейчас — для проб и проверок. */
  foldState(): { rows: number; collapsed: number[] } {
    return { rows: this.rowCount(), collapsed: this.folds.collapsedStarts() };
  }

  // — перенос строк —

  /** Включить или выключить перенос длинных строк. */
  setWordWrap(on: boolean): void {
    if (this.wrapOn === on) return;
    this.wrapOn = on;
    // Таблица рядов построена для прежнего режима — начинаем с чистого листа.
    this.rowsKey = '';
    this.rerender();
  }

  /** Включён ли перенос строк. */
  get wordWrap(): boolean {
    return this.wrapOn;
  }

  /** Ширина, до которой переносим строки — ширина поля прокрутки в пикселях. */
  private wrapWidth(): number {
    return Math.max(1, Math.floor(this.viewport.clientWidth));
  }

  /**
   * Построить таблицу визуальных рядов заново, если она устарела. Делается только при
   * включённом переносе: без него ряды совпадают со строками и их считает свёртка
   * (`FoldModel`) без массива на весь файл.
   */
  private ensureRows(): void {
    if (!this.wrapOn) return;
    const width = this.wrapWidth();
    const key = `${this.buffer.version}|${width}|${this.metrics.tabSize}|${this.buffer.lineCount}|${this.folds.revision}`;
    if (key === this.rowsKey) return;
    const counts = new Array<number>(this.buffer.lineCount);
    for (let index = 0; index < counts.length; index += 1) {
      const line = index + 1;
      // Скрытая строка рядов не занимает — следующий ряд начнётся сразу над ней.
      if (this.folds.isHidden(line)) {
        counts[index] = 0;
        continue;
      }
      const text = this.buffer.lineText(line);
      const offsets = layoutLine(text, this.metrics, this.insertsFor(line));
      counts[index] = wrapSegments(text, offsets, width).length;
    }
    this.rows.rebuild(counts);
    this.rowsKey = key;
  }

  /** Отрезки переноса строки: один на всю строку, когда перенос выключен. */
  private segmentsFor(line: number): WrapSegment[] {
    const offsets = this.offsetsFor(line);
    if (!this.wrapOn) return [{ startColumn: 0, endColumn: offsets.length - 1 }];
    return wrapSegments(this.buffer.lineText(line), offsets, this.wrapWidth());
  }

  /** Номер отрезка строки, которому принадлежит столбец. */
  private segmentOfColumn(line: number, column: number): number {
    if (!this.wrapOn) return 0;
    return segmentIndexForColumn(this.segmentsFor(line), column);
  }

  /** Сколько визуальных рядов занимает строка (без переноса — один). */
  private rowSpanOf(line: number): number {
    if (!this.wrapOn) return 1;
    return this.segmentsFor(line).length;
  }

  /** Сколько всего рядов занимает документ. */
  private rowCount(): number {
    if (this.wrapOn) {
      this.ensureRows();
      return this.rows.rowTotal;
    }
    return this.folds.rowCount(this.buffer.lineCount);
  }

  /** Первый ряд строки (с нуля). */
  private rowOf(line: number): number {
    if (this.wrapOn) {
      this.ensureRows();
      return this.rows.rowOf(line);
    }
    return this.folds.rowOf(line);
  }

  /** Верх строки в координатах полотна: по РЯДУ строки, а не по её номеру. */
  private yOfLine(line: number): number {
    return this.rowOf(line) * this.metrics.lineHeight;
  }

  /** Верх ряда в координатах полотна. */
  private yOfRow(row: number): number {
    return row * this.metrics.lineHeight;
  }

  /** Строка, которой принадлежит ряд (с нуля) — обратный перевод к `yOfLine`. */
  private lineOfRow(row: number): number {
    if (this.wrapOn) {
      this.ensureRows();
      return this.rows.lineAtRow(row).line;
    }
    return this.folds.lineAtRow(row);
  }

  /** Строка и её ряд по номеру ряда — для клика и перевода y → позиция. */
  private rowInfo(row: number): { line: number; segment: number } {
    if (this.wrapOn) {
      this.ensureRows();
      return this.rows.lineAtRow(row);
    }
    return { line: this.folds.lineAtRow(row), segment: 0 };
  }

  /** Скрыта ли строка свёрткой (её не рисуем и места она не занимает). */
  private isHidden(line: number): boolean {
    return this.folds.isHidden(line);
  }

  /** Ключ переноса: включён ли он и до какой ширины. Изменился — строки пересобрать. */
  private wrapSignature(): string {
    return this.wrapOn ? `on:${this.wrapWidth()}` : 'off';
  }

  // — отрисовка —

  /**
   * Перерисовать всё видимое: содержимое полотна, строки, номера, каретку и выделение.
   * Зовётся на прокрутку, изменение размера и правку — то есть на всё, что меняет картинку.
   */
  private render(): void {
    const lineHeight = this.metrics.lineHeight;
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    // Прокрутка и видимый отрезок считаются в РЯДАХ: свёрнутые строки экрана не занимают.
    const rows = this.rowCount();
    const scrollTop = clamp(this.viewport.scrollTop, maxScrollTop(rows, lineHeight, height));
    // Прокрутку вбок при необходимости подрежем: полотно уже сузилось до самой
    // широкой строки, и без этого правый край остался бы за экраном.
    const maxLeft = maxScrollLeft(this.widest, width);
    if (this.viewport.scrollLeft > maxLeft) this.viewport.scrollLeft = maxLeft;
    this.scrollTop = scrollTop;

    const { first: firstRow, last: lastRow } = visibleLines(scrollTop, lineHeight, height, rows, this.overscan);
    // Ряды — в строки буфера: дальше всё считается строками, а скрытые слои пропускают.
    const first = this.lineOfRow(firstRow);
    const last = Math.min(this.buffer.lineCount, this.lineOfRow(lastRow + 1) - 1);

    // Порядок важен: сначала строки — они уточняют самую широкую, потом размер
    // полотна по ней, иначе широкая строка кадр останется за краем.
    this.renderLines(first, last);
    this.renderGutter(first, last);
    this.renderDecorations(first, last);
    // Закреплённые заголовки — последними: они перекрывают текст сверху, поэтому
    // должны знать о готовых размерах полей и о прокрутке.
    this.renderSticky(width);
    this.sizeContent(width, height);
    // Совпадения поиска живут в тех же строках, что и текст: после прокрутки их
    // видимый набор изменился, поэтому перерисовываем вместе со строками.
    this.renderSearch();
    // Подсветка контекста живёт в тех же строках — после прокрутки её набор изменился.
    this.renderHighlight();
    // Призрачный текст привязан к каретке: после смены метрик его надо переложить.
    this.renderGhost();
    this.updateCaretAndSelection();
    // Миникарта рисуется по ВСЕМУ файлу и едет вместе с прокруткой: перерисовываем
    // её тем же кадром, что и строки, — иначе ползунок отставал бы от прокрутки.
    if (this.minimapVisible) this.minimap.render();
  }

  /** Размер полотна: высота — по числу строк, ширина — по самой широкой известной строке. */
  private sizeContent(viewportWidth: number, viewportHeight: number): void {
    const height = Math.max(contentHeight(this.rowCount(), this.metrics.lineHeight), viewportHeight);
    const width = Math.max(this.widest, viewportWidth);
    this.content.style.height = `${height}px`;
    this.content.style.width = `${width}px`;
  }

  /** Слой видимых строк: пересобираем только когда сменилась версия, границы или украшения. */
  private renderLines(first: number, last: number): void {
    const { version } = this.buffer;
    const same =
      this.rendered.version === version &&
      this.rendered.first === first &&
      this.rendered.last === last &&
      // Подписи blame рисуются ВНУТРИ строки: сменились украшения — строки надо
      // пересобрать, даже если текст тот же.
      this.rendered.decorations === this.decorationsVersion &&
      // Ширина переноса поменялась (окно растянули) — отрезки другие, надо пересобрать.
      this.rendered.wrap === this.wrapSignature() &&
      // Семантическая подсветка сменилась — цвета строк другие, надо пересобрать.
      this.rendered.semantic === this.semanticVersion &&
      // Свёртку сложили или раскрыли — строки надо скрыть или вернуть. Без этого знак
      // «свернуть» состояние менял, а строки оставались на месте: у небольшого файла
      // видимый отрезок тот же, и пересборка слоя пропускалась.
      this.rendered.folds === this.folds.revision;
    if (same) return;

    const fragment = document.createDocumentFragment();
    // `first`/`last` — видимые строки (с единицы): идём по ним самим, а не по first+1..last+1.
    for (let line = first; line <= last; line += 1) {
      // Скрытые строки в слое не рисуем: ряды идут подряд, без провалов.
      if (this.isHidden(line)) continue;
      const text = this.buffer.lineText(line);
      const offsets = layoutLine(text, this.metrics, this.insertsFor(line));
      // Длинная строка при переносе разрезана на отрезки; каждый рисуется своим рядом.
      const segments = this.wrapOn ? wrapSegments(text, offsets, this.wrapWidth()) : [wholeLine(offsets)];
      for (const segment of segments) {
        const width = (offsets[segment.endColumn] ?? 0) - (offsets[segment.startColumn] ?? 0);
        if (width > this.widest) this.widest = width;
        const row = document.createElement('div');
        row.className = `${ROOT_CLASS}-line`;
        this.fillLine(row, text, line, segment);
        fragment.append(row);
      }
    }

    this.linesLayer.replaceChildren(fragment);
    // Слой сдвигаем к первой видимой строке, а не пересоздаём на её месте.
    this.linesLayer.style.transform = `translateY(${this.yOfLine(first)}px)`;
    this.rendered = {
      version,
      first,
      last,
      decorations: this.decorationsVersion,
      wrap: this.wrapSignature(),
      semantic: this.semanticVersion,
      folds: this.folds.revision,
    };
  }

  /**
   * Собрать строку из токенов. Куски, которым роль не нашлась, кладём обычным текстом,
   * а не пустым `<span>`: лишний узел на каждый знак препинания — это заметный мусор в
   * разметке и лишняя работа браузеру на каждой отрисовке.
   *
   * Подпись blame дописывается после содержимого строки отдельным куском: она не часть
   * файла и в раскладку кода не входит — как `after` у декораций Monaco.
   */
  private fillLine(row: HTMLElement, text: string, line: number, segment: WrapSegment): void {
    const line0 = line - 1;
    const tokens = this.highlighter.tokensFor(line0);
    const after = this.decorations.afterFor(line);
    // Рисуем только знаки своего отрезка; у неразрезанной строки он один — вся строка.
    const from = segment.startColumn;
    const to = segment.endColumn;
    const last = to >= text.length;
    const fragment = document.createDocumentFragment();

    // Отдельно выделенные знаки строки: скобка (радугой по вложенности) и слово-пометка
    // (TODO/FIXME). Ключ — начало, значение — класс и конец: одна вставка на оба случая,
    // чтобы не разводить похожие ветки в цикле ниже.
    const marks = new Map<number, { className: string; end: number }>();
    for (const mark of this.bracketDepth.marksFor(line0)) {
      marks.set(mark.start, {
        className: `${ROOT_CLASS}-bracket is-depth-${mark.depth % RAINBOW_SIZE}`,
        end: mark.start + 1,
      });
    }
    for (const todo of todoMarks(text)) {
      marks.set(todo.start, { className: `${ROOT_CLASS}-todo`, end: todo.end });
    }
    // Невидимые знаки (пробелы точками, табуляции стрелкой) — по настройке. Даём их
    // той же картой, что и пометки: в цикле ниже это просто ещё один «выделенный знак».
    for (const ws of whitespaceMarks(text, this.whitespace)) {
      marks.set(ws.start, { className: `${ROOT_CLASS}-ws is-${ws.kind}`, end: ws.end });
    }

    // Подсказки-вставки: их не заменяют знаки, а ВСТАВЛЯЮТ между ними — потому и
    // отдельной картой. Место — граница (столбец с нуля); текст уже с ведущим пробелом.
    const hintsAt = new Map<number, InlayItem[]>();
    for (const item of [...(this.inlayByLine.get(line) ?? []), ...(this.inlineValueByLine.get(line) ?? [])]) {
      const list = hintsAt.get(item.column);
      if (list) list.push(item);
      else hintsAt.set(item.column, [item]);
    }

    // Куски строки по токенам: пропуски между ними — обычный текст (роль не нашлась).
    // Берём только тот отрезок, что рисует этот ряд, — токены за его краем в DOM не нужны.
    const pieces: RoleRange[] = [];
    let cursor = from;
    for (const token of tokens) {
      if (token.end <= from) continue;
      if (token.start >= to) break;
      const start = Math.max(token.start, from);
      if (start > cursor) pieces.push({ start: cursor, end: start, role: null });
      const end = Math.min(token.end, to);
      if (end > start) pieces.push({ start, end, role: roleOfToken(token.type) });
      cursor = Math.max(cursor, end);
    }
    if (cursor < to) pieces.push({ start: cursor, end: to, role: null });
    if (pieces.length === 0) pieces.push({ start: from, end: to, role: null });

    // Семантические токены сервера — поверх грамматики: где он высказался, его роль важнее.
    const semantic = this.semantic.get(line0);
    const finalPieces = semantic ? overlayRanges(pieces, semantic) : pieces;

    for (const token of finalPieces) {
      let at = token.start;
      while (at < token.end) {
        this.appendHints(fragment, hintsAt, at);
        const mark = marks.get(at);
        if (mark) {
          const end = Math.min(mark.end, token.end);
          const span = document.createElement('span');
          span.className = mark.className;
          span.textContent = text.slice(at, end);
          fragment.append(span);
          at = end;
          continue;
        }
        // Тянем кусок без выделенных знаков и вставок до следующего такого или конца токена.
        let next = at + 1;
        while (next < token.end && !marks.has(next) && !hintsAt.has(next)) next += 1;
        const piece = text.slice(at, next);
        if (token.role) {
          const span = document.createElement('span');
          // Класс — роль палитры, а цвет берётся переменной с корня (`applyTheme`).
          span.className = `${ROOT_CLASS}-token-${token.role}`;
          span.textContent = piece;
          fragment.append(span);
        } else {
          fragment.append(document.createTextNode(piece));
        }
        at = next;
      }
    }

    // Хвостовое дополнение строки — линза, подпись blame и вставка в самом конце —
    // рисуется один раз, на ПОСЛЕДНЕМ отрезке (для неразрезанной строки он и один).
    if (last) {
      // Вставка в самом конце строки: цикл по ней не проходит — добавляем после.
      this.appendHints(fragment, hintsAt, text.length);

      // Код-линза и подпись blame — оба ПОСЛЕ текста, но в этом порядке: линза ближе
      // к коду (клик по действию), а длинная подпись blame — в самом хвосте строки.
      const lens = this.decorations.lensFor(line);
      if (lens) fragment.append(this.buildLens(lens, line));

      if (after) {
        const span = document.createElement('span');
        span.className = after.className;
        span.textContent = after.content;
        fragment.append(span);
      }
    }

    row.replaceChildren(fragment);
  }

  /** Добавить вставки-подсказки, привязанные к этой границе строки (их может быть несколько). */
  private appendHints(fragment: DocumentFragment, hintsAt: Map<number, InlayItem[]>, at: number): void {
    const items = hintsAt.get(at);
    if (!items) return;
    for (const item of items) {
      const span = document.createElement('span');
      span.className = item.className;
      span.textContent = item.text;
      fragment.append(span);
    }
  }

  /**
   * Узел код-линзы. Клик гасим на `mousedown`, а не на `click`: иначе ввод успел бы
   * поставить каретку в место подписи, прежде чем мы позовём действие. Курсор-рука —
   * единственный знак, что подпись кликабельна.
   */
  private buildLens(lens: LensDecoration, line: number): HTMLElement {
    const span = document.createElement('span');
    span.className = lens.className;
    span.textContent = lens.content;
    if (lens.tooltip) span.title = lens.tooltip;
    span.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onLensClick?.(line);
    });
    return span;
  }

  /**
   * Номера строк — отдельный слой слева, он не едет по горизонтали. У сворачиваемых
   * строк есть значок: он и складывает блок. Значок гасит событие, иначе клик по нему
   * ушёл бы хозяину как клик по номеру (там — точка останова).
   */
  private renderGutter(first: number, last: number): void {
    if (!this.gutterLines || !this.gutter) return;
    const fragment = document.createDocumentFragment();
    // `first`/`last` — видимые строки (с единицы): идём по ним самим, а не по first+1..last+1.
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const span = this.rowSpanOf(line);
      for (let index = 0; index < span; index += 1) {
        const row = document.createElement('div');
        row.className = `${ROOT_CLASS}-gutter-row`;
        // Номер и значок — только на первом ряду строки; у продолжения ряда пустые,
        // но место занимают: иначе номера разъехались бы с кодом.
        if (index === 0) {
          const marker = document.createElement('span');
          marker.className = `${ROOT_CLASS}-fold`;
          if (this.folds.all.some((range) => range.startLine === line)) {
            const collapsed = this.folds.isCollapsed(line);
            marker.classList.add('is-visible');
            marker.textContent = collapsed ? '▸' : '▾';
            marker.title = collapsed ? 'Развернуть' : 'Свернуть';
            marker.addEventListener('mousedown', (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.toggleFold(line);
            });
          }

          const number = document.createElement('span');
          number.className = `${ROOT_CLASS}-gutter-number`;
          number.textContent = String(line);
          row.append(marker, number);
        }
        fragment.append(row);
      }
    }
    this.gutterLines.replaceChildren(fragment);
    // Слой номеров лежит ВНЕ прокрутки, поэтому его сдвигаем не на абсолютную высоту
    // первой строки, а на её положение в окне: иначе на прокрутке номера уедут под край.
    this.gutterLines.style.transform = `translateY(${this.yOfLine(first) - this.scrollTop}px)`;
    // Ширина по числу разрядов последней строки плюс значок свёртки: цифры моноширинны.
    const digits = String(this.buffer.lineCount).length;
    this.gutter.style.width = `${digits * this.metrics.charWidth + 34}px`;
  }

  /**
   * Закреплённые заголовки блоков сверху (sticky scroll): пока верх экрана внутри
   * функции или класса, их объявление остаётся видно «шапкой» над кодом. Заголовки
   * берём из свёртки — это те же диапазоны, что схлопывает значок в жёлобе.
   *
   * Слой лежит ВНЕ прокрутки: он не едет вместе с полотном, поэтому стоит у верхнего
   * края поля сам. Пока заголовков нет, слоя не видно вовсе — и текст не перекрыт.
   */
  /**
   * Сменить подсказки-вставки (inlay hints). Раскладку сбрасываем: вставки занимают
   * место, а старая раскладка считалась без них — каретка и выделение разъехались бы.
   *
   * Подсказка приходит местом (строка, столбец), текст — тем, что показывает сервер.
   * Ширину считаем сами по шрифту (он моноширинный): по ширине вставка двигает текст.
   */
  setInlayHints(hints: readonly InlayHint[]): void {
    const byLine = new Map<number, InlayItem[]>();
    for (const hint of hints) {
      // Ведущий пробел отделяет подсказку от кода — и входит в её ширину.
      const text = ` ${hint.label}`;
      const item: InlayItem = {
        column: Math.max(0, hint.column - 1),
        text,
        width: this.textWidth(text),
        className: `${ROOT_CLASS}-inlay is-${hint.kind}`,
      };
      const list = byLine.get(hint.line);
      if (list) list.push(item);
      else byLine.set(hint.line, [item]);
    }
    this.inlayByLine = byLine;
    this.layoutCache = null;
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1, wrap: '', semantic: -1, folds: -1 };
    this.render();
  }

  /**
   * Значения переменных во время отладки: `x = 42` после имени. Место — столбец с нуля
   * (значение встаёт ПОСЛЕ имени, поэтому столбец — конец участка). Класс свой: значения
   * отладчика отличаются от подсказок языка и цветом, и происхождением.
   */
  setInlineValues(values: readonly DebugInlineValue[]): void {
    const byLine = new Map<number, InlayItem[]>();
    for (const value of values) {
      const text = ` ${value.label}`;
      const item: InlayItem = {
        column: Math.max(0, value.column),
        text,
        width: this.textWidth(text),
        className: `${ROOT_CLASS}-inline-value`,
      };
      const list = byLine.get(value.line);
      if (list) list.push(item);
      else byLine.set(value.line, [item]);
    }
    this.inlineValueByLine = byLine;
    this.layoutCache = null;
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1, wrap: '', semantic: -1, folds: -1 };
    this.render();
  }

  /** Вставки строки в виде «граница и ширина» — для раскладки (`layoutLine`). */
  private insertsFor(line: number): { column: number; width: number }[] {
    return [...(this.inlayByLine.get(line) ?? []), ...(this.inlineValueByLine.get(line) ?? [])].map((item) => ({
      column: item.column,
      width: item.width,
    }));
  }

  /** Ширина текста по метрикам шрифта: сумма клеток его знаков. */
  private textWidth(text: string): number {
    let width = 0;
    for (const char of text) width += this.metrics.widthOf(char.codePointAt(0) ?? 0);
    return width;
  }

  /** Сменить столбцы направляющих (ruler). Пустой список — направляющих нет. */
  setRulers(columns: readonly number[]): void {
    this.rulers = columns;
    this.renderRulers();
  }

  /** Что из невидимых знаков показывать. Смена режима — пересборка видимых строк. */
  setWhitespace(mode: WhitespaceMode): void {
    if (this.whitespace === mode) return;
    this.whitespace = mode;
    this.rerender();
  }

  /** Показать или спрятать миникарту. */
  setMinimap(on: boolean): void {
    if (this.minimapVisible === on) return;
    this.minimapVisible = on;
    this.minimap.element.hidden = !on;
    this.rerender();
  }

  /**
   * Включить или выключить лигатуры шрифта. Это только класс на корне: ширину
   * знаков лигатуры в моноширинном шрифте не меняют, поэтому раскладку (и каретку)
   * пересчитывать не нужно — оформление делает CSS (`styles/editor.css`).
   */
  setLigatures(on: boolean): void {
    this.root.classList.toggle('is-ligatures', on);
  }

  /** Перерисовать направляющие: тонкие черты на столбцах, через всю высоту полотна. */
  private renderRulers(): void {
    if (this.rulers.length === 0) {
      if (this.rulerLayer.childElementCount > 0) this.rulerLayer.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const column of this.rulers) {
      const line = document.createElement('div');
      line.className = `${ROOT_CLASS}-ruler`;
      // Столбец n — черта ПОСЛЕ n знаков: ширина клетки даёт пиксели.
      line.style.left = `${column * this.metrics.charWidth}px`;
      fragment.append(line);
    }
    this.rulerLayer.replaceChildren(fragment);
  }

  private renderSticky(viewportWidth: number): void {
    // Верхняя ВИДИМАЯ строка — по самой прокрутке, а не по первому ряду слоя: тот
    // сдвинут вверх на перескролл (и прижат к нулю у начала файла), и «верх экрана»
    // вышел бы на пару строк ниже настоящего.
    const topLine = this.lineOfRow(Math.floor(this.scrollTop / this.metrics.lineHeight));
    // Строку внутри свёрнутого блока прикалывать нечего — её заголовок приколот.
    const ranges = this.isHidden(topLine) ? [] : enclosingFoldRanges(this.folds.all, topLine);

    if (ranges.length === 0) {
      if (!this.stickyLayer.hidden) {
        this.stickyLayer.hidden = true;
        this.stickyLayer.replaceChildren();
      }
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const range of ranges) {
      const row = document.createElement('div');
      row.className = `${ROOT_CLASS}-sticky-row`;
      const text = document.createElement('span');
      text.className = `${ROOT_CLASS}-sticky-text`;
      text.textContent = this.buffer.lineText(range.startLine).trimEnd();
      row.append(text);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.revealLineInternal(range.startLine);
      });
      fragment.append(row);
    }

    this.stickyLayer.replaceChildren(fragment);
    this.stickyLayer.hidden = false;
    // Ставим слой над верхом поля прокрутки. Место считаем по прямоугольникам, а не
    // через `offsetTop`: когда видна панель поиска, отступ получает сам корень, и
    // разница координат сразу его учитывает — иначе заголовки уехали бы вверх.
    const rootRect = this.root.getBoundingClientRect();
    const viewportRect = this.viewport.getBoundingClientRect();
    this.stickyLayer.style.left = `${viewportRect.left - rootRect.left}px`;
    this.stickyLayer.style.top = `${viewportRect.top - rootRect.top}px`;
    this.stickyLayer.style.width = `${viewportWidth}px`;
  }

  // — украшения —

  /**
   * Сменить набор украшений. Хозяин зовёт это после git-операции, прогона тестов,
   * шага отладки или ответа языкового сервера. Узлы строятся только для видимых
   * строк — как и текст: украшение за кадром всё равно никто не увидит.
   */
  setDecorations(decorations: FileDecorations | null): void {
    this.decorations = decorations ?? new FileDecorations();
    this.decorationsVersion += 1;
    this.render();
  }

  private renderDecorations(first: number, last: number): void {
    this.renderGlyphs(first, last);
    this.renderStrip(first, last);
    this.renderBackgrounds(first, last);
    this.renderSquiggles(first, last);
    this.renderLinks(first, last);
  }

  /** Значки на поле слева: строки поля, в каждой — значок или пусто. */
  private renderGlyphs(first: number, last: number): void {
    if (!this.glyphLines) return;
    const fragment = document.createDocumentFragment();
    // `first`/`last` — видимые строки (с единицы): идём по ним самим, а не по first+1..last+1.
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const span = this.rowSpanOf(line);
      const glyph = this.decorations.glyphFor(line);
      for (let index = 0; index < span; index += 1) {
        const row = document.createElement('div');
        row.className = `${ROOT_CLASS}-glyph-row`;
        // Значок — на первом ряду строки; у продолжения ряда пусто.
        if (index === 0 && glyph) {
          const node = document.createElement('div');
          node.className = glyph.className;
          if (glyph.tooltip) node.title = glyph.tooltip;
          row.append(node);
        }
        fragment.append(row);
      }
    }
    this.glyphLines.replaceChildren(fragment);
    // Поле значков тоже вне прокрутки — компенсируем прокрутку, как у номеров строк.
    this.glyphLines.style.transform = `translateY(${this.yOfLine(first) - this.scrollTop}px)`;
  }

  /** Полоски изменений — узкая колонка справа от номеров. */
  private renderStrip(first: number, last: number): void {
    if (!this.stripLines) return;
    const fragment = document.createDocumentFragment();
    // `first`/`last` — видимые строки (с единицы): идём по ним самим, а не по first+1..last+1.
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const span = this.rowSpanOf(line);
      const strip = this.decorations.stripFor(line);
      for (let index = 0; index < span; index += 1) {
        const row = document.createElement('div');
        row.className = `${ROOT_CLASS}-strip-row`;
        // Полоска изменений помечает всю строку, поэтому тянется по всем её рядам.
        if (strip) {
          for (const name of strip.className.split(' ')) if (name) row.classList.add(name);
          if (strip.tooltip) row.title = strip.tooltip;
        }
        fragment.append(row);
      }
    }
    this.stripLines.replaceChildren(fragment);
    // Полоса изменений тоже вне прокрутки — компенсируем прокрутку, как у номеров строк.
    this.stripLines.style.transform = `translateY(${this.yOfLine(first) - this.scrollTop}px)`;
  }

  /** Заливка всей строки (покрытие, строка отладчика). Тянется на ширину полотна. */
  private renderBackgrounds(first: number, last: number): void {
    const fragment = document.createDocumentFragment();
    // `first`/`last` — видимые строки (с единицы): идём по ним самим, а не по first+1..last+1.
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const background = this.decorations.backgroundFor(line);
      if (!background) continue;
      const span = this.rowSpanOf(line);
      const base = this.rowOf(line);
      for (let index = 0; index < span; index += 1) {
        const node = document.createElement('div');
        node.className = `${ROOT_CLASS}-line-bg ${background.className}`;
        node.style.transform = `translateY(${this.yOfRow(base + index)}px)`;
        node.style.height = `${this.metrics.lineHeight}px`;
        fragment.append(node);
      }
    }
    this.backgroundLayer.replaceChildren(fragment);
  }

  /** Волнистые подчёркивания пометок. Геометрия считается в `decorations.ts`. */
  private renderSquiggles(first: number, last: number): void {
    const fragment = document.createDocumentFragment();
    // `first`/`last` — видимые строки (с единицы): идём по ним самим, а не по first+1..last+1.
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const squiggles = this.decorations.squigglesFor(line);
      if (squiggles.length === 0) continue;
      const offsets = this.offsetsFor(line);
      if (!this.wrapOn) {
        for (const squiggly of squiggles) {
          const rect = squigglyRect(offsets, line, squiggly.startColumn, squiggly.endColumn, this.metrics);
          if (rect.width <= 0) continue;
          const node = document.createElement('div');
          node.className = `${ROOT_CLASS}-squiggly-rect ${squiggly.className}`;
          node.style.transform = `translate(${rect.left}px, ${this.yOfLine(line)}px)`;
          node.style.width = `${rect.width}px`;
          node.style.height = `${rect.height}px`;
          fragment.append(node);
        }
        continue;
      }
      // Перенос: пометка может лежать на нескольких рядах — режем её по отрезкам.
      const segments = this.segmentsFor(line);
      const base = this.rowOf(line);
      for (const squiggly of squiggles) {
        const from = Math.max(0, squiggly.startColumn - 1);
        const to = Math.max(from, squiggly.endColumn - 1);
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index]!;
          const start = Math.max(from, segment.startColumn);
          const end = Math.min(to, segment.endColumn);
          if (end <= start) continue;
          const origin = xForColumn(offsets, segment.startColumn);
          const left = xForColumn(offsets, start) - origin;
          const width = xForColumn(offsets, end) - origin - left;
          if (width <= 0) continue;
          const node = document.createElement('div');
          node.className = `${ROOT_CLASS}-squiggly-rect ${squiggly.className}`;
          node.style.transform = `translate(${left}px, ${this.yOfRow(base + index)}px)`;
          node.style.width = `${width}px`;
          node.style.height = `${this.metrics.lineHeight}px`;
          fragment.append(node);
        }
      }
    }
    this.squigglyLayer.replaceChildren(fragment);
  }

  /**
   * Ссылки в тексте: подчёркнутые и кликабельные участки. Строение — как у
   * волнистых подчёркиваний, но элемент ловит клик: у него есть `data-line` и
   * `data-column` — по ним хозяин находит свою ссылку (и адрес, куда вести).
   */
  private renderLinks(first: number, last: number): void {
    const fragment = document.createDocumentFragment();
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const links = this.decorations.linksFor(line);
      if (links.length === 0) continue;
      const offsets = this.offsetsFor(line);
      if (!this.wrapOn) {
        for (const link of links) {
          const rect = squigglyRect(offsets, line, link.startColumn, link.endColumn, this.metrics);
          if (rect.width <= 0) continue;
          fragment.append(this.linkNode(link, rect.left, this.yOfLine(line), rect.width));
        }
        continue;
      }
      // Перенос: ссылка может лежать на нескольких рядах — режем по отрезкам.
      const segments = this.segmentsFor(line);
      const base = this.rowOf(line);
      for (const link of links) {
        const from = Math.max(0, link.startColumn - 1);
        const to = Math.max(from, link.endColumn - 1);
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index]!;
          const start = Math.max(from, segment.startColumn);
          const end = Math.min(to, segment.endColumn);
          if (end <= start) continue;
          const origin = xForColumn(offsets, segment.startColumn);
          const left = xForColumn(offsets, start) - origin;
          const width = xForColumn(offsets, end) - origin - left;
          if (width <= 0) continue;
          fragment.append(this.linkNode(link, left, this.yOfRow(base + index), width));
        }
      }
    }
    this.linkLayer.replaceChildren(fragment);
  }

  /** Узел ссылки: прямоугольник с данными для клика и подписью наведения. */
  private linkNode(link: LinkDecoration, left: number, top: number, width: number): HTMLElement {
    const node = document.createElement('div');
    node.className = `${ROOT_CLASS}-link`;
    node.dataset.line = String(link.line);
    node.dataset.column = String(link.startColumn);
    if (link.tooltip) node.title = link.tooltip;
    node.style.transform = `translate(${left}px, ${top}px)`;
    node.style.width = `${width}px`;
    node.style.height = `${this.metrics.lineHeight}px`;
    return node;
  }

  /** Клик по слою ссылок: если попали в саму ссылку — отдаём хозяину. */
  private readonly onLinkLayerClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const node = target.closest<HTMLElement>(`.${ROOT_CLASS}-link`);
    if (!node) return;
    const line = Number(node.dataset.line ?? '0');
    const column = Number(node.dataset.column ?? '0');
    if (line > 0 && column > 0) this.onLinkClick?.(line, column);
  };

  /**
   * Номер строки под точкой экрана (с единицы). Нужно кликам по местам украшений:
   * представление переводит координату в строку, а что значит клик — решает хозяин.
   */
  lineAtPoint(clientY: number): number {
    const rect = this.viewport.getBoundingClientRect();
    const y = clientY - rect.top + this.viewport.scrollTop;
    return this.lineOfRow(lineAtY(y, this.metrics.lineHeight, this.rowCount()));
  }

  /**
   * Слушать клики по местам украшений. Сообщаем только строку и область: запустить
   * файл или переключить точку останова — знание хозяина, а не представления.
   */
  private bindAreaEvents(): void {
    const lineOf = (event: MouseEvent): number => this.lineAtPoint(event.clientY);

    // Правый клик по полотну: показываем своё меню вместо системного. Меню собирает
    // хозяин — представление лишь сообщает, что клик был.
    this.viewport.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onContextMenu?.(event);
    });

    this.glyphMargin?.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.onGlyphClick?.(lineOf(event), event);
    });
    this.glyphMargin?.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onGlyphContextMenu?.(lineOf(event), event);
    });

    this.strip?.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.onStripClick?.(lineOf(event), event);
    });
    this.strip?.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onStripContextMenu?.(lineOf(event), event);
    });

    this.gutter?.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.onGutterClick?.(lineOf(event), event);
    });
    this.gutter?.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onGutterContextMenu?.(lineOf(event), event);
    });
  }

  /**
   * Прямоугольники диапазона смещений с учётом переноса: длинная строка даёт по
   * прямоугольнику на каждый задетый отрезок. `row` — абсолютный ряд полотна, его
   * представление переводит в y. Без переноса берём прежний путь (`selection.ts`):
   * там геометрия уже посчитана, а строки на экране совпадают с рядами.
   */
  private rangeRects(start: number, end: number): Array<{ row: number; left: number; width: number; height: number }> {
    const height = this.metrics.lineHeight;
    const rects: Array<{ row: number; left: number; width: number; height: number }> = [];
    if (end <= start) return rects;
    if (!this.wrapOn) {
      for (const rect of rangesRects(this.buffer, [{ start, end }], this.metrics)) {
        if (this.isHidden(rect.line)) continue;
        rects.push({ row: this.rowOf(rect.line), left: rect.left, width: rect.width, height });
      }
      return rects;
    }
    const first = this.buffer.lineAt(start);
    const last = this.buffer.lineAt(end);
    for (let line = first; line <= last; line += 1) {
      if (this.isHidden(line)) continue;
      const lineStart = this.buffer.lineStart(line);
      const text = this.buffer.lineText(line);
      const lineEnd = lineStart + text.length;
      const from = Math.max(start, lineStart) - lineStart;
      const to = Math.min(end, lineEnd) - lineStart;
      const offsets = this.offsetsFor(line);
      const segments = this.segmentsFor(line);
      const base = this.rowOf(line);
      // Участок доходит до конца строки и продолжается дальше — на конце ряда рисуем
      // полоску в знак: иначе выделение выглядело бы обрезанным ровно по последнему знаку.
      const swallow = line < last;
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        const a = Math.max(from, segment.startColumn);
        const b = Math.min(to, segment.endColumn);
        if (b <= a) continue;
        const origin = offsets[segment.startColumn] ?? 0;
        const left = (offsets[a] ?? 0) - origin;
        let right = (offsets[b] ?? 0) - origin;
        if (swallow && b >= segment.endColumn && index === segments.length - 1) right += this.metrics.charWidth;
        const width = right - left;
        if (width <= 0) continue;
        rects.push({ row: base + index, left, width, height });
      }
    }
    return rects;
  }

  /** Каретка — она же «активный» конец выделения — и прямоугольники заливки. */
  private updateCaretAndSelection(): void {
    const lineHeight = this.metrics.lineHeight;

    const primary = this.primarySelection;
    // Лишние узлы прошлого кадра убираем: каретки стало меньше (сняли мультикурсор).
    while (this.caretNodes.length > this.selections.length) this.caretNodes.pop()?.remove();
    const shades = document.createDocumentFragment();

    for (const [index, selection] of this.selections.entries()) {
      const line = this.buffer.lineAt(selection.active);
      const column = selection.active - this.buffer.lineStart(line);
      const offsets = this.offsetsFor(line);
      const segments = this.segmentsFor(line);
      const segment = segmentIndexForColumn(segments, column);
      const origin = offsets[segments[segment]?.startColumn ?? 0] ?? 0;
      const x = (offsets[column] ?? origin) - origin;

      // Узел берём прежний, если он есть: только тогда CSS-переход двигает каретку, а
      // не появляется она на новом месте молча.
      let node = this.caretNodes[index];
      const fresh = node === undefined;
      if (!node) {
        node = document.createElement('div');
        node.className = `${ROOT_CLASS}-caret`;
        this.caretNodes[index] = node;
      }
      // У неглавной каретки не мигаем: при десятке кареток мигание рябит, а главную
      // и так видно по миганию.
      node.classList.toggle('is-idle', selection !== primary);
      node.style.height = `${lineHeight}px`;
      // При непустом выделении каретка не нужна — его конец и так виден заливкой.
      node.style.display = isEmpty(selection) ? '' : 'none';
      node.style.transform = `translate(${x}px, ${this.yOfRow(this.rowOf(line) + segment)}px)`;
      // Ставим узел в слой ТОЛЬКО после стилей: иначе первый кадр он провёл бы в углу
      // полотна и «приехал» оттуда.
      if (fresh) this.caretLayer.append(node);

      for (const rect of this.rangeRects(selectionStart(selection), selectionEnd(selection))) {
        const shade = document.createElement('div');
        shade.className = `${ROOT_CLASS}-selection-rect`;
        shade.style.transform = `translate(${rect.left}px, ${this.yOfRow(rect.row)}px)`;
        shade.style.width = `${rect.width}px`;
        shade.style.height = `${rect.height}px`;
        shades.append(shade);
      }
    }
    this.selectionLayer.replaceChildren(shades);
  }

  /** Раскладка строки по x с кэшем на одну строку: обычно спрашивают про одну и ту же. */
  private offsetsFor(line: number): number[] {
    const cache = this.layoutCache;
    if (cache && cache.line === line && cache.version === this.buffer.version) {
      return cache.offsets;
    }
    const offsets = layoutLine(this.buffer.lineText(line), this.metrics, this.insertsFor(line));
    this.layoutCache = { version: this.buffer.version, line, offsets };
    return offsets;
  }

  private revealRowInternal(row: number): void {
    const scrollTop = revealLine(
      row,
      this.scrollTop,
      this.metrics.lineHeight,
      this.viewport.clientHeight,
      this.rowCount(),
    );
    if (scrollTop !== this.scrollTop) {
      // Прокрутка сдвинулась — строки пересобирает обработчик `scroll`. Дальний прыжок
      // (курсор уехал за экран) ведём разгоном, если плавность включена и не отменена.
      this.setScrollTop(scrollTop, true);
      return;
    }
    // Строка и так видна: хватит передвинуть каретку, пересобирать строки незачем.
    this.updateCaretAndSelection();
  }

  private revealLineInternal(line: number): void {
    this.revealRowInternal(this.rowOf(line) - 1);
  }

  private readonly onScroll = (): void => {
    // Прокрутку мог тронуть человек (колесо, полоса прокрутки) — тогда анимацию бросаем:
    // она бы спорила с его рукой. Отличаем по месту: если поле уехало не туда, куда его
    // повёл наш кадр, значит прокрутил кто-то другой.
    const animation = this.scrollAnimation;
    if (animation && Math.abs(this.viewport.scrollTop - animation.last) > 1) this.stopScrollAnimation();
    this.render();
  };

  /** Метрики из оформления корня: шрифт и высота строки уже заданы CSS. */
  private applyMetrics(): void {
    this.root.style.setProperty('--own-editor-line-height', `${this.metrics.lineHeight}px`);
    this.root.style.setProperty('--own-editor-char-width', `${this.metrics.charWidth}px`);
    this.root.style.setProperty('--own-editor-tab-size', String(this.metrics.tabSize));
    this.gutter?.style.setProperty('--own-editor-line-height', `${this.metrics.lineHeight}px`);
    // Направляющие зависят только от ширины клетки и столбцов: перекладываем вместе с метриками.
    this.renderRulers();
  }

  /**
   * Цвета токенов — переменными на корне редактора. Так цвета приходят из палитры
   * темы (той же, что у Monaco и чата), а оформление остаётся в CSS: классы
   * `own-editor-token-*` берут значения отсюда. Своих цветов в разметке нет — иначе
   * они не менялись бы вместе со схемой.
   */
  private applyTheme(): void {
    const palette = paletteOf(this.scheme);
    for (const [role, color] of Object.entries(palette)) {
      this.root.style.setProperty(`--own-token-${role}`, color);
    }
  }
}

/** Просит ли система меньше движения (`prefers-reduced-motion`). */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

/** Отрезок, покрывающий всю строку (перенос выключен). */
function wholeLine(offsets: readonly number[]): WrapSegment {
  return { startColumn: 0, endColumn: offsets.length - 1 };
}

/**
 * Метрики по оформлению корня: кегль, высота строки и семейство шрифта берутся из
 * вычисленного стиля, чтобы раскладка совпала с тем, что реально нарисовано. Если стиль
 * недоступен — берём моноширинный по умолчанию. Само измерение — в `glyph-metrics.ts`.
 */
function measureFromHost(host: HTMLElement): GlyphMetrics {
  const style = window.getComputedStyle(host);
  const fontSize = Number.parseFloat(style.fontSize) || 13;
  const declared = Number.parseFloat(style.lineHeight);
  // Высоту строки округляем до целого пикселя. Дробная (1.4 от кегля 14 даёт 19.6)
  // копится в сдвиге слоёв и на длинном файле превращается в видимый шов между
  // строками: `translateY(19.6px)` от кадра к кадру ложится по-разному.
  const lineHeight = Math.round(declared || fontSize * 1.4);
  return measureFont(host, fontSize, lineHeight, 4);
}

/** Совпадают ли два набора семантических токенов: лишний кадр на тот же ответ не нужен. */
function sameSemantic(left: Map<number, RoleRange[]>, right: Map<number, RoleRange[]>): boolean {
  if (left.size !== right.size) return false;
  for (const [line, ranges] of left) {
    const other = right.get(line);
    if (!other || other.length !== ranges.length) return false;
    for (let index = 0; index < ranges.length; index += 1) {
      if (
        ranges[index]!.start !== other[index]!.start ||
        ranges[index]!.end !== other[index]!.end ||
        ranges[index]!.role !== other[index]!.role
      ) {
        return false;
      }
    }
  }
  return true;
}
