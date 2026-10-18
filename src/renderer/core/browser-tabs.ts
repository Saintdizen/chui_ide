import { Emitter } from './events';

/**
 * Вкладки встроенного браузера: страницы живут в той же полосе, что файлы.
 *
 * Открытые файлы ведёт `OpenEditors`, и страницу туда не положить: у неё нет ни
 * текста, ни пути на диске — есть только адрес. Поэтому своя маленькая модель,
 * а полоса вкладок берёт из неё то же, что и у файлов: подпись, активность, закрытие.
 *
 * Хранится здесь ровно то, что нужно полосе и адресной строке: адрес, заголовок
 * (его присылает сама страница) и порядок. Ни сети, ни `webview` этот модуль не
 * знает — поэтому проверяется тестами без окна.
 */

/** Одна открытая страница. */
export interface BrowserPage {
  /** Ключ вкладки. Не адрес: одну и ту же страницу могли открыть заново. */
  id: string;
  url: string;
  /** Заголовок из `<title>` страницы; до загрузки подставляем адрес. */
  title: string;
  /**
   * Страницу открыл ассистент. Вкладка при этом настоящая, но её завёл не человек:
   * в полосе это видно значком, иначе непонятно, откуда взялась страница с пустым
   * профилем и кто в ней сейчас нажимает кнопки.
   */
  byAgent?: boolean;
}

export class BrowserTabs {
  private readonly pages: BrowserPage[] = [];
  private activeId: string | null = null;
  /** Счётчик для ключей: id не повторяется, даже если вкладку закрыли и открыли снова. */
  private sequence = 0;

  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  get list(): readonly BrowserPage[] {
    return this.pages;
  }

  get active(): BrowserPage | null {
    return this.pages.find((page) => page.id === this.activeId) ?? null;
  }

  get activePageId(): string | null {
    return this.activeId;
  }

  page(id: string): BrowserPage | null {
    return this.pages.find((page) => page.id === id) ?? null;
  }

  /**
   * Открыть адрес. Уже открытый — не дублируем, а показываем: в браузере так и
   * ждут, а второй вкладки с той же страницей человек не просил.
   */
  open(url: string): string {
    const existing = this.pages.find((page) => page.url === url);
    if (existing) {
      this.activeId = existing.id;
      this.changeEmitter.fire();
      return existing.id;
    }

    this.sequence += 1;
    const page: BrowserPage = { id: `page-${this.sequence}`, url, title: url };
    this.pages.push(page);
    this.activeId = page.id;
    this.changeEmitter.fire();
    return page.id;
  }

  /**
   * Завести вкладку с ГОТОВЫМ ключом: так приходит страница, открытая агентом.
   *
   * Ключ даёт main (`main/browser/panel.ts`): он завёл вложение раньше, чем мы
   * узнали о вкладке, и от ключа зависит, к какому вложению обращаться. Свой счётчик
   * здесь не подходит — из двух независимых счётчиков вышли бы совпадающие ключи.
   */
  adopt(id: string, url: string, byAgent = false): void {
    const existing = this.pages.find((page) => page.id === id);
    if (existing) {
      existing.url = url;
      // Усыновили второй раз — вкладка агента агентской и остаётся.
      existing.byAgent = byAgent || existing.byAgent === true;
    } else {
      this.pages.push({ id, url, title: url, ...(byAgent ? { byAgent: true } : {}) });
    }
    this.activeId = id;
    this.changeEmitter.fire();
  }

  activate(id: string): void {
    if (this.activeId === id || !this.pages.some((page) => page.id === id)) return;
    this.activeId = id;
    this.changeEmitter.fire();
  }

  /** Заголовок или адрес изменились: страница сама сообщает об этом `webview`. */
  update(id: string, patch: { url?: string; title?: string }): void {
    const page = this.pages.find((item) => item.id === id);
    if (!page) return;
    const url = patch.url ?? page.url;
    const title = patch.title ?? page.title;
    if (url === page.url && title === page.title) return;
    page.url = url;
    page.title = title;
    this.changeEmitter.fire();
  }

  close(id: string): void {
    const index = this.pages.findIndex((page) => page.id === id);
    if (index < 0) return;
    this.pages.splice(index, 1);
    if (this.activeId === id) {
      // Встаём на соседа — так же поступает полоса вкладок с файлами.
      this.activeId = this.pages[Math.min(index, this.pages.length - 1)]?.id ?? null;
    }
    this.changeEmitter.fire();
  }

  closeAll(): void {
    if (this.pages.length === 0) return;
    this.pages.length = 0;
    this.activeId = null;
    this.changeEmitter.fire();
  }

  /** Показать файл: страницы больше не активны, хотя из полосы не исчезают. */
  deactivate(): void {
    if (this.activeId === null) return;
    this.activeId = null;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
