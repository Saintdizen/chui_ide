import type { ApplyFailure, ApplyReport, ApplyResult, FileEdit } from '../../shared/edits';
import { diskConflict, type TextDocument } from './document';
import type { DocumentStore } from './document-store';
import type { EditSource } from './document';
import type { EditorApi } from './editor-api';
import type { RpcClient } from './rpc';

export interface EditServiceDeps {
  documents: DocumentStore;
  editors: EditorApi;
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
    const document = this.deps.documents.open(path, file.text);
    document.markDisk(file.mtimeMs);
    return document;
  }

  /**
   * Записать документ на диск. Перед записью сверяем время файла: если он
   * изменился снаружи после нашего чтения, писать буфер нельзя — иначе молча
   * перетрём чужую правку (ассистента, из терминала, другим инструментом).
   * Решение принимает вызывающий: `force` — человек уже подтвердил перезапись.
   */
  async saveDocument(document: TextDocument, options: { force?: boolean } = {}): Promise<'saved' | 'conflict'> {
    if (!options.force) {
      const stat = await this.deps.rpc.request('workspace.stat', { path: document.path }).catch(() => null);
      if (diskConflict(document.diskMtime, stat?.mtimeMs ?? null)) return 'conflict';
    }
    const { mtimeMs } = await this.deps.rpc.request('workspace.writeFile', {
      path: document.path,
      text: document.value,
    });
    document.markSaved(mtimeMs);
    return 'saved';
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
    // Перечитали — содержимое снова совпадает с диском, и мы знаем время файла.
    // Без `markSaved` документ считался бы правленым: следующее внешнее изменение
    // молча пропустилось бы как «грязный», а в редакторе висела бы пометка правок.
    target.markSaved(file.mtimeMs);
    return target;
  }
}
