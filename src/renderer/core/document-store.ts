import { TextDocument, type DocumentChange } from './document';
import { Emitter } from './events';
import { languageFromPath } from './languages';

export interface DocumentChangeEvent {
  document: TextDocument;
  change: DocumentChange;
}

/**
 * Все открытые документы. Ничего не грузит с диска сам — этим занимается
 * EditService, поэтому store легко тестируется и не зависит от IPC.
 */
export class DocumentStore {
  private readonly documents = new Map<string, TextDocument>();

  private readonly openEmitter = new Emitter<TextDocument>();
  private readonly closeEmitter = new Emitter<TextDocument>();
  private readonly changeEmitter = new Emitter<DocumentChangeEvent>();
  private readonly savedEmitter = new Emitter<TextDocument>();

  readonly onDidOpen = this.openEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  readonly onDidChange = this.changeEmitter.event;
  /**
   * «Не сохранён» появился или снят. Отдельно от `onDidChange`: при сохранении
   * текст тот же, а пометка в интерфейсе (вкладка, точка в дереве) обязана
   * погаснуть сразу, а не по событию наблюдателя за файлом.
   */
  readonly onDidChangeDirty = this.savedEmitter.event;

  open(path: string, text: string, options: { languageId?: string; readOnly?: boolean } = {}): TextDocument {
    const existing = this.documents.get(path);
    if (existing) return existing;

    const document = new TextDocument(
      path,
      text,
      options.languageId ?? languageFromPath(path),
      options.readOnly === true,
    );
    document.onDidChange((change) => this.changeEmitter.fire({ document, change }));
    document.onDidChangeSaved(() => this.savedEmitter.fire(document));
    this.documents.set(path, document);
    this.openEmitter.fire(document);
    return document;
  }

  get(path: string): TextDocument | undefined {
    return this.documents.get(path);
  }

  all(): TextDocument[] {
    return [...this.documents.values()];
  }

  dirty(): TextDocument[] {
    return this.all().filter((document) => document.dirty);
  }

  close(path: string): void {
    const document = this.documents.get(path);
    if (!document) return;
    this.documents.delete(path);
    this.closeEmitter.fire(document);
  }
}
