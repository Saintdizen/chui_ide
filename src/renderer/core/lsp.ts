import { PushTopic, type LspDiagnosticsPayload } from '../../shared/api';
import type { DocumentStore } from './document-store';
import type { EditorService } from './editor-service';
import type { RpcClient } from './rpc';

/**
 * Связка редактора с языковыми серверами (LSP).
 *
 * Серверы живут в main (это процессы), а документы — здесь. Задача этого класса
 * ровно одна: держать их синхронными. Открылся или изменился документ — уезжает
 * `lsp.open`/`lsp.change`; пришла пачка пометок — ложится в Monaco маркерами
 * под своим `owner` (см. `EditorService.setExternalMarkers`).
 */
export class LspClient {
  constructor(
    private readonly rpc: RpcClient,
    private readonly documents: DocumentStore,
    private readonly editors: EditorService,
  ) {}

  attach(): void {
    // Уже открытые на момент старта файлы сервер тоже должен увидеть.
    for (const document of this.documents.all()) this.sendOpen(document.path, document.languageId, document.value);

    this.documents.onDidOpen((document) => this.sendOpen(document.path, document.languageId, document.value));

    // Полная синхронизация: правки любого источника уходят целиком, сервер сам
    // пересчитывает состояние. Так не нужно повторять логику диапазонов редактора.
    this.documents.onDidChange(({ document }) => {
      void this.rpc.request('lsp.change', { path: document.path, text: document.value }).catch(() => undefined);
    });

    this.documents.onDidClose((document) => {
      void this.rpc.request('lsp.close', { path: document.path }).catch(() => undefined);
      // Закрыли файл — убираем его пометки, иначе они останутся висеть на экране.
      this.editors.setExternalMarkers(document.path, 'lsp', []);
    });

    this.rpc.onPush((message) => {
      if (message.topic !== PushTopic.LspDiagnostics) return;
      const data = message.payload as LspDiagnosticsPayload;
      this.editors.setExternalMarkers(data.path, 'lsp', data.diagnostics);
    });
  }

  private sendOpen(path: string, languageId: string, text: string): void {
    void this.rpc.request('lsp.open', { path, languageId, text }).catch(() => undefined);
  }
}
