import * as monaco from 'monaco-editor';
import type { DiagnosticItem, EditorSettings, LspDiagnostic } from '../../shared/api';
import type { TextEdit } from '../../shared/edits';
import './monaco-env';
import type { TextDocument } from './document';
import type { DocumentStore } from './document-store';
import { Emitter } from './events';
import { applyTypeScriptDefaults, registerLanguageModes } from './language-modes';
import { languageIndent } from './languages';
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

/** Управление одним экраном сравнения; модели Monaco живут внутри сервиса. */
export interface DiffEditorHandle {
  set(input: { language: string; original: string; modified: string }): void;
  dispose(): void;
}

/**
 * Единственное место, где renderer знает про Monaco.
 *
 * Правило одного писателя: пользователь печатает → модель Monaco сообщает
 * документу; правки приходят программно → документ сообщает модели. Флаг
 * `applying` не даёт этим двум потокам зациклиться друг на друге.
 */
export class EditorService {
  readonly editor: monaco.editor.IStandaloneCodeEditor;

  private readonly cursorEmitter = new Emitter<CursorState>();
  readonly onCursorChange = this.cursorEmitter.event;

  /** Просьба запустить файл со значка в жёлобе. */
  private readonly runMarkerEmitter = new Emitter<RunMarkerHit>();
  readonly onRunMarker = this.runMarkerEmitter.event;

  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  /** Значки запуска по файлам: нарисованные украшения нужно убирать перед новой отрисовкой. */
  private readonly runDecorations = new Map<string, string[]>();
  private readonly runLines = new Map<string, ReadonlySet<number>>();
  private options: EditorOptions;
  private applying = false;
  private activePath: string | null = null;

