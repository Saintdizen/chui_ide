/**
 * Всплывающая подсказка о слове при наведении мыши.
 *
 * Показывается не сразу, а с паузой: если подсказка выскакивает под курсором, пока
 * человек ведёт мышь к другому месту, она мешает — закрывает собой код и крадёт взгляд.
 * Пауза короткая; как только мышь поехала дальше, подсказка закрывается.
 *
 * У подсказки два источника, и они дополняют друг друга:
 *
 *   • ЧТО ВИДНО В ФАЙЛЕ — роль слова из подсветки, сколько раз оно встречается, где
 *     объявлено. Это считает `hover/word-info.ts`; у нас нет своего разбора языка, и
 *     выдумывать его не нужно: «config объявлено на 12-й строке» — честный факт.
 *   • ЧТО ЗНАЕТ ЯЗЫКОВОЙ СЕРВЕР — типы, сигнатуры, документация. Это приходит снаружи
 *     (`external`): показывать его — дело вида, а ходить к серверу — дело вызывающего
 *     (см. `host/lsp-features.ts`). Запрос ждём асинхронно и подставляем в ту же
 *     карточку: за это время мышь может уехать, поэтому ответ проверяем на актуальность.
 *
 * Показывать нечего, если слово ничем не примечательно: подсказка «имя, встречается
 * один раз» бесполезна, она только закрывает текст. Поэтому без языкового сервера
 * правило простое — показываем, когда есть что сказать: роль слова (ключевое, тип,
 * функция) или оно встречается в файле больше одного раза. Когда сервер ответил, его
 * ответ важнее: он и есть подсказка.
 */

import { describeWord, wordInfoAt } from '../hover/word-info';
import { roleLabel } from '../highlight/tokens';
import type { TextBuffer } from '../core/text-buffer';
import type { EditorView } from '../view/editor-view';

/** Пауза перед показом: на ходу мышь не должна ничего открывать. */
const HOVER_DELAY_MS = 350;

/** Что знает языковой сервер о слове. `text` — разметка (markdown), строки — для показа. */
export interface HoverExternalInfo {
  /** Заголовок карточки; без него берётся само слово. */
  readonly title?: string;
  /** Тело подсказки: строки разметки. */
  readonly text: string;
}

export interface HoverWidgetOptions {
  /**
   * Источник подсказки от языкового сервера. `null` — сказать нечего (сервера нет или
   * символ не опознан); тогда остаётся только то, что видно в файле.
   */
  external?: (offset: number) => Promise<HoverExternalInfo | null>;
  /**
   * Несколько внешних источников ПО ПРИОРИТЕТУ: первый ответивший и побеждает. Так
   * отладочная подсказка (значение переменной в остановленном кадре) идёт раньше
   * языковой, а не соперничает с ней за одну карточку.
   */
  sources?: readonly ((offset: number) => Promise<HoverExternalInfo | null>)[];
}

export class HoverWidget {
  private buffer: TextBuffer;
  private readonly view: EditorView;
  private readonly root: HTMLElement;
  private readonly sources: readonly ((offset: number) => Promise<HoverExternalInfo | null>)[];
  private timer: number | null = null;
  private visible = false;
  /**
   * Номер запроса: сервер отвечает не мгновенно, и к его ответу мышь уже могла уехать
   * на другое слово. Сверяем номер — иначе через карточку прошёл бы чужой текст.
   */
  private requestId = 0;

  constructor(view: EditorView, buffer: TextBuffer, options: HoverWidgetOptions = {}) {
    this.view = view;
    this.buffer = buffer;
    this.sources = options.sources ?? (options.external ? [options.external] : []);

    this.root = document.createElement('div');
    this.root.className = 'own-editor-hover';
    this.root.hidden = true;
    view.element.append(this.root);

    const viewport = view.element.querySelector<HTMLElement>('.own-editor-viewport');
    viewport?.addEventListener('mousemove', this.onMouseMove);
    viewport?.addEventListener('mouseleave', this.onMouseLeave);
    viewport?.addEventListener('mousedown', this.onMouseLeave);
    viewport?.addEventListener('scroll', this.onMouseLeave);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Новый документ: подсказка о прежнем слове к нему не относится. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.hide();
  }

