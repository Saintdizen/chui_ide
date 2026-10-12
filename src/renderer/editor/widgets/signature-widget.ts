/**
 * Карточка подсказки о параметрах вызова: сигнатура с подсвеченным активным доводом.
 *
 * Виджет — только вид и клавиши. Что за подпись и какой довод активен, решает разбор
 * в `shared/lsp-signature.ts`; когда карточку показать — дело `complete/signature.ts`.
 * Так карточку можно переоформить, не трогая разбор ответа сервера.
 *
 * Стоит в системе окна, а не внутри полотна: попап, помещённый в полотно, ехал бы
 * вместе с прокруткой. Материал и место — как у попапа подсказок (общий
 * `core/popup-placement.ts`): попап у края окна раскрывается в другую сторону.
 *
 * Перегрузок у вызова бывает несколько: активную выбирают стрелками вверх-вниз, о
 * счётчике «1 из 3» карточка говорит сама.
 */

import { placePopup } from '../../core/popup-placement';
import { signatureParts, type SignatureHelp, type SignatureInfo } from '../../../shared/lsp-signature';
import type { SuggestAnchor } from './suggest-widget';

/** Сколько символов документации показываем — дальше обрезаем многоточием. */
const DOC_LIMIT = 160;

export class SignatureWidget {
  private readonly root: HTMLElement;
  private help: SignatureHelp | null = null;
  /** Какая подпись показана: сервер назвал активную, стрелки её передвигают. */
  private selected = 0;
  private visible = false;
  /** Сколько раз карточку показали и сколько раз перелистали — для проб. */
  private shows = 0;
  private turns = 0;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'own-editor-signature';
    this.root.hidden = true;
    host.append(this.root);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Текущая подпись (по ней видно, что показано) — для проб и тестов. */
  get current(): SignatureInfo | null {
    return this.help ? (this.help.signatures[this.selected] ?? null) : null;
  }

  get diagnostics(): { shows: number; turns: number; signatures: number; activeParameter: number } {
    return {
      shows: this.shows,
      turns: this.turns,
      signatures: this.help?.signatures.length ?? 0,
      activeParameter: this.help && this.selected === this.help.activeSignature ? this.help.activeParameter : -1,
    };
  }

  /** Показать карточку у каретки. Активная подпись и довод берутся из разбора. */
  show(help: SignatureHelp, anchor: SuggestAnchor): void {
    this.help = help;
    this.selected = help.activeSignature;
    this.visible = true;
    this.shows += 1;
    this.render();
    this.position(anchor);
  }

  hide(): void {
    this.visible = false;
    this.help = null;
    this.root.hidden = true;
  }

  /**
   * Обработать клавишу раньше редактора. Стрелки листают подписи, Escape закрывает;
   * остальное уходит в текст — и карточка сама закроется, если вызов закончился.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.visible) return false;
    const count = this.help?.signatures.length ?? 0;
    switch (event.key) {
      case 'ArrowDown':
        if (count > 1) {
          event.preventDefault();
          this.turn(1);
          return true;
        }
        return false;
      case 'ArrowUp':
        if (count > 1) {
          event.preventDefault();
          this.turn(-1);
          return true;
        }
        return false;
      case 'Escape':
        event.preventDefault();
        this.hide();
        return true;
      default:
        return false;
    }
  }

  /** Перелистнуть подпись по кругу: за последней снова первая. */
  private turn(delta: number): void {
    const count = this.help?.signatures.length ?? 0;
    if (count === 0) return;
    this.selected = (this.selected + delta + count) % count;
    this.turns += 1;
    this.render();
  }

  private render(): void {
    const signature = this.current;
    if (!signature) {
      this.root.replaceChildren();
      return;
    }
    const active = this.selected === this.help!.activeSignature ? this.help!.activeParameter : -1;

    const label = document.createElement('div');
    label.className = 'own-editor-signature-label';
    for (const part of signatureParts(signature, active)) {
      const span = document.createElement('span');
      if (part.active) span.className = 'is-active';
      span.textContent = part.text;
      label.append(span);
    }
    this.root.replaceChildren(label);

    if (signature.documentation) {
      const doc = document.createElement('div');
      doc.className = 'own-editor-signature-doc';
      doc.textContent = truncate(firstParagraph(signature.documentation), DOC_LIMIT);
      this.root.append(doc);
    }

    const count = this.help!.signatures.length;
    if (count > 1) {
      const counter = document.createElement('div');
      counter.className = 'own-editor-signature-count';
      counter.textContent = `${this.selected + 1} из ${count} · ↑↓`;
      this.root.append(counter);
    }
  }

  /** Поставить карточку у каретки: снизу, если есть место, иначе сверху. */
  private position(anchor: SuggestAnchor): void {
    this.root.hidden = false;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const placement = placePopup({
      anchor: { top: anchor.top, left: anchor.left, right: anchor.left, bottom: anchor.bottom },
      size: { width, height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: 2,
      align: 'start',
    });
    this.root.style.left = `${placement.left}px`;
    this.root.style.top = `${placement.top}px`;
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Первый абзац документации: остальное в карточку не помещается. */
function firstParagraph(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/\n\s*\n/);
  return end < 0 ? trimmed.split('\n')[0]! : trimmed.slice(0, end);
}

/** Обрезать длинную строку по границе слова. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
