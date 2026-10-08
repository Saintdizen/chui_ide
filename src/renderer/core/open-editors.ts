import type { TextDocument } from './document';
import type { DocumentStore } from './document-store';
import { Emitter } from './events';

/**
 * Открытые вкладки: порядок, активная, dirty-состояние.
 * Отдельная модель, а не состояние UI — потому что вкладки нужны и командам,
 * и (позже) ассистенту, который захочет понять, что сейчас открыто.
 */
export class OpenEditors {
  private readonly order: string[] = [];
  private activeId: string | null = null;

  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly documents: DocumentStore) {}

  get paths(): readonly string[] {
    return this.order;
  }

  get active(): TextDocument | null {
    return this.activeId ? (this.documents.get(this.activeId) ?? null) : null;
  }

  has(path: string): boolean {
    return this.order.includes(path);
  }

  open(document: TextDocument): void {
    if (!this.order.includes(document.path)) this.order.push(document.path);
    this.activeId = document.path;
    this.changeEmitter.fire();
  }

  activate(path: string): void {
    if (!this.order.includes(path) || this.activeId === path) return;
    this.activeId = path;
    this.changeEmitter.fire();
  }

  close(path: string): string | null {
    const index = this.order.indexOf(path);
    if (index < 0) return this.activeId;

    this.order.splice(index, 1);
    this.documents.close(path);

    if (this.activeId === path) {
      this.activeId = this.order[Math.min(index, this.order.length - 1)] ?? null;
    }
    this.changeEmitter.fire();
    return this.activeId;
  }

  closeAll(): void {
    for (const path of [...this.order]) this.documents.close(path);
    this.order.length = 0;
    this.activeId = null;
    this.changeEmitter.fire();
  }
}
