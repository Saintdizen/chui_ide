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
import { grammarFor } from '../highlight/registry';
import { paletteOf, roleOfToken, type Scheme } from '../highlight/style';
import { measureFont, monospaceMetrics, type GlyphMetrics } from './glyph-metrics';
import { columnForX, layoutLine, lineWidth, xForColumn } from './line-layout';
import { FileDecorations, squigglyRect } from './decorations';
import { caret, isEmpty, rangesRects, selectionRects, type Selection } from './selection';
import { clamp, contentHeight, lineAtY, maxScrollLeft, maxScrollTop, revealLine, visibleLines } from './viewport';

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
}

/** Ширина полосы украшений (черта изменений git) — узкая, как в Monaco. */
const STRIP_WIDTH = 3;

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
  private readonly backgroundLayer: HTMLElement;
  private readonly selectionLayer: HTMLElement;
  private readonly searchLayer: HTMLElement;
  private readonly squigglyLayer: HTMLElement;
  private readonly ghostLayer: HTMLElement;
  private readonly caret: HTMLElement;
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
  private selection: Selection;
  private scrollTop = 0;
  private disposed = false;
  /** Подсветка видимых строк: кэш токенов по строкам (см. `highlight/highlighter.ts`). */
  private readonly highlighter: LineHighlighter;
  private scheme: Scheme;
  /** Сколько строк было в документе: по смене числа понимаем, сдвинулись ли строки. */
  private lineCount = 0;
  /** Совпадения поиска и номер текущего: перерисовываются вместе со строками. */
  private searchMatches: readonly { start: number; end: number }[] = [];
  private searchCurrent = -1;
  /** Самая широкая известная строка: ширину полотна узнаём по мере отрисовки. */
  private widest = 0;
  /** Что сейчас в DOM: версия буфера, границы видимых строк и версия украшений — чтобы не пересобирать зря. */
  private rendered = { version: -1, first: -1, last: -1, decorations: -1 };
  private layoutCache: LineLayoutCache | null = null;

  /** Украшения текущего файла: значки, полоски, фон, подписи, подчёркивания. */
  private decorations = new FileDecorations();
  /** Меняется на каждую смену набора украшений: по ней строки пересобираются. */
  private decorationsVersion = 0;
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

  constructor(host: HTMLElement, buffer: TextBuffer, options: EditorViewOptions = {}) {
    this.host = host;
    this.buffer = buffer;
    this.overscan = options.overscan ?? 2;
    this.selection = caret(0);
    this.scheme = options.scheme ?? 'dark';
    this.lineCount = buffer.lineCount;
    // Текст строки подсветка берёт сама — ей довольно функции: так её можно проверить
    // в тестах без модели текста (см. `highlight/highlighter.ts`).
    this.highlighter = new LineHighlighter(options.language ? grammarFor(options.language) : null, (line) =>
      this.buffer.lineText(line + 1),
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

    this.viewport = document.createElement('div');
    this.viewport.className = `${ROOT_CLASS}-viewport`;
    this.content = document.createElement('div');
    this.content.className = `${ROOT_CLASS}-content`;
    this.backgroundLayer = document.createElement('div');
    this.backgroundLayer.className = `${ROOT_CLASS}-backgrounds`;
    this.selectionLayer = document.createElement('div');
    this.selectionLayer.className = `${ROOT_CLASS}-selection`;
    this.searchLayer = document.createElement('div');
    this.searchLayer.className = `${ROOT_CLASS}-search`;
    this.squigglyLayer = document.createElement('div');
    this.squigglyLayer.className = `${ROOT_CLASS}-squiggly`;
    this.ghostLayer = document.createElement('div');
    this.ghostLayer.className = `${ROOT_CLASS}-ghost-layer`;
    this.linesLayer = document.createElement('div');
    this.linesLayer.className = `${ROOT_CLASS}-lines`;
    this.caret = document.createElement('div');
    this.caret.className = `${ROOT_CLASS}-caret`;

    // Порядок слоёв, снизу вверх: заливка строки, совпадения, выделение, подчёркивания,
    // текст, призрачная подсказка, каретка. Текст читается поверх заливок, а волнистые
    // подчёркивания лежат под ним, но над выделением: пометка важнее заливки, но не
    // закрывает буквы. Призрачная подсказка — над текстом (она дописывает за кареткой),
    // но под кареткой, чтобы та оставалась видна.
    this.content.append(
      this.backgroundLayer,
      this.searchLayer,
      this.selectionLayer,
      this.squigglyLayer,
      this.linesLayer,
      this.ghostLayer,
      this.caret,
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
    this.root.append(this.strip, this.viewport);
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
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1 };
    this.applyMetrics();
    this.render();
  }

  get element(): HTMLElement {
    return this.root;
  }

  /** Текущее выделение (два конца). Пустое — каретка. */
  get selectionState(): Selection {
    return this.selection;
  }

  /** Поставить выделение и перерисовать каретку с заливкой. */
  setSelection(selection: Selection): void {
    this.selection = selection;
    this.updateCaretAndSelection();
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
    const left = xForColumn(this.offsetsFor(line), column);

    const container = document.createElement('div');
    container.className = `${ROOT_CLASS}-ghost`;
    container.style.transform = `translate(${left}px, ${(line - 1) * this.metrics.lineHeight}px)`;

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
      for (const rect of rangesRects(this.buffer, [match], this.metrics)) {
        const node = document.createElement('div');
        node.className =
          index === this.searchCurrent ? `${ROOT_CLASS}-search-rect is-current` : `${ROOT_CLASS}-search-rect`;
        node.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
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
    this.revealLineInternal(line);
  }

  /**
   * Смещение под точкой экрана — перевод клика мышью в позицию в тексте. Работает
   * и за пределами строки: столбец прижимается к её концу, как при клике мимо текста.
   */
  offsetAt(clientX: number, clientY: number): number {
    const rect = this.viewport.getBoundingClientRect();
    const x = clientX - rect.left + this.viewport.scrollLeft;
    const y = clientY - rect.top + this.viewport.scrollTop;
    const line = lineAtY(y, this.metrics.lineHeight, this.buffer.lineCount) + 1;
    const text = this.buffer.lineText(line);
    const column = columnForX(layoutLine(text, this.metrics), x);
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
    const left = xForColumn(this.offsetsFor(line), column);
    return { left, top: (line - 1) * this.metrics.lineHeight, height: this.metrics.lineHeight };
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
    }
    this.lineCount = this.buffer.lineCount;
    this.render();
  }

  /** Сменить язык подсветки (открыли другой файл в этой же вкладке). */
  setLanguage(languageId: string): void {
    this.highlighter.setGrammar(grammarFor(languageId));
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

  /** Сменить кегль текста: меняется ширина клетки и высота строки — метрики перемеряем. */
  setFontSize(fontSize: number): void {
    const size = Math.max(1, Math.floor(fontSize));
    if (this.root.style.fontSize === `${size}px`) return;
    this.root.style.fontSize = `${size}px`;
    this.remeasure();
  }

  /** Язык, для которого сейчас есть подсветка (`null` — текст показывается как простой). */
  get highlightLanguage(): string | null {
    return this.highlighter.language;
  }

  /** Заставить пересобрать строки: сменилась подсветка или схема, а версия текста та же. */
  private rerender(): void {
    this.widest = 0;
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1 };
    this.render();
  }

  /** Сменить документ (новая вкладка). Прокрутку и выделение сбрасываем к началу. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.selection = caret(0);
    this.scrollTop = 0;
    this.widest = 0;
    this.layoutCache = null;
    this.lineCount = buffer.lineCount;
    this.highlighter.reset();
    this.viewport.scrollTo({ top: 0, left: 0 });
    // Украшения принадлежали прошлому файлу (полоски git, точки останова): их
    // рисует хозяин уже для нового — до этого не должно остаться чужих значков.
    this.decorations = new FileDecorations();
    this.decorationsVersion += 1;
    // Призрачная подсказка говорила о прошлом файле — к новому она не относится.
    this.ghost = null;
    this.ghostLayer.replaceChildren();
    this.rendered = { version: -1, first: -1, last: -1, decorations: -1 };
    this.render();
  }

  focus(): void {
    this.root.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.viewport.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.root.remove();
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
    const scrollTop = clamp(this.viewport.scrollTop, maxScrollTop(this.buffer.lineCount, lineHeight, height));
    // Прокрутку вбок при необходимости подрежем: полотно уже сузилось до самой
    // широкой строки, и без этого правый край остался бы за экраном.
    const maxLeft = maxScrollLeft(this.widest, width);
    if (this.viewport.scrollLeft > maxLeft) this.viewport.scrollLeft = maxLeft;
    this.scrollTop = scrollTop;

    const { first, last } = visibleLines(scrollTop, lineHeight, height, this.buffer.lineCount, this.overscan);

    // Порядок важен: сначала строки — они уточняют самую широкую, потом размер
    // полотна по ней, иначе широкая строка кадр останется за краем.
    this.renderLines(first, last);
    this.renderGutter(first, last);
    this.renderDecorations(first, last);
    this.sizeContent(width, height);
    // Совпадения поиска живут в тех же строках, что и текст: после прокрутки их
    // видимый набор изменился, поэтому перерисовываем вместе со строками.
    this.renderSearch();
    // Призрачный текст привязан к каретке: после смены метрик его надо переложить.
    this.renderGhost();
    this.updateCaretAndSelection();
  }

  /** Размер полотна: высота — по числу строк, ширина — по самой широкой известной строке. */
  private sizeContent(viewportWidth: number, viewportHeight: number): void {
    const height = Math.max(contentHeight(this.buffer.lineCount, this.metrics.lineHeight), viewportHeight);
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
      this.rendered.decorations === this.decorationsVersion;
    if (same) return;

    const fragment = document.createDocumentFragment();
    for (let line = first + 1; line <= last + 1; line += 1) {
      const text = this.buffer.lineText(line);
      const offsets = layoutLine(text, this.metrics);
      const width = lineWidth(offsets);
      if (width > this.widest) this.widest = width;

      const row = document.createElement('div');
      row.className = `${ROOT_CLASS}-line`;
      this.fillLine(row, text, line);
      fragment.append(row);
    }

    this.linesLayer.replaceChildren(fragment);
    // Слой сдвигаем к первой видимой строке, а не пересоздаём на её месте.
    this.linesLayer.style.transform = `translateY(${first * this.metrics.lineHeight}px)`;
    this.rendered = { version, first, last, decorations: this.decorationsVersion };
  }

  /**
   * Собрать строку из токенов. Куски, которым роль не нашлась, кладём обычным текстом,
   * а не пустым `<span>`: лишний узел на каждый знак препинания — это заметный мусор в
   * разметке и лишняя работа браузеру на каждой отрисовке.
   *
   * Подпись blame дописывается после содержимого строки отдельным куском: она не часть
   * файла и в раскладку кода не входит — как `after` у декораций Monaco.
   */
  private fillLine(row: HTMLElement, text: string, line: number): void {
    const line0 = line - 1;
    const tokens = this.highlighter.tokensFor(line0);
    const after = this.decorations.afterFor(line);
    const fragment = document.createDocumentFragment();

    if (tokens.length === 0) {
      fragment.append(document.createTextNode(text));
    } else {
      let cursor = 0;
      for (const token of tokens) {
        if (token.start > cursor) fragment.append(document.createTextNode(text.slice(cursor, token.start)));
        const role = roleOfToken(token.type);
        const piece = text.slice(token.start, token.end);
        if (role) {
          const span = document.createElement('span');
          // Класс — роль палитры, а цвет берётся переменной с корня (`applyTheme`).
          span.className = `${ROOT_CLASS}-token-${role}`;
          span.textContent = piece;
          fragment.append(span);
        } else {
          fragment.append(document.createTextNode(piece));
        }
        cursor = token.end;
      }
      if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    }

    if (after) {
      const span = document.createElement('span');
      span.className = after.className;
      span.textContent = after.content;
      fragment.append(span);
    }

    row.replaceChildren(fragment);
  }

  /** Номера строк — отдельный слой слева, он не едет по горизонтали. */
  private renderGutter(first: number, last: number): void {
    if (!this.gutterLines || !this.gutter) return;
    const fragment = document.createDocumentFragment();
    for (let line = first + 1; line <= last + 1; line += 1) {
      const row = document.createElement('div');
      row.className = `${ROOT_CLASS}-gutter-row`;
      row.textContent = String(line);
      fragment.append(row);
    }
    this.gutterLines.replaceChildren(fragment);
    this.gutterLines.style.transform = `translateY(${first * this.metrics.lineHeight}px)`;
    // Ширина по числу разрядов последней строки: цифры моноширинны, ширина известна.
    const digits = String(this.buffer.lineCount).length;
    this.gutter.style.width = `${digits * this.metrics.charWidth + 16}px`;
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
  }

  /** Значки на поле слева: строки поля, в каждой — значок или пусто. */
  private renderGlyphs(first: number, last: number): void {
    if (!this.glyphLines) return;
    const fragment = document.createDocumentFragment();
    for (let line = first + 1; line <= last + 1; line += 1) {
      const row = document.createElement('div');
      row.className = `${ROOT_CLASS}-glyph-row`;
      const glyph = this.decorations.glyphFor(line);
      if (glyph) {
        const node = document.createElement('div');
        node.className = glyph.className;
        if (glyph.tooltip) node.title = glyph.tooltip;
        row.append(node);
      }
      fragment.append(row);
    }
    this.glyphLines.replaceChildren(fragment);
    this.glyphLines.style.transform = `translateY(${first * this.metrics.lineHeight}px)`;
  }

  /** Полоски изменений — узкая колонка справа от номеров. */
  private renderStrip(first: number, last: number): void {
    if (!this.stripLines) return;
    const fragment = document.createDocumentFragment();
    for (let line = first + 1; line <= last + 1; line += 1) {
      const row = document.createElement('div');
      row.className = `${ROOT_CLASS}-strip-row`;
      const strip = this.decorations.stripFor(line);
      if (strip) {
        for (const name of strip.className.split(' ')) if (name) row.classList.add(name);
        if (strip.tooltip) row.title = strip.tooltip;
      }
      fragment.append(row);
    }
    this.stripLines.replaceChildren(fragment);
    this.stripLines.style.transform = `translateY(${first * this.metrics.lineHeight}px)`;
  }

  /** Заливка всей строки (покрытие, строка отладчика). Тянется на ширину полотна. */
  private renderBackgrounds(first: number, last: number): void {
    const fragment = document.createDocumentFragment();
    for (let line = first + 1; line <= last + 1; line += 1) {
      const background = this.decorations.backgroundFor(line);
      if (!background) continue;
      const node = document.createElement('div');
      node.className = `${ROOT_CLASS}-line-bg ${background.className}`;
      node.style.transform = `translateY(${(line - 1) * this.metrics.lineHeight}px)`;
      node.style.height = `${this.metrics.lineHeight}px`;
      fragment.append(node);
    }
    this.backgroundLayer.replaceChildren(fragment);
  }

  /** Волнистые подчёркивания пометок. Геометрия считается в `decorations.ts`. */
  private renderSquiggles(first: number, last: number): void {
    const fragment = document.createDocumentFragment();
    for (let line = first + 1; line <= last + 1; line += 1) {
      const squiggles = this.decorations.squigglesFor(line);
      if (squiggles.length === 0) continue;
      const offsets = this.offsetsFor(line);
      for (const squiggly of squiggles) {
        const rect = squigglyRect(offsets, line, squiggly.startColumn, squiggly.endColumn, this.metrics);
        if (rect.width <= 0) continue;
        const node = document.createElement('div');
        node.className = `${ROOT_CLASS}-squiggly-rect ${squiggly.className}`;
        node.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
        fragment.append(node);
      }
    }
    this.squigglyLayer.replaceChildren(fragment);
  }

  /**
   * Номер строки под точкой экрана (с единицы). Нужно кликам по местам украшений:
   * представление переводит координату в строку, а что значит клик — решает хозяин.
   */
  lineAtPoint(clientY: number): number {
    const rect = this.viewport.getBoundingClientRect();
    const y = clientY - rect.top + this.viewport.scrollTop;
    return lineAtY(y, this.metrics.lineHeight, this.buffer.lineCount) + 1;
  }

  /**
   * Слушать клики по местам украшений. Сообщаем только строку и область: запустить
   * файл или переключить точку останова — знание хозяина, а не представления.
   */
  private bindAreaEvents(): void {
    const lineOf = (event: MouseEvent): number => this.lineAtPoint(event.clientY);

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

  /** Каретка — она же «активный» конец выделения — и прямоугольники заливки. */
  private updateCaretAndSelection(): void {
    const lineHeight = this.metrics.lineHeight;

    const activeLine = this.buffer.lineAt(this.selection.active);
    const activeColumn = this.selection.active - this.buffer.lineStart(activeLine);
    const activeX = xForColumn(this.offsetsFor(activeLine), activeColumn);
    this.caret.style.transform = `translate(${activeX}px, ${(activeLine - 1) * lineHeight}px)`;
    this.caret.style.height = `${lineHeight}px`;
    this.caret.style.display = isEmpty(this.selection) ? '' : 'none';

    const fragment = document.createDocumentFragment();
    if (!isEmpty(this.selection)) {
      for (const rect of selectionRects(this.buffer, this.selection, this.metrics)) {
        const node = document.createElement('div');
        node.className = `${ROOT_CLASS}-selection-rect`;
        node.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        node.style.width = `${rect.width}px`;
        node.style.height = `${rect.height}px`;
        fragment.append(node);
      }
    }
    this.selectionLayer.replaceChildren(fragment);
  }

  /** Раскладка строки по x с кэшем на одну строку: обычно спрашивают про одну и ту же. */
  private offsetsFor(line: number): number[] {
    const cache = this.layoutCache;
    if (cache && cache.line === line && cache.version === this.buffer.version) {
      return cache.offsets;
    }
    const offsets = layoutLine(this.buffer.lineText(line), this.metrics);
    this.layoutCache = { version: this.buffer.version, line, offsets };
    return offsets;
  }

  private revealLineInternal(line: number): void {
    const scrollTop = revealLine(
      line - 1,
      this.scrollTop,
      this.metrics.lineHeight,
      this.viewport.clientHeight,
      this.buffer.lineCount,
    );
    if (scrollTop !== this.scrollTop) {
      this.viewport.scrollTop = scrollTop;
      // Прокрутка сдвинулась — строки пересобираем (это сделает обработчик `scroll`).
      return;
    }
    // Строка и так видна: хватит передвинуть каретку, пересобирать строки незачем.
    this.updateCaretAndSelection();
  }

  private readonly onScroll = (): void => {
    this.render();
  };

  /** Метрики из оформления корня: шрифт и высота строки уже заданы CSS. */
  private applyMetrics(): void {
    this.root.style.setProperty('--own-editor-line-height', `${this.metrics.lineHeight}px`);
    this.root.style.setProperty('--own-editor-char-width', `${this.metrics.charWidth}px`);
    this.root.style.setProperty('--own-editor-tab-size', String(this.metrics.tabSize));
    this.gutter?.style.setProperty('--own-editor-line-height', `${this.metrics.lineHeight}px`);
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
