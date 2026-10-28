/**
 * Попап подсказок: список того, что можно вставить.
 *
 * Виджет — только вид и клавиши. Что в списке — решает `complete/completions.ts`, а
 * куда вставить — вызывающий (в приложении это связка ввода с контроллером). Так попап
 * можно переставить или переоформить, не трогая подбор слов.
 *
 * Показывается рядом с кареткой, а не у края экрана: глаз уже там, где он печатает.
 * Если снизу места нет, попап раскрывается ВВЕРХ — правило позиционирования берётся из
 * `core/popup-placement.ts`, общего для всех наших попапов: попап, вылезший за край окна,
 * бесполезен, его содержимое просто не видно.
 *
 * Клавиши попап обрабатывает сам и говорит об этом вводу (`handleKey`): стрелки вверх и
 * вниз при видимом списке должны ходить по списку, а не двигать курсор. Поэтому ввод
 * спрашивает попап прежде, чем браться за клавишу сам.
 */

import { placePopup } from '../../core/popup-placement';
import type { CompletionItem } from '../complete/completions';

/** Сколько строк показываем без прокрутки — дальше список прокручивается. */
const MAX_VISIBLE = 10;
/** Высота строки списка и его ширина: попап ставим до отрисовки, размеры нужны заранее. */
const ROW_HEIGHT = 20;
const WIDTH = 280;

export interface SuggestAnchor {
  /** Координаты каретки в системе окна. */
  left: number;
  top: number;
  bottom: number;
}

export class SuggestWidget {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private items: CompletionItem[] = [];
  private selected = 0;
  private visible = false;
  private prefixLength = 0;
  /** Где показан список: по нему пересчитываем место, когда список дописывается. */
  private anchor: SuggestAnchor | null = null;

  /** Что делать при выборе мышью. Задаёт тот, кто виджет создал. */
  onAccept: (() => void) | null = null;
  /**
   * Выделилась другая строка — сюда приходит она. Так список доводит подсказку
   * опозданием (`completionItem/resolve`), а не тянет описания сразу для всех.
   */
  onSelect: ((item: CompletionItem) => void) | null = null;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'own-editor-suggest';
    this.root.hidden = true;
    this.root.setAttribute('role', 'listbox');

    this.list = document.createElement('div');
    this.list.className = 'own-editor-suggest-list';
    this.root.append(this.list);
    host.append(this.root);

    // Мышь: наведение выбирает строку, щелчок вставляет — как в любом списке.
    this.list.addEventListener('mousemove', this.onMouseMove);
    this.list.addEventListener('mousedown', this.onMouseDown);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Выбранная подсказка или `null`, если списка нет. */
  get current(): CompletionItem | null {
    return this.visible ? (this.items[this.selected] ?? null) : null;
  }

  /**
   * Все строки списка — для подмешивания ответа сервера языка (см. `assistant.ts`).
   * Отдаём как есть: список пересобирается целиком, копия тут ни к чему.
   */
  get allItems(): readonly CompletionItem[] {
    return this.items;
  }

  /** Сколько набранных знаков заменит вставка: их сообщил тот, кто показал список. */
  get replaces(): number {
    return this.prefixLength;
  }

  /**
   * Показать список у каретки. `anchor` — где стоит каретка, `prefixLength` — сколько
   * знаков перед ней набрано (их и заменит вставка).
   */
  show(items: readonly CompletionItem[], anchor: SuggestAnchor, prefixLength: number): void {
    if (items.length === 0) {
      this.hide();
      return;
    }
    // Место запоминаем: список дописывается позже (импорт, ответ сервера), и после
    // дописывания строк стало больше — попап мог вылезти за край, тогда его перевернём.
    this.anchor = anchor;
    this.items = [...items];
    // Выделено всегда первое: обычно оно и нужное, а выбор стрелкой — уже уточнение.
    this.selected = 0;
    this.prefixLength = prefixLength;
    this.visible = true;
    this.root.hidden = false;
    this.render();
    this.position(anchor);
    this.notifySelect();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.items = [];
    this.anchor = null;
  }

  /** Подписи текущего списка: по ним вызывающий не добавляет то, что уже показано. */
  labels(): string[] {
    return this.items.map((item) => item.label);
  }

