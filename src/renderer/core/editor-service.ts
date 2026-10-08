import * as monaco from 'monaco-editor';
import type { TextEdit } from '../../shared/edits';
import './monaco-env';
import type { TextDocument } from './document';
import type { DocumentStore } from './document-store';
import { Emitter } from './events';
import { MONACO_THEMES, MONACO_THEME_IDS, type Scheme } from './theme';

export interface EditorOptions {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
}

export interface CursorState {
  path: string | null;
  line: number;
  column: number;
  selections: number;
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

  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
  private applying = false;
  private activePath: string | null = null;

  constructor(container: HTMLElement, private readonly documents: DocumentStore, options: EditorOptions, themeId: string) {
    // Обе схемы объявляем сразу: Monaco переключает их по имени, без пересоздания редактора.
    monaco.editor.defineTheme(MONACO_THEME_IDS.dark, MONACO_THEMES.dark);
    monaco.editor.defineTheme(MONACO_THEME_IDS.light, MONACO_THEMES.light);

    this.editor = monaco.editor.create(container, {
      theme: themeId,
      automaticLayout: true,
      fontSize: options.fontSize,
      tabSize: options.tabSize,
      wordWrap: options.wordWrap ? 'on' : 'off',
      minimap: { enabled: options.minimap },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      fontLigatures: true,
      cursorBlinking: 'smooth',
      smoothScrolling: true,
      padding: { top: 12, bottom: 12 },
      fixedOverflowWidgets: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace',
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

  applyOptions(options: EditorOptions): void {
    this.editor.updateOptions({
      fontSize: options.fontSize,
      tabSize: options.tabSize,
      wordWrap: options.wordWrap ? 'on' : 'off',
      minimap: { enabled: options.minimap },
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
