import type { ApplyFailure, ApplyReport, ApplyResult, FileEdit } from '../../shared/edits';
import type { TextDocument } from './document';
import type { DocumentStore } from './document-store';
import type { EditSource } from './document';
import type { EditorService } from './editor-service';
import type { RpcClient } from './rpc';

export interface EditServiceDeps {
  documents: DocumentStore;
  editors: EditorService;
  rpc: RpcClient;
}

/**
 * Точка входа для любых программных правок: и для reload с диска, и для
 * ассистента. Документ обновляется первым, затем Monaco — это гарантирует,
 * что версия документа всегда опережает то, что видно на экране.
 */
export class EditService {
  constructor(private readonly deps: EditServiceDeps) {}

  /** Открывает документ, подгружая текст с диска при необходимости. */
  async ensureDocument(path: string): Promise<TextDocument> {
    const existing = this.deps.documents.get(path);
    if (existing) return existing;

    const file = await this.deps.rpc.request('workspace.readFile', { path });
    return this.deps.documents.open(path, file.text);
  }

  async applyFileEdits(fileEdits: readonly FileEdit[], source: EditSource = 'programmatic'): Promise<ApplyResult> {
    const reports: ApplyReport[] = [];
    const failed: ApplyFailure[] = [];

    for (const file of fileEdits) {
      try {
        const document = await this.ensureDocument(file.path);
        if (file.expectedVersion !== undefined && file.expectedVersion !== document.version) {
          throw new Error(`Версия документа устарела: ожидалась ${file.expectedVersion}, текущая ${document.version}`);
        }

        const applied = document.applyEdits(file.edits, source);
        if (applied === 0) {
          // Разбор прошёл, но текст не изменился: позиции указывают не туда.
          // «применено 0» без объяснения модель читает как успех и повторяет ошибку.
          throw new Error(
            'правки не изменили документ: позиции не совпали с содержимым файла — перечитай файл и повтори',
          );
        }
        this.deps.editors.applyEdits(document, file.edits);
        reports.push({ path: file.path, applied, version: document.version });
      } catch (error) {
        failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return { reports, failed };
  }

  /** Перечитывает файл с диска. Несохранённые изменения не перетираются. */
  async reloadFromDisk(path: string): Promise<TextDocument> {
    const document = this.deps.documents.get(path);
    if (document?.dirty) return document;

    const file = await this.deps.rpc.request('workspace.readFile', { path });
    const target = document ?? this.deps.documents.open(path, file.text);
    target.setText(file.text, 'disk');
    return target;
  }
}