  /**
   * Дописать элементы в конец списка. Выбор и место не меняются: список расширяют,
   * когда человек просит шире (повторный Ctrl+Space), — и он не должен терять строку,
   * на которой стоял, из-за пришедшего ответа.
   */
  append(items: readonly CompletionItem[]): void {
    if (items.length === 0) return;
    this.items = [...this.items, ...items];
    if (!this.visible) return;
    this.render();
    // Строк стало больше — высота другая, место пересчитываем от той же каретки.
    if (this.anchor) this.position(this.anchor);
  }

  /** Передвинуть выбор. По краям не заворачиваем: конец списка должен быть заметен. */
  move(delta: number): void {
    if (!this.visible || this.items.length === 0) return;
    const next = Math.max(0, Math.min(this.selected + delta, this.items.length - 1));
    if (next === this.selected) return;
    this.selected = next;
    this.highlight();
    this.ensureVisible();
    this.notifySelect();
  }

  /** Сообщить, что выделена другая строка (для дотягивания описания). */
  private notifySelect(): void {
    const item = this.items[this.selected];
    if (item) this.onSelect?.(item);
  }

  /**
   * Дописать строке списка пояснение и описание, не пересобирая список. Так приходит
   * ответ `completionItem/resolve`: список и выделение остаются на месте.
   */
  patch(item: CompletionItem, update: { detail?: string; documentation?: string }): void {
    const index = this.items.indexOf(item);
    if (index < 0) return;
    const next = { ...item, ...update };
    this.items[index] = next;
    const row = this.list.children[index] as HTMLElement | undefined;
    if (!row) return;
    const detail = row.querySelector('.own-editor-suggest-detail');
    if (detail instanceof HTMLElement && next.detail) detail.textContent = next.detail;
    renderDoc(row, next);
  }

  /**
   * Обработать клавишу раньше редактора. `true` — клавиша наша. Стрелки, Enter, Tab и
   * Escape работают со списком; всё остальное уходит в редактор, и попап сам закроется
   * при следующем изменении текста (ввод об этом сообщит).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.visible) return false;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.move(1);
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.move(-1);
        return true;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        this.onAccept?.();
        return true;
      case 'Escape':
        event.preventDefault();
        this.hide();
        return true;
      default:
        return false;
    }
  }

  private render(): void {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < this.items.length; index += 1) {
      fragment.append(this.row(this.items[index]!, index));
    }
    this.list.replaceChildren(fragment);
  }

  private row(item: CompletionItem, index: number): HTMLElement {
    const node = document.createElement('div');
    node.className = index === this.selected ? 'own-editor-suggest-item is-active' : 'own-editor-suggest-item';
    node.setAttribute('role', 'option');
    node.dataset.index = String(index);

    const label = document.createElement('span');
    label.className = 'own-editor-suggest-label';
    // Совпавшие с набранным знаки выделяем: по ним сразу видно, ПОЧЕМУ
    // строка в списке, а при совпадении по «горбам» это единственная подсказка об этом.
    renderLabel(label, item);

    const detail = document.createElement('span');
    // Вид подсказки красим классом: значок в списке — по нему, а не по тексту.
    detail.className = `own-editor-suggest-detail is-${item.kind}`;
    detail.textContent = item.detail;

    // Описание символа — своей строкой под подписью: появляется после resolve.
    const doc = document.createElement('span');
    doc.className = 'own-editor-suggest-doc';

    node.append(label, detail, doc);
    renderDoc(node, item);
    return node;
  }

  /** Обновить только выделение: перерисовка списка на каждую стрелку не нужна. */
  private highlight(): void {
    const rows = this.list.children;
    for (let index = 0; index < rows.length; index += 1) {
      rows[index]!.classList.toggle('is-active', index === this.selected);
    }
  }

  /** Прокрутить список так, чтобы выбранная строка была видна. */
  private ensureVisible(): void {
    const row = this.list.children[this.selected] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (bottom > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = bottom - this.list.clientHeight;
    }
  }