  /** Наведение на смещение: то же, что делает мышь, но вызывается напрямую (проба). */
  showAt(offset: number, clientX: number, clientY: number): void {
    this.lastOffset = offset;
    this.requestId += 1;
    const id = this.requestId;

    // 1. Что видно в файле — показываем сразу, не ждя сервера.
    const info = wordInfoAt(this.buffer, offset);
    const role = roleLabel(this.view.tokenTypeAt(offset));
    let shownLocal = false;
    if (info) {
      const worthShowing = role !== null || info.occurrences > 1 || info.declaredAt !== null;
      if (worthShowing) {
        const described = describeWord(info);
        const lines = role ? [role, ...described.lines] : described.lines;
        this.show(described.title, lines, clientX, clientY);
        shownLocal = true;
      }
    }
    if (!shownLocal) this.hide();

    // 2. Что знает сервер (или отладчик) — подставляем, когда ответит; его ответ важнее
    // локального. Источники идут по приоритету: первый непустой и показывается.
    if (this.sources.length > 0) void this.enrich(id, offset, clientX, clientY);
  }

  /** Дождаться ответа источников и, если он актуален, показать текст первого непустого. */
  private async enrich(id: number, offset: number, clientX: number, clientY: number): Promise<void> {
    for (const source of this.sources) {
      let result: HoverExternalInfo | null = null;
      try {
        result = await source(offset);
      } catch {
        // Источник недоступен — пробуем следующий; локальная подсказка уже показана.
        continue;
      }
      // Мышь уже ушла на другое слово — ответ про прежнее место не показываем.
      if (id !== this.requestId) return;
      if (!result?.text.trim()) continue;

      this.externalShown += 1;
      const lines = result.text.split('\n').map((line) => line.replace(/\s+$/, ''));
      this.show(result.title ?? this.currentTitle ?? '', lines, clientX, clientY);
      return;
    }
  }

  /** Показать карточку с заголовком и строками тела. */
  private show(title: string, lines: readonly string[], clientX: number, clientY: number): void {
    this.shown += 1;
    this.currentTitle = title;
    this.render(title, lines);
    this.root.hidden = false;
    this.visible = true;
    this.position(clientX, clientY);
  }

  hide(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.requestId += 1;
    this.visible = false;
    this.root.hidden = true;
  }

  private render(title: string, lines: readonly string[]): void {
    const head = document.createElement('div');
    head.className = 'own-editor-hover-title';
    head.textContent = title;

    const body = document.createElement('div');
    body.className = 'own-editor-hover-body';
    for (const line of lines) {
      const row = document.createElement('div');
      row.textContent = line;
      body.append(row);
    }
    this.root.replaceChildren(head, body);
  }

  /**
   * Поставить подсказку у курсора мыши, не давая ей уехать за край окна и не закрывая
   * собой слово, на которое смотрят: смещаем на клетку вниз и вправо.
   */
  private position(clientX: number, clientY: number): void {
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(clientX + 12, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(clientY + 18, window.innerHeight - height - margin));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.moves += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    // Мышь поехала — прежняя подсказка уже не про то место.
    this.hide();
    const { clientX, clientY } = event;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const offset = this.view.offsetAt(clientX, clientY);
      this.showAt(offset, clientX, clientY);
    }, HOVER_DELAY_MS);
  };

  /** Сколько событий видел виджет и что показал — для проб и диагностики. */
  get diagnostics(): { moves: number; leaves: number; shown: number; fromLanguage: number; lastOffset: number } {
    return {
      moves: this.moves,
      leaves: this.leaves,
      shown: this.shown,
      fromLanguage: this.externalShown,
      lastOffset: this.lastOffset,
    };
  }

  private moves = 0;
  private leaves = 0;
  private shown = 0;
  /** Сколько раз подсказку дал языковой сервер (а не сам файл). */
  private externalShown = 0;
  private lastOffset = -1;
  private currentTitle: string | null = null;

  /**
   * Курсор ушёл с текста. Гасим подсказку — но не когда он ушёл на саму подсказку:
   * попап стоит рядом с курсором и может оказаться под ним, а мигать под собственным
   * курсором он не должен.
   */
  private readonly onMouseLeave = (event: Event): void => {
    this.leaves += 1;
    const target = (event as MouseEvent).relatedTarget;
    if (target instanceof Node && this.root.contains(target)) return;
    this.hide();
  };

  dispose(): void {
    this.hide();
    const viewport = this.view.element.querySelector<HTMLElement>('.own-editor-viewport');
    viewport?.removeEventListener('mousemove', this.onMouseMove);
    viewport?.removeEventListener('mouseleave', this.onMouseLeave);
    viewport?.removeEventListener('mousedown', this.onMouseLeave);
    viewport?.removeEventListener('scroll', this.onMouseLeave);
    this.root.remove();
  }
}
