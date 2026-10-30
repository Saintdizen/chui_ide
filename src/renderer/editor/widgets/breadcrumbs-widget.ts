/**
 * Хлебные крошки над текстом: где курсор в структуре файла (Ctrl+Shift+O показывает
 * структуру целиком, а крошки — всегда перед глазами и одним кликом ведут к родителю).
 *
 * Символы берутся у языкового сервера (`textDocument/documentSymbol`) через источник
 * `fileSymbols` шва editor-workspace: крошки не парсят текст сами, а показывают то,
 * что сервер уже знает. Нет источника или сервер молчит — полосы просто нет.
 *
 * Логика «какой символ под строкой» вынесена в `shared/symbol-path.ts` (чистая, с тестами).
 */

import type { FileSymbol } from '../../../shared/lsp-symbols';
import { symbolPathAt, type SymbolPathLink } from '../../../shared/symbol-path';

export interface BreadcrumbsOptions {
  /** Символы файла: `null` — спросить не удалось (сервер молчит или язык без сервера). */
  fileSymbols: (path: string) => Promise<FileSymbol[] | null>;
  /** Перейти к строке символа (клик по крошке). */
  reveal: (path: string, line: number) => void;
  /** Текущий путь и номер строки курсора; `null` — документ закрыт. */
  current: () => { path: string; line: number } | null;
}

/** Сколько ждать сервер, прежде чем решить, что символов нет. */
const SYMBOLS_TIMEOUT_MS = 2000;

export class BreadcrumbsWidget {
  private readonly options: BreadcrumbsOptions;
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  /** Путь, для которого сейчас показана цепочка, — чтобы не дёргать сервер каждый ход. */
  private path: string | null = null;
  private symbols: readonly FileSymbol[] = [];
  private links: readonly SymbolPathLink[] = [];
  /** Номер запроса: поздний ответ сервера не должен перебить свежий. */
  private loadId = 0;

  constructor(options: BreadcrumbsOptions) {
    this.options = options;

    this.root = document.createElement('div');
    this.root.className = 'own-editor-breadcrumbs';
    this.root.hidden = true;

    this.list = document.createElement('div');
    this.list.className = 'own-editor-breadcrumbs-list';
    this.root.append(this.list);
  }

  get element(): HTMLElement {
    return this.root;
  }

  /**
   * Курсор переехал или документ сменился. Структуру спрашиваем только при смене файла:
   * символы меняются правкой, а не движением каретки, и запрос на каждый шаг курсора
   * был бы потоком запросов к серверу.
   */
  refresh(): void {
    const current = this.options.current();
    if (!current) {
      this.clear();
      return;
    }
    if (current.path !== this.path) {
      void this.load(current.path);
      return;
    }
    this.render(current.line);
  }

  /** Текст правлен — структура могла уехать: следующий показ перечитает символы. */
  invalidate(): void {
    this.path = null;
  }

  private async load(path: string): Promise<void> {
    const id = ++this.loadId;
    this.path = path;
    this.symbols = [];
    let symbols: FileSymbol[] | null = null;
    try {
      symbols = await withTimeout(this.options.fileSymbols(path), SYMBOLS_TIMEOUT_MS);
    } catch {
      symbols = null;
    }
    // Пока ждали, сменился файл или пришёл более свежий запрос — этот ответ уже не про то.
    if (id !== this.loadId) return;
    this.symbols = symbols ?? [];
    const current = this.options.current();
    if (current && current.path === path) this.render(current.line);
  }

  private render(line: number): void {
    this.links = symbolPathAt(this.symbols, line);
    this.list.replaceChildren();
    if (this.links.length === 0) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.links.forEach((link, index) => {
      if (index > 0) {
        const sep = document.createElement('span');
        sep.className = 'own-editor-breadcrumbs-sep';
        sep.textContent = '\u203a';
        this.list.append(sep);
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'own-editor-breadcrumbs-item';
      item.title = `${link.kind} \u00b7 строка ${link.line}`;
      item.textContent = link.name;
      // Последнее звено — текущее место: кликать некуда, оно и так под курсором.
      const isLast = index === this.links.length - 1;
      if (isLast) item.setAttribute('aria-current', 'location');
      item.addEventListener('click', () => {
        const path = this.path;
        if (path) this.options.reveal(path, link.line);
      });
      this.list.append(item);
    });
  }

  private clear(): void {
    this.path = null;
    this.symbols = [];
    this.links = [];
    this.loadId += 1;
    this.list.replaceChildren();
    this.root.hidden = true;
  }
}

/**
 * Ожидание с ограничением: `null`, если за отведённое время не ответили. Сервер может
 * зависнуть, а крошки — не повод держать их загрузку вечно.
 */
function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