  /** Поставить попап у каретки: снизу, если есть место, иначе сверху. */
  private position(anchor: SuggestAnchor): void {
    // Сначала потолок списка, потом мера: иначе у длинного списка `scrollHeight`
    // вернул бы высоту всех строк и попап уезжал бы с экрана.
    this.list.style.maxHeight = `${MAX_VISIBLE * ROW_HEIGHT}px`;
    const height = this.measuredHeight();
    const placement = placePopup({
      // Правый край якоря совпадает с левым — попап растёт вправо от каретки.
      anchor: { top: anchor.top, left: anchor.left, right: anchor.left, bottom: anchor.bottom },
      size: { width: WIDTH, height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: 2,
      align: 'start',
    });
    this.root.style.left = `${placement.left}px`;
    this.root.style.top = `${placement.top}px`;
  }

  /**
   * Высота попапа по факту отрисовки, а не по арифметике из `ROW_HEIGHT`.
   *
   * Высоту строки задаёт CSS (`min-height` плюс отступы), и правка стиля тянула бы
   * за собой константу в этом файле — попап переворачивался бы не там. Мера берётся
   * у списка, которому уже поставлен потолок `max-height` (см. `position`), — иначе у
   * длинного списка вернулась бы высота всех строк. В jsdom без раскладки мера — 0,
   * поэтому там остаётся расчёт.
   */
  private measuredHeight(): number {
    const measured = this.list.scrollHeight;
    if (measured > 0) return measured;
    return Math.min(this.items.length, MAX_VISIBLE) * ROW_HEIGHT + 8;
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    const index = this.rowIndexAt(event.target);
    if (index < 0 || index === this.selected) return;
    this.selected = index;
    this.highlight();
    this.notifySelect();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    // Гасим нажатие: иначе фокус уйдёт из редактора и попап закроется до вставки.
    event.preventDefault();
    const index = this.rowIndexAt(event.target);
    if (index < 0) return;
    this.selected = index;
    this.onAccept?.();
  };

  /** Номер строки списка под узлом события; `-1` — не по строке попали. */
  private rowIndexAt(target: EventTarget | null): number {
    if (!(target instanceof HTMLElement)) return -1;
    const row = target.closest<HTMLElement>('.own-editor-suggest-item');
    if (!row) return -1;
    return Number(row.dataset.index ?? '-1');
  }

  dispose(): void {
    this.list.removeEventListener('mousemove', this.onMouseMove);
    this.list.removeEventListener('mousedown', this.onMouseDown);
    this.root.remove();
  }
}

/**
 * Подпись строки: совпавшие знаки — отдельным куском, остальное — как есть. Так в списке
 * видно, что именно совпало с набранным (совпадение выделено жирным).
 * Без `positions` (серверные подсказки, Ctrl+Space) подпись рисуется целиком.
 */
function renderLabel(node: HTMLElement, item: CompletionItem): void {
  const positions = item.positions;
  if (!positions || positions.length === 0) {
    node.textContent = item.label;
    return;
  }
  const marked = new Set(positions);
  const fragment = document.createDocumentFragment();
  let plain = '';
  const flush = (): void => {
    if (plain.length === 0) return;
    fragment.append(document.createTextNode(plain));
    plain = '';
  };
  for (let index = 0; index < item.label.length; index += 1) {
    if (marked.has(index)) {
      flush();
      const span = document.createElement('span');
      span.className = 'own-editor-suggest-match';
      span.textContent = item.label[index]!;
      fragment.append(span);
    } else {
      plain += item.label[index]!;
    }
  }
  flush();
  node.replaceChildren(fragment);
}

/**
 * Описание символа под подписью: одна строка в списке, полный текст — в подсказке.
 * Появляется только после `completionItem/resolve` — до него описания ещё нет.
 */
function renderDoc(row: HTMLElement, item: CompletionItem): void {
  const doc = row.querySelector('.own-editor-suggest-doc');
  if (!(doc instanceof HTMLElement)) return;
  const full = item.documentation ?? '';
  const first =
    full
      .split('\n')
      .find((part) => part.trim().length > 0)
      ?.trim() ?? '';
  doc.textContent = first;
  doc.hidden = first.length === 0;
  if (first) doc.title = full;
}
