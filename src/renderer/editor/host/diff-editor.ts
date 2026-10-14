/**
 * Сравнение двух версий файла своим редактором.
 *
 * Что это и зачем. Возможности сравнения держались на Monaco (`createDiff`), и без
 * своей замены снять Monaco нельзя: на сравнении стоит и просмотр правок git, и
 * разрешение конфликтов слияния. Этот модуль повторяет ТУ ЖЕ границу, что отдавал
 * Monaco (`set` / `setHunkActions` / `setLayout` / `goToChange` / `dispose`), поэтому
 * вызывающий (просмотр различий и экран конфликтов) о подмене не знает.
 *
 * Как устроено. Сравнение — это ряд выровненных строк (`host/diff-model.ts`): у каждой
 * строки обе стороны, и подряд идущие непустые ряды складываются в блоки изменений.
 * Рисуем ряд двумя половинами (исходная и изменённая): рядом — в две колонки, одним
 * столбцом — прячем исходную половину. Цвета — те же роли палитры, что у редактора,
 * поэтому подсветка в сравнении совпадает с подсветкой в коде.
 *
 * Виртуализация как в редакторе: файл бывает в сотни килобайт, а узлов держим
 * столько, сколько строк влезает в окно, плюс запас. Остальное — пустая распорка
 * нужной высоты, чтобы полоса прокрутки показывала настоящую длину сравнения.
 *
 * Модуль браузерный: он собирает узлы. Чистая часть (выравнивание) — рядом, в
 * `diff-model.ts`, и проверяется тестами без окна.
 */

import type { Token } from '../highlight/tokens';
import { LineHighlighter } from '../highlight/highlighter';
import { sharedTokens } from '../highlight/token-cache';
import { grammarFor } from '../highlight/registry';
import { paletteOf, roleOfToken, type Scheme } from '../highlight/style';
import { buildDiff, type DiffHunk, type DiffRow } from './diff-model';
import { clamp, contentHeight, maxScrollTop, revealLine, visibleLines } from '../view/viewport';

const ROOT_CLASS = 'own-diff';

/** Действие у блока изменений: индекс блока, строка и подпись кнопки. */
export interface OwnDiffHunkAction {
  index: number;
  /** Строка ИЗМЕНЁННОЙ версии, у которой рисуем кнопку (1 с единицы). */
  line: number;
  label: string;
}

/** Сторона сравнения, к которой привязано замечание ревью. */
export type DiffSide = 'original' | 'modified';

/** Метка замечаний у строки: сколько их и решён ли тред. */
export interface OwnDiffCommentMark {
  side: DiffSide;
  /** Номер строки на этой стороне (с единицы). */
  line: number;
  /** Сколько сообщений в треде — показываем числом на метке. */
  count: number;
  resolved: boolean;
}

/** Что делать при работе с замечаниями: показать тред или завести новый. */
export interface OwnDiffCommentHandlers {
  marks: readonly OwnDiffCommentMark[];
  /** Текущий открытый тред — его строку подсвечиваем. */
  selected?: { side: DiffSide; line: number } | null;
  /** Клик по метке у строки. */
  onSelect: (side: DiffSide, line: number) => void;
  /** Клик по номеру: завести замечание к этой строке. */
  onRequest: (side: DiffSide, line: number) => void;
}

/** Граница сравнения — та же, что отдавал Monaco (`DiffEditorHandle`). */
export interface OwnDiffHandle {
  set(input: { language: string; original: string; modified: string }): void;
  setHunkActions(actions: readonly OwnDiffHunkAction[] | null, onSelect: (index: number) => void): void;
  /** Показать метки замечаний у строк; `null` — меток нет. */
  setComments(handlers: OwnDiffCommentHandlers | null): void;
  /** Прокрутить к строке с замечанием (клик по треду в списке). */
  revealComment(side: DiffSide, line: number): void;
  setLayout(sideBySide: boolean): void;
  goToChange(direction: 1 | -1): void;
  dispose(): void;
}

export interface OwnDiffEditorOptions {
  /** Схема оформления: цвета токенов берутся из темы. */
  scheme?: Scheme;
}