  constructor(container: HTMLElement, private readonly documents: DocumentStore, options: EditorOptions, themeId: string) {
    // Обе схемы объявляем сразу: Monaco переключает их по имени, без пересоздания редактора.
    monaco.editor.defineTheme(MONACO_THEME_IDS.dark, MONACO_THEMES.dark);
    monaco.editor.defineTheme(MONACO_THEME_IDS.light, MONACO_THEMES.light);

    // Правила языков и подсказки Node регистрируются один раз на приложение.
    registerLanguageModes();
    applyTypeScriptDefaults({ showUnused: options.showUnused });
    this.options = options;

    this.editor = monaco.editor.create(container, {
      theme: themeId,
      automaticLayout: true,
      ...editorOptions(options),
      // Жёлоб шире обычного на ширину значка: там живёт кнопка запуска файла.
      glyphMargin: true,
      padding: { top: 12, bottom: 12 },
      fixedOverflowWidgets: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace',
    });

    // Клик по значку ▶ в жёлобе запускает файл: то же действие, что Shift+F10,
    // но в том месте, где человек видит точку входа.
    this.editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = event.target.position?.lineNumber;
      const path = this.activePath;
      if (!line || !path) return;
      if (!this.runLines.get(path)?.has(line)) return;
      this.runMarkerEmitter.fire({ path, line });
    });

    // Monaco считает ширину символа по фактическому шрифту, а файл шрифта
    // приходит асинхронно: до его загрузки строки измерены по запасному шрифту
    // и «плывут» при подмене. Просим шрифт явно и перемеряем после загрузки.
    void document.fonts.load('14px "JetBrains Mono"').then(() => monaco.editor.remeasureFonts());

    this.editor.onDidChangeCursorPosition((event) => {
      this.cursorEmitter.fire({
        path: this.activePath,
        line: event.position.lineNumber,
        column: event.position.column,
        selections: this.editor.getSelections()?.length ?? 0,
      });
    });

    // Изменения с диска приходят уже после того, как кто-то перечитал файл:
    // здесь допустима полная замена текста модели.
    this.documents.onDidChange(({ document, change }) => {
      if (change.source !== 'disk') return;
      const model = this.models.get(document.path);
      if (!model || model.getValue() === document.value) return;
      this.withApplying(() => model.setValue(document.value));
    });

    this.documents.onDidClose((document) => this.disposeModel(document.path));
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
    if (this.activePath && this.activePath !== document.path) {
      this.viewStates.set(this.activePath, this.editor.saveViewState());
    }

    const model = this.modelFor(document);
    this.editor.setModel(model);
    const state = this.viewStates.get(document.path);
    if (state) this.editor.restoreViewState(state);
    this.activePath = document.path;
    // Модель появилась позже, чем узнали о точке входа — дорисовываем значок.
    this.drawRunMarkers(document.path);
    this.editor.focus();
    this.emitCursor();
  }

  /**
   * Проталкивает те же правки, что уже применены к документу, в модель Monaco.
   * Правки идут через pushEditOperations, поэтому Ctrl+Z отменяет и правку
   * ассистента тоже — без отдельного undo-стека.
   */
  applyEdits(document: TextDocument, edits: readonly TextEdit[]): void {
    const model = this.models.get(document.path);
    if (!model || edits.length === 0) return;
    this.withApplying(() => {
      model.pushEditOperations(
        null,
        edits.map((edit) => ({
          range: new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn),
          text: edit.newText,
          forceMoveMarkers: true,
        })),
        () => null,
      );
    });
  }

  reveal(path: string, line: number, column: number): void {
    const model = this.models.get(path);
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

    for (const [filePath, model] of this.models) {
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
   * Пометки из внешнего источника (LSP). Кладём их в Monaco под своим `owner`,
   * поэтому они живут рядом с собственными пометками и не затирают друг друга:
   * `getModelMarkers` (а значит и агент) видит и те, и другие.
   */
  setExternalMarkers(path: string, owner: string, diagnostics: readonly LspDiagnostic[]): void {
    const model = this.models.get(path);
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
    this.editor.updateOptions(editorOptions(options));

    if (wasShowUnused !== options.showUnused) applyTypeScriptDefaults({ showUnused: options.showUnused });

    // Отступы задаются модели, а не редактору: у Python и Makefile они свои,
    // поэтому при смене настройки переписываем их всем открытым файлам.
    for (const model of this.models.values()) this.applyIndent(model);
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

  /** Нарисовать значки запуска по запомненным строкам. Без модели — нечего рисовать. */
  private drawRunMarkers(path: string): void {
    const model = this.models.get(path);
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
   * Отступ документа: у языка свои значения (Python — 4 пробела, Makefile — таб),
   * но только если пользователь оставил это на усмотрение языка.
   */
  private applyIndent(model: monaco.editor.ITextModel): void {
    const perLanguage = this.options.languageIndent ? languageIndent(model.getLanguageId()) : null;
    model.updateOptions({
      tabSize: perLanguage?.tabSize ?? this.options.tabSize,
      insertSpaces: perLanguage?.insertSpaces ?? this.options.insertSpaces,
    });
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
        const next = [
          monaco.editor.createModel(original, language),
          monaco.editor.createModel(modified, language),
        ];
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

  private modelFor(document: TextDocument): monaco.editor.ITextModel {
    let model = this.models.get(document.path);
    if (model) {
      if (model.getValue() !== document.value) this.withApplying(() => model!.setValue(document.value));
      return model;
    }

    const created = monaco.editor.createModel(document.value, document.languageId, monaco.Uri.parse(document.uri));
    created.onDidChangeContent(() => {
      if (this.applying) return;
      const current = this.documents.get(document.path);
      if (current) current.setText(created.getValue(), 'user');
    });
    this.applyIndent(created);

    this.models.set(document.path, created);
    model = created;
    return model;
  }

  private disposeModel(path: string): void {
    const model = this.models.get(path);
    if (!model) return;
    if (this.activePath === path) {
      this.activePath = null;
      this.editor.setModel(null);
    }
    this.viewStates.delete(path);
    this.runDecorations.delete(path);
    this.runLines.delete(path);
    model.dispose();
    this.models.delete(path);
  }

  private withApplying(action: () => void): void {
    const previous = this.applying;
    this.applying = true;
    try {
      action();
    } finally {
      this.applying = previous;
    }
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
