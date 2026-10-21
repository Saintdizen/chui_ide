/**
 * Копия кода «на месте»: заглянуть в определение, не уходя из файла.
 *
 * Виджет показывает окно строк целевого файла вокруг нужной строки: подпись пути,
 * счётчик мест и стрелки хода, кнопку «Открыть» (перейти насовсем) и закрытие. Код
 * красится той же грамматикой и той же палитрой, что и редактор, — копия должна
 * выглядеть как код, а не как серый текст.
 *
 * Виджет — только вид и клавиши. Какие места показывать, откуда взять текст и что
 * делать по «Открыть» решает вызывающий (`host/peek-controller.ts`): так его видно
 * в пробе и не приходится тащить в него ни языковой сервер, ни чтение файлов.
 *
 * Копия ставится ПОД строкой, откуда заглянули (как принято): смотреть
 * вверх неудобно — там уже прочитанный код. Если снизу места нет, `placePopup`
 * поднимет окно наверх.
 */

import { languageFromPath } from '../../core/languages';
import { placePopup } from '../../core/popup-placement';
import { languageGrammar } from '../highlight/lazy-registry';
import type { Grammar } from '../highlight/grammar';
import { LineHighlighter } from '../highlight/highlighter';
import { sharedTokens } from '../highlight/token-cache';
import { paletteOf, roleOfToken } from '../highlight/style';
import { peekCounter, peekStepIndex, peekWindow } from '../host/peek-model';

/** Где показать копию: низ строки в системе окна (левый край, верх и низ). */
export interface PeekAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** Что показать: текст целиком, место и как это назвать. */
export interface PeekPayload {
  /** Полный текст целевого файла — окно строк берём из него. */
  readonly text: string;
  /** Путь целевого файла: по нему выбирается язык подсветки. */
  readonly path: string;
  /** Куда указывает место (строка с единицы). */
  readonly targetLine: number;
  /** Подпись пути в заголовке (в приложении — короткий путь). */
  readonly title: string;
  /** Какое это место из найденных (с нуля). */
  readonly index: number;
  /** Сколько мест всего. */
  readonly total: number;
}

const ROOT_CLASS = 'own-editor-peek';
const WIDTH = 560;
const HEADER_HEIGHT = 28;
/** Высота строки: держим ту же, что у редактора, — копия не должна выглядеть иначе. */
const LINE_HEIGHT = 19;

export class PeekWidget {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly prevButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly code: HTMLElement;

  private visible = false;
  /** Текст окна и границы — нужны при перерисовке (смена схемы, размер). */
  private lines: string[] = [];
  private first = 1;
  private last = 0;
  private targetLine = 1;
  private language = 'plaintext';
  private grammar: Grammar | null = null;

  /** Открыть место насовсем — дело вызывающего. */
  onOpen: (() => void) | null = null;
  /** Шаг по местам (−1 назад, +1 вперёд). */
  onStep: ((delta: number) => void) | null = null;
  /** Закрыть копию. */
  onClose: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = ROOT_CLASS;
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Просмотр определения');

    const header = document.createElement('div');
    header.className = `${ROOT_CLASS}-header`;

    const nav = document.createElement('div');
    nav.className = `${ROOT_CLASS}-nav`;
    this.prevButton = this.stepButton('‹', -1, 'Предыдущее определение');
    this.nextButton = this.stepButton('›', 1, 'Следующее определение');
    this.counter = document.createElement('span');
    this.counter.className = `${ROOT_CLASS}-counter`;
    nav.append(this.prevButton, this.counter, this.nextButton);

    this.title = document.createElement('span');
    this.title.className = `${ROOT_CLASS}-title`;

    const actions = document.createElement('div');
    actions.className = `${ROOT_CLASS}-actions`;
    const openButton = button('Открыть', `${ROOT_CLASS}-open`, () => this.onOpen?.());
    openButton.title = 'Открыть файл на этом месте';
    const closeButton = button('✕', `${ROOT_CLASS}-close`, () => this.onClose?.());
    closeButton.title = 'Закрыть (Esc)';
    actions.append(openButton, closeButton);

    header.append(nav, this.title, actions);

    this.body = document.createElement('div');
    this.body.className = `${ROOT_CLASS}-body`;
    this.code = document.createElement('div');
    this.code.className = `${ROOT_CLASS}-code`;
    this.body.append(this.code);

    this.root.append(header, this.body);
    host.append(this.root);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Сменить схему оформления: цвета копии переставляются, текст остаётся. */
  refreshTheme(): void {
    if (this.visible) this.render();
  }

  /** Показать копию у якоря. Пустого текста не показываем — это не копия. */
  show(payload: PeekPayload, anchor: PeekAnchor): void {
    this.lines = payload.text.split('\n');
    this.targetLine = Math.max(1, payload.targetLine);
    this.language = languageFromPath(payload.path);
    // Грамматика — `import()`-ом (см. `highlight/lazy-registry.ts`): 34 языка
    // незачем везти в первом чанке ради всплывающей копии. Пока не приехала —
    // копия показывается простым текстом, по приезде перерисовывается.
    this.grammar = null;
    void languageGrammar(this.language).then((grammar) => {
      if (this.language !== languageFromPath(payload.path)) return;
      this.grammar = grammar;
      if (this.visible) this.render();
    });
    const window = peekWindow(this.lines.length, this.targetLine);
    this.first = window.first;
    this.last = window.last;

    this.title.textContent = payload.title;
    this.title.title = payload.title;
    this.counter.textContent = peekCounter(payload.index, payload.total);
    const step = peekStepIndex(payload.index, 0, payload.total);
    this.prevButton.disabled = step <= 0;
    this.nextButton.disabled = step >= payload.total - 1;
    this.root.hidden = false;
    this.visible = true;

    this.applyTheme();
    this.render();
    this.position(anchor);
    this.scrollToTarget();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.lines = [];
  }