export class OwnDiffEditor implements OwnDiffHandle {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly content: HTMLElement;
  private readonly rowsLayer: HTMLElement;
  private readonly actionsLayer: HTMLElement;

  private scheme: Scheme;
  private lineHeight = 20;

  private rows: readonly DiffRow[] = [];
  private hunks: readonly DiffHunk[] = [];
  private originalLines: string[] = [];
  private modifiedLines: string[] = [];
  private originalHighlighter: LineHighlighter | null = null;
  private modifiedHighlighter: LineHighlighter | null = null;

  private actions: readonly OwnDiffHunkAction[] = [];
  private onSelect: ((index: number) => void) | null = null;

  /** Замечания ревью: метки по ключу «сторона:строка» и что делать по клику. */
  private commentHandlers: OwnDiffCommentHandlers | null = null;
  private readonly commentMarks = new Map<string, OwnDiffCommentMark>();
  /** Текущий блок при переходах «вперёд/назад»: −1 — ещё не переходили. */
  private currentHunk = -1;
  /** Что нарисовано: границы видимых рядов — чтобы не пересобирать зря. */
  private rendered = { first: -1, last: -1 };
  private disposed = false;

  constructor(container: HTMLElement, options: OwnDiffEditorOptions = {}) {
    this.scheme = options.scheme ?? 'dark';

    this.root = document.createElement('div');
    this.root.className = ROOT_CLASS;
    this.body = document.createElement('div');
    this.body.className = `${ROOT_CLASS}-body`;
    this.content = document.createElement('div');
    this.content.className = `${ROOT_CLASS}-content`;
    this.rowsLayer = document.createElement('div');
    this.rowsLayer.className = `${ROOT_CLASS}-rows`;
    this.actionsLayer = document.createElement('div');
    this.actionsLayer.className = `${ROOT_CLASS}-actions`;
    this.content.append(this.rowsLayer, this.actionsLayer);
    this.body.append(this.content);
    this.root.append(this.body);
    container.append(this.root);

    this.lineHeight = measureLineHeight(this.body);
    this.root.style.setProperty('--own-diff-line-height', `${this.lineHeight}px`);
    this.applyTheme();

    this.body.addEventListener('scroll', this.onScroll);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.render());
      this.resizeObserver.observe(this.body);
    }
    // Шрифт кода грузится своим файлом: если его ещё нет, высота строки меряется по
    // запасному. Когда шрифт дорос — перемеряем, иначе ряды «поедут».
    if (typeof document.fonts?.ready?.then === 'function') {
      void document.fonts.ready.then(() => {
        if (this.disposed) return;
        this.lineHeight = measureLineHeight(this.body);
        this.root.style.setProperty('--own-diff-line-height', `${this.lineHeight}px`);
        this.rendered = { first: -1, last: -1 };
        this.render();
      });
    }
  }

  private readonly resizeObserver: ResizeObserver | null = null;

  set({ language, original, modified }: { language: string; original: string; modified: string }): void {
    const grammar = grammarFor(language);
    this.originalLines = splitLines(original);
    this.modifiedLines = splitLines(modified);
    // Подсветка отдельная для каждой стороны: строки нумеруются независимо, и общий
    // кэш на две версии привёл бы к тому, что токены одной стороны описывали бы другую.
    this.originalHighlighter = new LineHighlighter(grammar, (line) => this.originalLines[line] ?? '', sharedTokens);
    this.modifiedHighlighter = new LineHighlighter(grammar, (line) => this.modifiedLines[line] ?? '', sharedTokens);

    const model = buildDiff(original, modified);
    this.rows = model.rows;
    this.hunks = model.hunks;
    this.currentHunk = -1;
    // Модель новая — старые кнопки указывали бы на строки прежнего текста.
    this.actions = [];
    this.onSelect = null;
    this.actionsLayer.replaceChildren();
    // Метки замечаний ставит вызывающий следом (`setComments`): прежние к новому
    // сравнению не относятся.
    this.commentMarks.clear();
    this.commentHandlers = null;
    this.body.scrollTop = 0;
    this.rendered = { first: -1, last: -1 };
    this.render();
  }

  setHunkActions(actions: readonly OwnDiffHunkAction[] | null, onSelect: (index: number) => void): void {
    this.actions = actions ?? [];
    this.onSelect = onSelect;
    this.renderActions();
  }

  /**
   * Показать замечания ревью: метку у каждой строки с тредом и что делать по клику.
   * Метки живут в точках номера строки, поэтому достаточно пересобрать видимые ряды.
   */
  setComments(handlers: OwnDiffCommentHandlers | null): void {
    this.commentHandlers = handlers;
    this.commentMarks.clear();
    for (const mark of handlers?.marks ?? []) this.commentMarks.set(commentKey(mark.side, mark.line), mark);
    // Тот же набор рядов, но метки могли смениться — пересобираем принудительно.
    this.rendered = { first: -1, last: -1 };
    this.render();
  }

  /** Прокрутить к строке с замечанием: ряд ищем по номеру на нужной стороне. */
  revealComment(side: DiffSide, line: number): void {
    const rowIndex = this.rows.findIndex((row) =>
      side === 'original' ? row.originalLine === line : row.modifiedLine === line,
    );
    if (rowIndex < 0) return;
    const scrollTop = revealLine(
      rowIndex,
      this.body.scrollTop,
      this.lineHeight,
      this.body.clientHeight,
      this.rows.length,
    );
    this.body.scrollTop = scrollTop;
    this.render();
  }

  setLayout(sideBySide: boolean): void {
    this.root.classList.toggle('is-inline', !sideBySide);
  }

  goToChange(direction: 1 | -1): void {
    if (this.hunks.length === 0) return;
    const count = this.hunks.length;
    // Первый переход — на первый блок, дальше по кругу: так и вперёд, и назад.
    const next =
      this.currentHunk < 0 ? (direction > 0 ? 0 : count - 1) : (this.currentHunk + direction + count) % count;
    this.currentHunk = next;
    const hunk = this.hunks[next]!;
    // Строка блока в изменённой версии — к ней и ведём, как делал Monaco.
    const rowIndex = this.rows.findIndex((row) => row.modifiedLine === hunk.modifiedStartLine);
    const scrollTop = revealLine(
      rowIndex < 0 ? hunk.modifiedStartLine - 1 : rowIndex,
      this.body.scrollTop,
      this.lineHeight,
      this.body.clientHeight,
      this.rows.length,
    );
    this.body.scrollTop = scrollTop;
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.body.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.root.remove();
  }

  // — отрисовка —

  private readonly onScroll = (): void => {
    this.render();
  };

  private render(): void {
    const height = this.body.clientHeight;
    const scrollTop = clamp(this.body.scrollTop, maxScrollTop(this.rows.length, this.lineHeight, height));
    this.body.scrollTop = scrollTop;

    // Размер полотна: высота — по числу рядов, ширина — по контейнеру.
    this.content.style.height = `${Math.max(contentHeight(this.rows.length, this.lineHeight), height)}px`;

    const { first, last } = visibleLines(scrollTop, this.lineHeight, height, this.rows.length, 2);
    if (first !== this.rendered.first || last !== this.rendered.last) {
      this.renderRows(first, last);
      this.rendered = { first, last };
    }
  }

  private renderRows(first: number, last: number): void {
    const fragment = document.createDocumentFragment();
    for (let index = first; index <= last && index < this.rows.length; index += 1) {
      const row = this.rows[index]!;
      const node = document.createElement('div');
      node.className = `${ROOT_CLASS}-row is-${row.kind}`;
      node.append(this.side(row, 'original'), this.side(row, 'modified'));
      fragment.append(node);
    }
    this.rowsLayer.replaceChildren(fragment);
    this.rowsLayer.style.transform = `translateY(${first * this.lineHeight}px)`;
  }

  /** Одна половина ряда: номер строки и подсвеченный текст. */
  private side(row: DiffRow, side: 'original' | 'modified'): HTMLElement {
    const isOriginal = side === 'original';
    const line = isOriginal ? row.originalLine : row.modifiedLine;
    const text = isOriginal ? row.originalText : row.modifiedText;

    const node = document.createElement('div');
    node.className = `${ROOT_CLASS}-side ${isOriginal ? 'is-original' : 'is-modified'}`;

    const number = document.createElement('span');
    number.className = `${ROOT_CLASS}-num`;
    number.textContent = line === null ? '' : String(line);
    node.append(number);

    // Метка замечаний у строки: номер кликабелен (завести замечание), а сама метка —
    // нет: по ней открывают уже существующий тред.
    if (line !== null && this.commentHandlers) {
      const sideName: DiffSide = isOriginal ? 'original' : 'modified';
      const mark = this.commentMarks.get(commentKey(sideName, line));
      number.classList.add('is-clickable');
      number.title = mark ? 'Открыть замечания строки' : 'Оставить замечание к строке';
      number.addEventListener('mousedown', (event) => {
        event.preventDefault();
        if (mark) this.commentHandlers?.onSelect(sideName, line);
        else this.commentHandlers?.onRequest(sideName, line);
      });
      if (mark) {
        node.classList.add('has-comment');
        if (mark.resolved) node.classList.add('is-comment-resolved');
        if (
          this.commentHandlers.selected &&
          this.commentHandlers.selected.side === sideName &&
          this.commentHandlers.selected.line === line
        ) {
          node.classList.add('is-comment-active');
        }
        const badge = document.createElement('span');
        badge.className = `${ROOT_CLASS}-comment`;
        badge.textContent = mark.count > 1 ? String(mark.count) : '';
        badge.title = mark.resolved ? 'Замечание решено' : 'Есть замечание';
        node.append(badge);
      }
    }

    const content = document.createElement('span');
    content.className = `${ROOT_CLASS}-text`;
    // Пустая сторона у вставки/удаления — пробел, иначе строка схлопнется по высоте.
    if (line === null) content.textContent = ' ';
    else this.fillText(content, text, isOriginal ? this.originalHighlighter : this.modifiedHighlighter, line);
    node.append(content);

    return node;
  }

  /** Разложить текст строки по токенам — теми же классами ролей, что и редактор. */
  private fillText(node: HTMLElement, text: string, highlighter: LineHighlighter | null, line: number): void {
    if (!highlighter) {
      node.textContent = text;
      return;
    }
    const tokens = highlighter.tokensFor(line - 1);
    if (tokens.length === 0) {
      node.textContent = text;
      return;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const token of tokens) {
      fragment.append(document.createTextNode(text.slice(cursor, token.start)));
      cursor = token.end;
      fragment.append(this.tokenSpan(text, token));
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.append(fragment);
  }

  private tokenSpan(text: string, token: Token): Node {
    const piece = text.slice(token.start, token.end);
    const role = roleOfToken(token.type);
    if (!role) return document.createTextNode(piece);
    const span = document.createElement('span');
    span.className = `own-editor-token-${role}`;
    span.textContent = piece;
    return span;
  }

  /** Кнопки у блоков: стоят над своей строкой изменённой версии. */
  private renderActions(): void {
    if (this.actions.length === 0) {
      this.actionsLayer.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const action of this.actions) {
      const bar = document.createElement('div');
      bar.className = 'diff-hunk-bar';
      bar.style.transform = `translateY(${(Math.max(action.line, 1) - 1) * this.lineHeight}px)`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'diff-hunk-action';
      button.textContent = action.label;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        this.onSelect?.(action.index);
      });
      bar.append(button);
      fragment.append(bar);
    }
    this.actionsLayer.replaceChildren(fragment);
  }

  private applyTheme(): void {
    const palette = paletteOf(this.scheme);
    for (const [role, color] of Object.entries(palette)) {
      this.root.style.setProperty(`--own-token-${role}`, color);
    }
  }
}

/** Ключ метки замечания: сторона и строка. */
function commentKey(side: DiffSide, line: number): string {
  return `${side}:${line}`;
}

/** Пустой текст — ноль строк, как и в модели: так «файла не было» ≠ «одна строка». */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Высота строки — по оформлению: меряем пробный ряд и берём его высоту. Дробную
 * высоту округляем до целого: иначе на длинном сравнении копится видимый шов между
 * рядами (та же причина, что и в редакторе).
 */
function measureLineHeight(container: HTMLElement): number {
  const probe = document.createElement('div');
  probe.className = `${ROOT_CLASS}-row`;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.textContent = 'X';
  container.append(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(measured) || 20;
}
