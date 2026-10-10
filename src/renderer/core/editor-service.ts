import * as monaco from 'monaco-editor';
import type { DiagnosticItem, EditorSettings, LspDiagnostic } from '../../shared/api';
import type { TextEdit } from '../../shared/edits';
import './monaco-env';
import type { RunnableTest } from '../../shared/python-tests';
import type { BreakpointInput } from './debug';
import { uriToPath, type TextDocument } from './document';
import type { DocumentStore } from './document-store';
import { EditorModels } from './editor-models';
import { Emitter } from './events';
import { applyTypeScriptDefaults, registerLanguageModes } from './language-modes';
import { MONACO_THEMES, MONACO_THEME_IDS, type Scheme } from './theme';

/** Настройки редактора приходят из общего контракта: окно настроек и редактор — одно целое. */
export type EditorOptions = EditorSettings;

export interface CursorState {
  path: string | null;
  line: number;
  column: number;
  selections: number;
}

/** Нажали на значок запуска в жёлобе — этот файл и строку и просят выполнить. */
export interface RunMarkerHit {
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

/** Управление одним экраном сравнения; модели Monaco живут внутри сервиса. */
export interface DiffEditorHandle {
  set(input: { language: string; original: string; modified: string }): void;
  dispose(): void;
}

/** Значение выражения для подсказки под курсором: что показать и какого типа. */
export interface DebugHoverValue {
  value: string;
  type: string | null;
}

/** Где запрошена подсказка: файл и строка под курсором. */
export interface DebugHoverPosition {
  path: string;
  line: number;
}

/** Языки, для которых под курсором показываем значение из остановленного кадра. */
const DEBUG_HOVER_LANGUAGES = ['python', 'javascript', 'typescript'] as const;

/** Панель области редактора: своя область Monaco и свой открытый в ней файл. */
interface EditorPane {
  host: HTMLElement;
  editor: monaco.editor.IStandaloneCodeEditor;
  /** Путь открытого в панели файла; `null` — панель пуста. */
  path: string | null;
}

/**
 * Единственное место, где renderer знает про Monaco.
 *
 * Область редактора делится на панели (одну или две). Моделями панели не владеют:
 * их держит общий реестр `EditorModels`, поэтому один и тот же файл можно смотреть
 * в двух панелях сразу, а правка видна в обеих. Правило одного писателя между
 * моделью и документом стережёт реестр.
 */
export class EditorService {
  private readonly cursorEmitter = new Emitter<CursorState>();
  readonly onCursorChange = this.cursorEmitter.event;

  /** Просьба запустить файл со значка в жёлобе. */
  private readonly runMarkerEmitter = new Emitter<RunMarkerHit>();
  readonly onRunMarker = this.runMarkerEmitter.event;

  /** Клик по полю номеров строк: включить или выключить точку останова на строке. */
  private readonly breakpointEmitter = new Emitter<RunMarkerHit>();
  readonly onBreakpointToggle = this.breakpointEmitter.event;

  /** Правый клик по полю номеров строк: меню точки останова (условие, удаление). */
  private readonly breakpointMenuEmitter = new Emitter<RunMarkerHit>();
  readonly onBreakpointMenu = this.breakpointMenuEmitter.event;

  /** Клик по значку ▶ у объявления теста — запустить именно этот тест. */
  private readonly testMarkerEmitter = new Emitter<TestMarkerHit>();
  readonly onTestMarker = this.testMarkerEmitter.event;

  /** Разделение области редактора: кнопка и команда идут за этим состоянием. */
  private readonly splitEmitter = new Emitter<boolean>();
  readonly onDidChangeSplit = this.splitEmitter.event;

  /** Пометки языка изменились — статусбар пересчитывает счётчик проблем. */
  private readonly markersEmitter = new Emitter<void>();
  readonly onDidChangeMarkers = this.markersEmitter.event;