  /**
   * Обработать клавишу раньше редактора. `true` — клавиша наша. Escape закрывает,
   * Enter открывает насовсем; стрелки вверх/вниз листают копию, а с Alt — шагают по
   * местам (как принято).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.visible) return false;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.onClose?.();
        return true;
      case 'Enter':
        event.preventDefault();
        this.onOpen?.();
        return true;
      case 'ArrowDown':
        event.preventDefault();
        this.body.scrollTop += LINE_HEIGHT * (event.shiftKey ? 1 : 3);
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.body.scrollTop -= LINE_HEIGHT * (event.shiftKey ? 1 : 3);
        return true;
      case 'ArrowRight':
        if (!event.altKey) return false;
        event.preventDefault();
        this.onStep?.(1);
        return true;
      case 'ArrowLeft':
        if (!event.altKey) return false;
        event.preventDefault();
        this.onStep?.(-1);
        return true;
      default:
        return false;
    }
  }

  private stepButton(label: string, delta: number, title: string): HTMLButtonElement {
    const node = button(label, `${ROOT_CLASS}-step`, () => this.onStep?.(delta));
    node.title = title;
    return node;
  }

  /** Пересобрать видимое окно строк: номера и текст с подсветкой. */
  private render(): void {
    const grammar = this.grammar;
    const highlighter = new LineHighlighter(grammar, (line) => this.lines[line] ?? '', sharedTokens);
    const fragment = document.createDocumentFragment();
    for (let line = this.first; line <= this.last; line += 1) {
      const row = document.createElement('div');
      row.className = line === this.targetLine ? `${ROOT_CLASS}-row is-target` : `${ROOT_CLASS}-row`;
      row.dataset.line = String(line);

      const number = document.createElement('span');
      number.className = `${ROOT_CLASS}-number`;
      number.textContent = String(line);

      const text = document.createElement('span');
      text.className = `${ROOT_CLASS}-text`;
      this.fillLine(text, this.lines[line - 1] ?? '', line - 1, highlighter);

      row.append(number, text);
      fragment.append(row);
    }
    this.code.replaceChildren(fragment);
    this.body.style.maxHeight = `${(this.last - this.first + 1) * LINE_HEIGHT}px`;
  }

  /** Разложить строку по токенам: те же классы ролей, что у редактора. */
  private fillLine(target: HTMLElement, text: string, line0: number, highlighter: LineHighlighter): void {
    const tokens = highlighter.tokensFor(line0);
    let cursor = 0;
    for (const token of tokens) {
      const start = Math.max(token.start, 0);
      if (start > cursor) target.append(document.createTextNode(text.slice(cursor, start)));
      const end = Math.min(token.end, text.length);
      if (end <= start) continue;
      const role = roleOfToken(token.type);
      const piece = text.slice(start, end);
      if (role) {
        const span = document.createElement('span');
        span.className = `own-editor-token-${role}`;
        span.textContent = piece;
        target.append(span);
      } else {
        target.append(document.createTextNode(piece));
      }
      cursor = end;
    }
    if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
  }

  /** Поставить копию под якорем: снизу места нет — `placePopup` поднимет наверх. */
  private position(anchor: PeekAnchor): void {
    const rows = this.last - this.first + 1;
    const height = HEADER_HEIGHT + rows * LINE_HEIGHT + 8;
    const placement = placePopup({
      // Правый край якоря совпадает с левым — окно растёт вправо от строки.
      anchor: { top: anchor.top, left: anchor.left, right: anchor.left, bottom: anchor.bottom },
      size: { width: WIDTH, height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: 2,
      align: 'start',
    });
    this.root.style.left = `${placement.left}px`;
    this.root.style.top = `${placement.top}px`;
    this.root.style.width = `${WIDTH}px`;
  }

  /** Прокрутить копию так, чтобы нужная строка была видна. */
  private scrollToTarget(): void {
    const row = this.code.querySelector<HTMLElement>(`.${ROOT_CLASS}-row.is-target`);
    if (!row) return;
    // Нужная строка стоит не в самом верху: контекст над ней должен быть виден.
    this.body.scrollTop = Math.max(0, row.offsetTop - LINE_HEIGHT * 2);
  }

  /** Цвета токенов — переменными на корне копии: как у редактора (см. `editor-view.ts`). */
  private applyTheme(): void {
    const palette = paletteOf();
    for (const [role, color] of Object.entries(palette)) {
      this.root.style.setProperty(`--own-token-${role}`, color);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Маленькая кнопка заголовка: вид один, отличается только классом. */
function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `own-editor-peek-btn ${className}`;
  node.textContent = label;
  node.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}
