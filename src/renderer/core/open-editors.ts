import type { TextDocument } from './document';
import type { DocumentStore } from './document-store';
import { Emitter } from './events';

/**
 * Открытые вкладки: порядок, активная, dirty-состояние, предпросмотр и закрепление.
 * Отдельная модель, а не состояние UI — потому что вкладки нужны и командам,
 * и (позже) ассистенту, который захочет понять, что сейчас открыто.
 *
 * Предпросмотр — вкладка «на посмотреть»: её открывает одиночный клик по файлу в
 * дереве, и следующая такая же вкладка её вытесняет, чтобы просмотр не плодил
 * десятки вкладок. Вкладка перестаёт быть предпросмотром, как только её начали
 * править (файл стал изменённым), закрепили или открыли из навигации «насовсем».
 *
 * Закрепление — вкладка «насовсем»: предпросмотр её не вытесняет, а «закрыть
 * другие» её не трогает. Закреплённые стоят левее прочих (порядок показывает полоса).
 */
export class OpenEditors {
  private readonly order: string[] = [];
  private activeId: string | null = null;
  /** Вкладка-предпросмотр (одна) или `null`, если предпросмотра нет. */
  private previewPath: string | null = null;
  private readonly pinned = new Set<string>();

  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly documents: DocumentStore) {
    // Правка в предпросмотре делает вкладку постоянной: файл, который правили, уже не
    // «посмотреть», а работать с ним. Следим за изменениями документа — этого довольно.
    this.documents.onDidChange(() => {
      if (!this.previewPath) return;
      if (this.documents.get(this.previewPath)?.dirty) {
        this.previewPath = null;
        this.changeEmitter.fire();
      }
    });
  }

  get paths(): readonly string[] {
    return this.order;
  }

  get active(): TextDocument | null {
    return this.activeId ? (this.documents.get(this.activeId) ?? null) : null;
  }

  has(path: string): boolean {
    return this.order.includes(path);
  }

  isPinned(path: string): boolean {
    return this.pinned.has(path);
  }

  isPreview(path: string): boolean {
    return this.previewPath === path;
  }

  /** Открыть файл. `preview` — вкладка «на посмотреть» (вытеснит прежний предпросмотр). */
  open(document: TextDocument, options: { preview?: boolean } = {}): void {
    const path = document.path;
    const preview = options.preview === true;

    if (this.order.includes(path)) {
      // Уже открыт: открытие «насовсем» снимает с него метку предпросмотра.
      if (!preview && this.previewPath === path) this.previewPath = null;
      this.activeId = path;
      this.changeEmitter.fire();
      return;
    }

    if (preview) {
      const current = this.previewPath;
      if (current && current !== path && this.order.includes(current) && !this.pinned.has(current)) {
        // Вытесняем прежний предпросмотр, вставая на его место: полоса вкладок не дёргается.
        const index = this.order.indexOf(current);
        this.order.splice(index, 1);
        this.documents.close(current);
        this.order.splice(index, 0, path);
      } else {
        this.order.push(path);
      }
      this.previewPath = path;
    } else {
      this.order.push(path);
    }

    this.activeId = path;
    this.changeEmitter.fire();
  }

  activate(path: string): void {
    if (!this.order.includes(path) || this.activeId === path) return;
    this.activeId = path;
    this.changeEmitter.fire();
  }

  /** Закрепить вкладку: предпросмотром она больше не станет. */
  pin(path: string): void {
    if (!this.order.includes(path)) return;
    const wasPreview = this.previewPath === path;
    const wasPinned = this.pinned.has(path);
    this.pinned.add(path);
    if (wasPreview) this.previewPath = null;
    if (!wasPinned || wasPreview) this.changeEmitter.fire();
  }

  unpin(path: string): void {
    if (this.pinned.delete(path)) this.changeEmitter.fire();
  }

  close(path: string): string | null {
    const index = this.order.indexOf(path);
    if (index < 0) return this.activeId;

    this.order.splice(index, 1);
    this.pinned.delete(path);
    if (this.previewPath === path) this.previewPath = null;
    this.documents.close(path);

    if (this.activeId === path) {
      this.activeId = this.order[Math.min(index, this.order.length - 1)] ?? null;
    }
    this.changeEmitter.fire();
    return this.activeId;
  }

  /** Закрыть все, кроме указанной и закреплённых: закреплённое — «насовсем». */
  closeOthers(keep: string): void {
    for (const path of [...this.order]) {
      if (path === keep || this.pinned.has(path)) continue;
      this.order.splice(this.order.indexOf(path), 1);
      this.documents.close(path);
    }
    if (this.order.includes(keep)) this.activeId = keep;
    this.changeEmitter.fire();
  }

  closeAll(): void {
    for (const path of [...this.order]) this.documents.close(path);
    this.order.length = 0;
    this.pinned.clear();
    this.previewPath = null;
    this.activeId = null;
    this.changeEmitter.fire();
  }
}