  /** Модели файлов — общие на приложение: владеет реестр, редактор их арендует. */
  private readonly files: EditorModels;
  /** Схема: новую панель тоже одеваем в текущую тему, а не в тему по умолчанию. */
  private readonly theme: string;

  /** Зона редактора — ряд панелей: одна, пока не разделили, и вторая после. */
  private readonly panesHost: HTMLElement;
  private readonly splitter: HTMLElement;
  private readonly panes: EditorPane[] = [];
  private activePane = 0;

  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  /** Значки запуска по файлам: нарисованные украшения нужно убирать перед новой отрисовкой. */
  private readonly runDecorations = new Map<string, string[]>();
  private readonly runLines = new Map<string, ReadonlySet<number>>();
  /** Точки останова по файлам и их украшения — по тому же правилу, что значки запуска. */
  private readonly breakpointDecorations = new Map<string, string[]>();
  private readonly breakpointLines = new Map<string, readonly BreakpointInput[]>();
  /** Значки запуска отдельных тестов: строка → селектор pytest. */
  private readonly testDecorations = new Map<string, string[]>();
  private readonly testMarkers = new Map<string, readonly RunnableTest[]>();
  /** Подсветка строки, на которой стоит отладчик; null — отладка не стоит. */
  private debugLine: { path: string; line: number } | null = null;
  /** Украшения подсветки по файлам: перед новой отрисовкой их нужно снять. */
  private readonly debugDecorations = new Map<string, string[]>();
  /** Оценка выражения под курсором в остановленном файле; задаёт app (там контроллер отладки). */
  private debugHover: ((expression: string, at: DebugHoverPosition) => Promise<DebugHoverValue | null>) | null = null;
  /** Непокрытые строки по файлам из отчёта покрытия; пусто — покрытие не считали. */
  private readonly coverageLines = new Map<string, ReadonlySet<number>>();
  private readonly coverageDecorations = new Map<string, string[]>();
  private options: EditorOptions;
  private activePath: string | null = null;

