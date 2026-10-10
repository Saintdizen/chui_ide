import * as monaco from 'monaco-editor';
import type { TextEdit } from '../../shared/edits';
import type { TextDocument } from './document';
import type { DocumentStore } from './document-store';
import { Emitter } from './events';
import { languageIndent } from './languages';

/** Как расставлять отступы: настройка пользователя плюс язык конкретного файла. */
export interface IndentSettings {
  /** Оставлять отступы на усмотрение языка (Python — 4 пробела, Makefile — таб). */
  languageIndent: boolean;
  tabSize: number;
  insertSpaces: boolean;
}

/**
 * Реестр моделей Monaco — один на приложение, а не на редактор.
 *
 * Модель в Monaco привязана к URI: два редактора, открывшие один файл, не могут
 * создать две модели с одним URI (Monaco бросит «model already exists»), и закрытие
 * файла в одном не должно уносить модель из другого. Поэтому владение моделями
 * вынесено сюда: редактор арендует модель у реестра, а сколько редакторов на неё
 * смотрят — забота вызывающей стороны.
 *
 * Здесь же живёт единственный «писатель» со стороны Monaco: правка пользователя
 * из модели уходит в документ. Флаг `applying` отделяет её от программных правок,
 * иначе эти два потока зациклились бы друг на друге.
 */
export class EditorModels {
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private applying = false;

  private readonly disposeEmitter = new Emitter<string>();
  /** Модель файла утилизирована: слушатели снимают то, что рисовали по ней. */
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    private readonly documents: DocumentStore,
    private readonly indent: () => IndentSettings,
  ) {
    // Изменения с диска приходят уже после того, как кто-то перечитал файл:
    // здесь допустима полная замена текста модели.
    this.documents.onDidChange(({ document, change }) => {
      if (change.source !== 'disk') return;
      const model = this.models.get(document.path);
      if (!model || model.getValue() === document.value) return;
      this.withApplying(() => model.setValue(document.value));
    });
  }

  get(path: string): monaco.editor.ITextModel | undefined {
    return this.models.get(path);
  }

  entries(): IterableIterator<[string, monaco.editor.ITextModel]> {
    return this.models.entries();
  }

  /** Модель документа: существующая либо созданная. Тексты при расхождении синхронизируются. */
  resolve(document: TextDocument): monaco.editor.ITextModel {
    const existing = this.models.get(document.path);
    if (existing) {
      if (existing.getValue() !== document.value) this.withApplying(() => existing.setValue(document.value));
      return existing;
    }

    const created = monaco.editor.createModel(document.value, document.languageId, monaco.Uri.parse(document.uri));
    created.onDidChangeContent(() => {
      if (this.applying) return;
      const current = this.documents.get(document.path);
      if (current) current.setText(created.getValue(), 'user');
    });
    this.applyIndent(created);

    this.models.set(document.path, created);
    return created;
  }

  /**
   * Правки программного источника идут через `pushEditOperations`: они попадают
   * в undo-стек Monaco, поэтому Ctrl+Z отменяет и правку ассистента тоже.
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

  /** Перечитать настройки отступов: их задают модели, а не редактору (см. `applyIndent`). */
  refreshIndent(): void {
    for (const model of this.models.values()) this.applyIndent(model);
  }

  /** Утилизировать модель файла. Слушатели `onDidDispose` снимут своё по этому пути. */
  dispose(path: string): void {
    const model = this.models.get(path);
    if (!model) return;
    model.dispose();
    this.models.delete(path);
    this.disposeEmitter.fire(path);
  }

  /**
   * Отступ документа: у языка свои значения, но только если пользователь оставил
   * это на усмотрение языка. Отступы свойство модели, поэтому переписываются ей.
   */
  private applyIndent(model: monaco.editor.ITextModel): void {
    const settings = this.indent();
    const perLanguage = settings.languageIndent ? languageIndent(model.getLanguageId()) : null;
    model.updateOptions({
      tabSize: perLanguage?.tabSize ?? settings.tabSize,
      insertSpaces: perLanguage?.insertSpaces ?? settings.insertSpaces,
    });
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
}
