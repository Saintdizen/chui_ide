/**
 * Попап списка мест: куда ведёт определение и где нашлись ссылки.
 *
 * Языковой сервер отвечает на переход не одним местом, а списком — определение бывает
 * и у нескольких перегрузок, а ссылок обычно десятки. Показывать такой ответ надо
 * списком, из которого выбирают: у готового движка был свой виджет, здесь — этот.
 *
 * Виджет — только вид и клавиши. Что в списке, решает вызывающий (`host/symbol-navigation.ts`),
 * а куда перейти — тоже он: попап лишь сообщает о выборе. Так его видно в пробе и не
 * приходится тащить в него ни языковой сервер, ни открытие файлов.
 *
 * Показывается у каретки: глаз уже там, где вызвали переход. Снизу места нет —
 * раскрывается вверх; правило позиционирования общее — `core/popup-placement.ts`.
 */

import type { SymbolLocation } from '../../../shared/lsp-locations';
import { placePopup } from '../../core/popup-placement';

/** Строка списка: куда перейти и как это показать. */
export interface LocationRow {
  /** Основная подпись — обычно путь файла (короткий). */
  label: string;
  /** Пояснение справа — строка и столбец места. */
  detail: string;
  /** Куда перейти при выборе. */
  target: SymbolLocation;
}

/** Где поставить попап: левый край, верх и низ каретки в системе окна. */
export interface LocationsAnchor {
  left: number;
  top: number;
  bottom: number;
}

/** Сколько строк показываем без прокрутки — дальше список прокручивается. */
const MAX_VISIBLE = 8;
/** Высота строки списка и заголовка: попап ставим до отрисовки, размеры нужны заранее. */
const ROW_HEIGHT = 20;
const TITLE_HEIGHT = 22;
const WIDTH = 340;

export class LocationsWidget {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly list: HTMLElement;
  private rows: LocationRow[] = [];
  private selected = 0;
  private visible = false;

  /** Что делать при выборе строки (мышью или Enter). Задаёт тот, кто виджет создал. */
  onAccept: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'own-editor-locations';
    this.root.hidden = true;
    this.root.setAttribute('role', 'listbox');

    this.title = document.createElement('div');
    this.title.className = 'own-editor-locations-title';

    this.list = document.createElement('div');
    this.list.className = 'own-editor-locations-list';

    this.root.append(this.title, this.list);
    host.append(this.root);

    // Мышь: наведение выбирает строку, щелчок переходит — как в любом списке.
    this.list.addEventListener('mousemove', this.onMouseMove);
    this.list.addEventListener('mousedown', this.onMouseDown);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Выбранная строка или `null`, если списка нет. */
  get current(): LocationRow | null {
    return this.visible ? (this.rows[this.selected] ?? null) : null;
  }

  /** Сколько мест в списке — по этому числу видно, ответил ли сервер. */
  get count(): number {
    return this.rows.length;
  }

  /** Показать список у каретки. Пустой список не показываем — это не список. */
  show(title: string, rows: readonly LocationRow[], anchor: LocationsAnchor): void {
    if (rows.length === 0) {
      this.hide();
      return;
    }
    this.rows = [...rows];
    // Выделено всегда первое: обычно оно и нужное, а выбор стрелкой — уже уточнение.
    this.selected = 0;
    this.visible = true;
    this.title.textContent = title;
    this.root.hidden = false;
    this.render();
    this.position(anchor);
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    this.rows = [];
  }

  /** Передвинуть выбор. По краям не заворачиваем: конец списка должен быть заметен. */
  move(delta: number): void {
    if (!this.visible || this.rows.length === 0) return;
    const next = Math.max(0, Math.min(this.selected + delta, this.rows.length - 1));
    if (next === this.selected) return;
    this.selected = next;
    this.highlight();
    this.ensureVisible();
  }

  /**
   * Обработать клавишу раньше редактора. `true` — клавиша наша. Стрелки, Enter, Tab и
   * Escape работают со списком; всё остальное уходит в редактор, и попап закроется при
   * следующем изменении (вызывающий сообщит об этом через `hide`).
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
    for (let index = 0; index < this.rows.length; index += 1) {
      fragment.append(this.row(this.rows[index]!, index));
    }
    this.list.replaceChildren(fragment);
  }

  private row(item: LocationRow, index: number): HTMLElement {
    const node = document.createElement('div');
    node.className = index === this.selected ? 'own-editor-locations-item is-active' : 'own-editor-locations-item';
    node.setAttribute('role', 'option');
    node.dataset.index = String(index);

    const label = document.createElement('span');
    label.className = 'own-editor-locations-label';
    label.textContent = item.label;

    const detail = document.createElement('span');
    detail.className = 'own-editor-locations-detail';
    detail.textContent = item.detail;

    node.append(label, detail);
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
  private position(anchor: LocationsAnchor): void {
    const height = Math.min(this.rows.length, MAX_VISIBLE) * ROW_HEIGHT + TITLE_HEIGHT + 8;
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
    this.list.style.maxHeight = `${MAX_VISIBLE * ROW_HEIGHT}px`;
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    const index = this.rowIndexAt(event.target);
    if (index < 0 || index === this.selected) return;
    this.selected = index;
    this.highlight();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    // Гасим нажатие: иначе фокус уйдёт из редактора и попап закроется до перехода.
    event.preventDefault();
    const index = this.rowIndexAt(event.target);
    if (index < 0) return;
    this.selected = index;
    this.onAccept?.();
  };

  /** Номер строки списка под узлом события; `-1` — не по строке попали. */
  private rowIndexAt(target: EventTarget | null): number {
    if (!(target instanceof HTMLElement)) return -1;
    const row = target.closest<HTMLElement>('.own-editor-locations-item');
    if (!row) return -1;
    return Number(row.dataset.index ?? '-1');
  }

  dispose(): void {
    this.list.removeEventListener('mousemove', this.onMouseMove);
    this.list.removeEventListener('mousedown', this.onMouseDown);
    this.root.remove();
  }
}