  constructor(
    container: HTMLElement,
    private readonly documents: DocumentStore,
    options: EditorOptions,
    themeId: string,
  ) {
    // Обе схемы объявляем сразу: Monaco переключает их по имени, без пересоздания редактора.
    monaco.editor.defineTheme(MONACO_THEME_IDS.dark, MONACO_THEMES.dark);
    monaco.editor.defineTheme(MONACO_THEME_IDS.light, MONACO_THEMES.light);

    // Правила языков и подсказки Node регистрируются один раз на приложение.
    registerLanguageModes();
    applyTypeScriptDefaults({ showUnused: options.showUnused });
    this.options = options;
    this.theme = themeId;

    // Пометки меняет кто угодно: собственная проверка Monaco, языковой сервер и
    // проверка импортов. Ловим одно глобальное событие и отдаём наружу — по нему
    // статусбар пересчитывает счётчики, не зная ни про один из источников.
    monaco.editor.onDidChangeMarkers(() => this.markersEmitter.fire());

    // Модели общие на всё приложение: их отдают обе панели, и закрытие файла в
    // одной не должно уносить модель из другой — поэтому владеет ими реестр.
    this.files = new EditorModels(this.documents, () => ({
      languageIndent: this.options.languageIndent,
      tabSize: this.options.tabSize,
      insertSpaces: this.options.insertSpaces,
    }));

    // Зона редактора — ряд панелей. Пока панель одна, она занимает всю зону;
    // при разделении справа встаёт вторая, а между ними — разделитель (скрыт).
    this.panesHost = document.createElement('div');
    this.panesHost.className = 'editor-panes';
    this.splitter = document.createElement('div');
    this.splitter.className = 'editor-splitter';
    this.splitter.hidden = true;
    container.append(this.panesHost);
    this.createPane();
    this.panesHost.append(this.splitter);

    // Подсказка под курсором: значение выражения в контексте остановленного кадра.
    // Показываем в файле останова на любой строке, а не только на строке останова:
    // значение переменной видно и рядом с ней, как в VS Code. Где именно считать,
    // решает app — для строки чужого кадра оно возьмёт тот кадр; слово вне области
    // видимости просто не даст подсказки (ошибку прячет main).
    for (const language of DEBUG_HOVER_LANGUAGES) {
      monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position) => {
          const evaluate = this.debugHover;
          const current = this.debugLine;
          if (!evaluate || !current) return null;
          const uri = model.uri;
          if (uri.scheme !== 'file' || uriToPath(uri.path) !== current.path) return null;

          const word = model.getWordAtPosition(position);
          if (!word) return null;
          const result = await evaluate(word.word, { path: current.path, line: position.lineNumber });
          if (!result) return null;

          const type = result.type ? ` — \`${result.type}\`` : '';
          return {
            contents: [{ value: `\`${word.word}\` = ${result.value}${type}` }],
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          };
        },
      });
    }

    // Monaco считает ширину символа по фактическому шрифту, а файл шрифта
    // приходит асинхронно: до его загрузки строки измерены по запасному шрифту
    // и «плывут» при подмене. Просим шрифт явно и перемеряем после загрузки.
    void document.fonts.load('14px "JetBrains Mono"').then(() => monaco.editor.remeasureFonts());

    // Закрытие файла уносит его модель из реестра: снять нарисованное по ней —
    // наша забота, реестр о панелях ничего не знает.
    this.files.onDidDispose((path) => this.forgetPath(path));
    this.documents.onDidClose((document) => this.files.dispose(document.path));
  }

  /** Редактор активной панели: с ним работает всё, что требует «текущей» области. */
  private get editor(): monaco.editor.IStandaloneCodeEditor {
    return this.active.editor;
  }

  /** Панель, с которой сейчас работает человек: туда придёт следующий файл. */
  private get active(): EditorPane {
    return this.panes[this.activePane]!;
  }

  /** Разделена ли область редактора на две панели. */
  get isSplit(): boolean {
    return this.panes.length > 1;
  }

  /**
   * Разделить область редактора: справа появляется вторая панель с тем же файлом.
   * Модель у панелей общая (её держит реестр), поэтому правка видна в обеих; дальше
   * в панель можно открыть другой файл — она станет активной по клику.
   */
  splitEditor(): void {
    if (this.isSplit) return;
    const pane = this.createPane();
    const model = this.editor.getModel();
    if (model) pane.editor.setModel(model);
    pane.path = this.activePath;
    this.panesHost.classList.add('is-split');
    this.splitter.hidden = false;
    this.setActivePane(this.panes.length - 1);
    this.splitEmitter.fire(true);
    pane.editor.focus();
  }

  /** Убрать разделение: остаётся первая панель. Модели не трогаем — ими владеет реестр. */
  closeSplit(): void {
    if (!this.isSplit) return;
    const pane = this.panes.pop()!;
    pane.editor.dispose();
    pane.host.remove();
    this.panesHost.classList.remove('is-split');
    this.splitter.hidden = true;
    this.setActivePane(0);
    this.splitEmitter.fire(false);
    this.editor.focus();
  }

  /**
   * Создать панель: свою область Monaco и её реакции на ввод. Поведение панелей
   * одинаково, поэтому навеска одна; какая из них «активная» — решает фокус.
   */
  private createPane(): EditorPane {
    const host = document.createElement('div');
    host.className = 'editor-pane';
    const editor = monaco.editor.create(host, {
      theme: this.theme,
      automaticLayout: true,
      ...editorOptions(this.options),
      // Жёлоб шире обычного на ширину значка: там живёт кнопка запуска файла.
      glyphMargin: true,
      padding: { top: 12, bottom: 12 },
      fixedOverflowWidgets: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace',
    });

    const pane: EditorPane = { host, editor, path: null };
    const index = this.panes.length;

    // Клик по значку ▶ в жёлобе запускает файл: то же действие, что Shift+F10,
    // но в том месте, где человек видит точку входа.
    editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      const path = pane.path;
      if (!line || !path) return;

      // Правый клик — меню точки останова: условие и удаление. Оно доступно и там,
      // где точки ещё нет: «поставить условную» начинается так же, как обычная.
      if (event.event.rightButton) {
        this.breakpointMenuEmitter.fire({ path, line });
        return;
      }

      // Значки запуска и точка останова делят одно поле номеров строк. Порядок
      // важнее, чем кажется: у точки входа и у теста значки видны, а точку ставят
      // где угодно — поэтому она последняя.
      if (this.runLines.get(path)?.has(line)) {
        this.runMarkerEmitter.fire({ path, line });
        return;
      }
      const test = this.testMarkers.get(path)?.find((item) => item.line === line);
      if (test) {
        this.testMarkerEmitter.fire({ path, line, selector: test.selector, name: test.name });
        return;
      }
      this.breakpointEmitter.fire({ path, line });
    });

    // Курсор в статус-бар отдаёт только активная панель: у второй он не «текущий».
    editor.onDidChangeCursorPosition((event) => {
      if (this.activePane !== index) return;
      this.cursorEmitter.fire({
        path: this.activePath,
        line: event.position.lineNumber,
        column: event.position.column,
        selections: editor.getSelections()?.length ?? 0,
      });
    });

    // Фокус решает, куда придёт следующий файл и куда смотрит статус-бар.
    editor.onDidFocusEditorText(() => this.setActivePane(index));

    this.panes.push(pane);
    this.panesHost.append(host);
    if (index === 0) host.classList.add('is-active');
    return pane;
  }

  /** Активной панели — отметка: с двумя областями иначе не видно, где стоит курсор. */
  private setActivePane(index: number): void {
    this.activePane = index;
    this.activePath = this.panes[index]?.path ?? null;
    for (const [i, pane] of this.panes.entries()) pane.host.classList.toggle('is-active', i === index);
    this.emitCursor();
  }

  /**
   * Направить F1 в редакторе на нашу палитру. Своя палитра у Monaco ни к чему:
   * в одном окне получаются две палитры с разными списками и разной плотностью
   * строк, и какую откроет F1 — непредсказуемо для пользователя. Динамическая
   * привязка перекрывает встроенную (`editor.action.quickCommand`).
   */
  openPaletteOnF1(open: () => void): void {
    monaco.editor.addCommand({ id: 'chui.palette.open', run: () => open() });
    monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: 'chui.palette.open' });
  }

  get currentPath(): string | null {
    return this.activePath;
  }

  open(document: TextDocument): void {
    const pane = this.active;
    if (pane.path && pane.path !== document.path) {
      this.viewStates.set(pane.path, pane.editor.saveViewState());
    }

    const model = this.files.resolve(document);
    pane.editor.setModel(model);
    const state = this.viewStates.get(document.path);
    if (state) pane.editor.restoreViewState(state);
    pane.path = document.path;
    this.activePath = document.path;
    // Модель появилась позже, чем узнали о точке входа — дорисовываем значок.
    this.drawRunMarkers(document.path);
    // Модель появилась позже, чем узнали о точках останова, — дорисовываем и их.
    this.drawBreakpoints(document.path);
    // И значки тестов: их считает панель по тексту файла.
    this.drawTestMarkers(document.path);
    // И подсветку непокрытых строк: отчёт покрытия мог прийти раньше файла.
    this.drawCoverage(document.path);
    this.drawDebugLine();
    this.editor.focus();
    this.emitCursor();
  }

  /**
   * Проталкивает те же правки, что уже применены к документу, в модель Monaco.
   * Правки идут через pushEditOperations, поэтому Ctrl+Z отменяет и правку
   * ассистента тоже — без отдельного undo-стека.
   */
  applyEdits(document: TextDocument, edits: readonly TextEdit[]): void {
    this.files.applyEdits(document, edits);
  }

  reveal(path: string, line: number, column: number): void {
    const model = this.files.get(path);
    if (!model) return;
    if (this.editor.getModel() !== model) this.editor.setModel(model);
    const position = { lineNumber: line, column };
    this.editor.setPosition(position);
    this.editor.revealPositionInCenterIfOutsideViewport(position);
    this.editor.focus();
    this.emitCursor();
  }

  selectedText(): string {
    const model = this.editor.getModel();
    const selection = this.editor.getSelection();
    if (!model || !selection || selection.isEmpty()) return '';
    return model.getValueInRange(selection);
  }

  /**
   * Вставка текста в позицию курсора. Идёт через `executeEdits`, поэтому
   * изменение подхватывает документ — тот же путь, что и обычный ввод.
   */
  insertAtCursor(text: string): boolean {
    const selection = this.editor.getSelection();
    if (!this.editor.getModel() || !selection) return false;
    this.editor.executeEdits('assistant', [{ range: selection, text, forceMoveMarkers: true }]);
    this.editor.focus();
    return true;
  }

  /**
   * Пометки языка — то, что редактор и так подчёркивает. Агенту они нужны
   * текстом, поэтому отдаём их тем же списком, что и инструмент get_diagnostics.
   */
  markers(path?: string): DiagnosticItem[] {
    const items: DiagnosticItem[] = [];

    for (const [filePath, model] of this.files.entries()) {
      if (path && filePath !== path) continue;
      for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
        items.push({
          path: filePath,
          line: marker.startLineNumber,
          column: marker.startColumn,
          severity:
            marker.severity >= monaco.MarkerSeverity.Error
              ? 'error'
              : marker.severity >= monaco.MarkerSeverity.Warning
                ? 'warning'
                : 'info',
          message: marker.message,
          source: marker.source ?? '',
        });
      }
    }

    return items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  }

  /**
   * Перейти к первой пометке активного файла. Действие берём у Monaco, а не
   * ищем строку пометки сами: он же подсвечивает её и открывает файл, где нужно.
   */
  revealNextProblem(): void {
    const editor = this.panes[this.activePane]?.editor;
    void editor?.getAction('editor.action.marker.nextInFiles')?.run();
  }

  /**
   * Сколько пометок «ошибка» и «предупреждение» в открытых файлах — для статусбара.
   * Считаем тем же способом, что и `markers`, поэтому число в полосе и список,
   * который видит агент, всегда про одни и те же пометки.
   */
  problemCounts(): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;

    for (const [, model] of this.files.entries()) {
      for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
        if (marker.severity >= monaco.MarkerSeverity.Error) errors += 1;
        else if (marker.severity >= monaco.MarkerSeverity.Warning) warnings += 1;
      }
    }

    return { errors, warnings };
  }

  /**
   * Пометки из внешнего источника (LSP). Кладём их в Monaco под своим `owner`,
   * поэтому они живут рядом с собственными пометками и не затирают друг друга:
   * `getModelMarkers` (а значит и агент) видит и те, и другие.
   */
  setExternalMarkers(path: string, owner: string, diagnostics: readonly LspDiagnostic[]): void {
    const model = this.files.get(path);
    if (!model) return;

    const severity = (value: LspDiagnostic['severity']): monaco.MarkerSeverity =>
      value === 'error'
        ? monaco.MarkerSeverity.Error
        : value === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info;

    monaco.editor.setModelMarkers(
      model,
      owner,
      diagnostics.map((item) => ({
        severity: severity(item.severity),
        message: item.source ? `${item.message} (${item.source})` : item.message,
        startLineNumber: item.line,
        startColumn: item.column,
        endLineNumber: Math.max(item.endLine, item.line),
        endColumn: item.endLine === item.line ? Math.max(item.endColumn, item.column) : item.endColumn,
      })),
    );
  }

  applyOptions(options: EditorOptions): void {
    const wasShowUnused = this.options.showUnused;
    this.options = options;
    // Настройки — общие для всех панелей: вторая не должна жить со старым кеглем.
    for (const pane of this.panes) pane.editor.updateOptions(editorOptions(options));

    if (wasShowUnused !== options.showUnused) applyTypeScriptDefaults({ showUnused: options.showUnused });

    // Отступы задаются модели, а не редактору: у Python и Makefile они свои,
    // поэтому при смене настройки переписываем их всем открытым файлам.
    this.files.refreshIndent();
  }

  /**
   * Значки запуска на поле номеров строк: `lines` — строки, с которых начинается
   * выполнение файла (`if __name__ == "__main__"` и подобные). Пустой список
   * убирает значки — файл больше не считаем запускаемым.
   */
  setRunLines(path: string, lines: readonly number[]): void {
    // Запоминаем желаемое состояние независимо от модели: документ открывается
    // раньше, чем Monaco создаёт модель, и рисовать в этот момент некуда.
    if (lines.length === 0) this.runLines.delete(path);
    else this.runLines.set(path, new Set(lines));
    this.drawRunMarkers(path);
  }

  /**
   * Значки запуска отдельных тестов: у каждой строки `def test_…` — свой ▶.
   * Клик запускает именно этот тест, а не весь файл.
   */
  setTestMarkers(path: string, tests: readonly RunnableTest[]): void {
    if (tests.length === 0) this.testMarkers.delete(path);
    else this.testMarkers.set(path, tests);
    this.drawTestMarkers(path);
  }

  private drawTestMarkers(path: string): void {
    const model = this.files.get(path);
    if (!model) return;

    const previous = this.testDecorations.get(path) ?? [];
    const tests = this.testMarkers.get(path) ?? [];
    if (tests.length === 0) {
      this.testDecorations.delete(path);
      if (previous.length > 0) model.deltaDecorations(previous, []);
      return;
    }

    const next = model.deltaDecorations(
      previous,
      tests.map((test) => ({
        range: new monaco.Range(test.line, 1, test.line, 1),
        options: {
          glyphMarginClassName: 'run-glyph test-glyph',
          glyphMarginHoverMessage: { value: `Запустить тест ${test.name}` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    this.testDecorations.set(path, next);
  }

  /** Нарисовать значки запуска по запомненным строкам. Без модели — нечего рисовать. */
  private drawRunMarkers(path: string): void {
    const model = this.files.get(path);
    if (!model) return;

    const previous = this.runDecorations.get(path) ?? [];
    const lines = [...(this.runLines.get(path) ?? [])];
    if (lines.length === 0) {
      this.runDecorations.delete(path);
      if (previous.length > 0) model.deltaDecorations(previous, []);
      return;
    }

    const next = model.deltaDecorations(
      previous,
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'run-glyph',
          glyphMarginHoverMessage: { value: 'Запустить файл' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    this.runDecorations.set(path, next);
  }

  /**
   * Точки останова файла: строка и, если задано, условие останова. Точка рисуется
   * красным кружком на поле номеров строк; условная — ромбом и с условием в подсказке,
   * чтобы её не путали с безусловной.
   */
  setBreakpoints(path: string, breakpoints: readonly BreakpointInput[]): void {
    if (breakpoints.length === 0) this.breakpointLines.delete(path);
    else this.breakpointLines.set(path, breakpoints);
    this.drawBreakpoints(path);
  }

  private drawBreakpoints(path: string): void {
    const model = this.files.get(path);
    if (!model) return;

    const previous = this.breakpointDecorations.get(path) ?? [];
    const breakpoints = this.breakpointLines.get(path) ?? [];
    if (breakpoints.length === 0) {
      this.breakpointDecorations.delete(path);
      if (previous.length > 0) model.deltaDecorations(previous, []);
      return;
    }

    const next = model.deltaDecorations(
      previous,
      breakpoints.map((item) => ({
        range: new monaco.Range(item.line, 1, item.line, 1),
        options: {
          glyphMarginClassName: breakpointGlyphClass(item),
          glyphMarginHoverMessage: { value: breakpointTooltip(item) },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    this.breakpointDecorations.set(path, next);
  }

  /** Красная линия на строке, где стоит отладчик. `null` — подсветку убрать. */
  setDebugLine(path: string | null, line: number | null): void {
    this.debugLine = path && line ? { path, line } : null;
    this.drawDebugLine();
  }

  /**
   * Подключить оценку выражений для подсказки под курсором. Отдельным швом,
   * потому что контроллер отладки живёт в app, а редактор о нём знать не должен.
   * Позицию передаём: app по ней выбирает кадр, в котором считать выражение.
   */
  setDebugHover(evaluate: (expression: string, at: DebugHoverPosition) => Promise<DebugHoverValue | null>): void {
    this.debugHover = evaluate;
  }

  /**
   * Непокрытые строки файлов из отчёта покрытия: подсвечиваем приглушённым фоном,
   * чтобы видеть, что тесты не исполнили. Набор заменяется целиком (как и у точек
   * останова): прогон считается по всем файлам сразу, и старую подсветку надо снять.
   */
  setCoverage(files: Iterable<readonly [string, readonly number[]]>): void {
    const affected = new Set(this.coverageLines.keys());
    this.coverageLines.clear();
    for (const [path, lines] of files) {
      if (lines.length === 0) continue;
      this.coverageLines.set(path, new Set(lines));
      affected.add(path);
    }
    for (const path of affected) this.drawCoverage(path);
  }

  private drawCoverage(path: string): void {
    const model = this.files.get(path);
    const previous = this.coverageDecorations.get(path) ?? [];
    // Модели нет — файл не открыт; при открытии подсветку нарисует `open`.
    if (!model) return;

    const lines = this.coverageLines.get(path);
    if (!lines || lines.size === 0) {
      this.coverageDecorations.delete(path);
      if (previous.length > 0) model.deltaDecorations(previous, []);
      return;
    }

    const next = model.deltaDecorations(
      previous,
      [...lines].map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'coverage-line',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
    this.coverageDecorations.set(path, next);
  }

  private drawDebugLine(): void {
    // Снимаем прежнюю подсветку с той модели, где она была.
    for (const [path, ids] of this.debugDecorations) {
      const model = this.files.get(path);
      if (ids.length > 0) model?.deltaDecorations(ids, []);
    }
    this.debugDecorations.clear();

    const current = this.debugLine;
    if (!current) return;
    const model = this.files.get(current.path);
    if (!model) return;
    this.debugDecorations.set(
      current.path,
      model.deltaDecorations(
        [],
        [
          {
            range: new monaco.Range(current.line, 1, current.line, 1),
            options: {
              isWholeLine: true,
              className: 'debug-line',
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ],
      ),
    );
  }

  /** Прокрутить к кадру останова и поставить курсор: панель кликает по стеку. */
  revealDebugFrame(path: string, line: number, column = 1): void {
    const model = this.files.get(path);
    if (!model) return;
    const position = new monaco.Position(line, column);
    this.editor.setPosition(position);
    this.editor.revealPositionInCenterIfOutsideViewport(position);
  }

  /** Переключение схемы: Monaco меняет тему целиком, пересоздавать редактор не нужно. */
  setTheme(scheme: Scheme): void {
    monaco.editor.setTheme(MONACO_THEME_IDS[scheme]);
  }

  /**
   * Сравнение двух версий файла. UI передаёт тексты и не знает про Monaco;
   * тема берётся глобальная, поэтому сравнение следует за схемой приложения.
   */
  createDiff(container: HTMLElement): DiffEditorHandle {
    const editor = monaco.editor.createDiffEditor(container, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      originalEditable: false,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace',
      padding: { top: 12, bottom: 12 },
    });

    let owned: monaco.editor.ITextModel[] = [];
    return {
      set({ language, original, modified }) {
        const next = [monaco.editor.createModel(original, language), monaco.editor.createModel(modified, language)];
        editor.setModel({ original: next[0]!, modified: next[1]! });
        for (const model of owned) model.dispose();
        owned = next;
      },
      dispose() {
        editor.dispose();
        for (const model of owned) model.dispose();
        owned = [];
      },
    };
  }

  /**
   * Файл закрыт: реестр уже утилизировал модель и позвал сюда. Всё, что было по
   * ней нарисовано, живёт вместе с ней — иначе при повторном открытии файла в
   * `deltaDecorations` уходили бы id уже удалённой модели.
   */
  private forgetPath(path: string): void {
    for (const pane of this.panes) {
      if (pane.path !== path) continue;
      pane.editor.setModel(null);
      pane.path = null;
    }
    if (this.activePath === path) this.activePath = null;
    this.viewStates.delete(path);
    this.runDecorations.delete(path);
    this.runLines.delete(path);
    // Карты украшений точек останова и подсветки отладки тоже живут с моделью:
    // без очистки в них остаются id удалённых моделей — Monaco их молча
    // игнорирует, но карты копят ссылки на модели, которых уже нет.
    this.breakpointDecorations.delete(path);
    this.testDecorations.delete(path);
    this.testMarkers.delete(path);
    this.debugDecorations.delete(path);
    // Подсветка покрытия тоже рисуется по модели: id удалённой модели в карте
    // копились бы, а сама подсветка — нет. Записи о непокрытых строках держим:
    // файл откроют снова, и строки нужно нарисовать снова.
    this.coverageDecorations.delete(path);
    if (this.debugLine?.path === path) this.debugLine = null;
  }

  /** Позиция курсора прямо сейчас: нужна команде «точка останова на строке». */
  cursor(): { line: number; column: number } {
    const position = this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
    return { line: position.lineNumber, column: position.column };
  }

  private emitCursor(): void {
    const position = this.editor.getPosition() ?? { lineNumber: 1, column: 1 };
    this.cursorEmitter.fire({
      path: this.activePath,
      line: position.lineNumber,
      column: position.column,
      selections: this.editor.getSelections()?.length ?? 0,
    });
  }
}

/**
 * Класс значка точки: обычная — кружок, условная — ромб, точка в журнал —
 * ромб с «журнальным» цветом. Видно с одного взгляда, без наведения.
 */
function breakpointGlyphClass(item: BreakpointInput): string {
  if (item.logMessage) return 'breakpoint-glyph is-log';
  if (item.condition || item.hitCondition) return 'breakpoint-glyph is-conditional';
  return 'breakpoint-glyph';
}

/** Подсказка точки: все её настройки в одном месте. */
function breakpointTooltip(item: BreakpointInput): string {
  if (item.logMessage) return `Точка в журнал: ${item.logMessage}`;
  const parts: string[] = [];
  if (item.condition) parts.push(`условие: ${item.condition}`);
  if (item.hitCondition) parts.push(`попаданий: ${item.hitCondition}`);
  return parts.length > 0 ? `Точка останова (${parts.join(', ')})` : 'Точка останова';
}

/**
 * Настройки редактора → параметры Monaco.
 *
 * Одна функция на создание и на обновление: два списка параметров неизбежно
 * расходятся, и половина настроек перестаёт применяться без перезапуска.
 * Отступы здесь не задаются — они свойство модели, а не редактора.
 */
function editorOptions(options: EditorOptions): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    fontSize: options.fontSize,
    wordWrap: options.wordWrap ? 'on' : 'off',
    minimap: { enabled: options.minimap },
    fontLigatures: options.fontLigatures,
    renderWhitespace: options.renderWhitespace,
    cursorBlinking: options.cursorBlinking,
    smoothScrolling: options.smoothScrolling,
    scrollBeyondLastLine: options.scrollBeyondLastLine,
    lineNumbers: options.lineNumbers,
    renderLineHighlight: options.renderLineHighlight,
    bracketPairColorization: { enabled: options.bracketPairColorization },
    stickyScroll: { enabled: options.stickyScroll },
    quickSuggestions: options.quickSuggestions,
    // Без отступа-сетки Monaco рисует табуляцию своей шириной, и файлы с табом «плывут».
    detectIndentation: false,
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
  };
}
