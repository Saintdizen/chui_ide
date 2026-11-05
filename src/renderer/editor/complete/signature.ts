/**
 * Подсказка о параметрах вызова: когда её показать, у кого спросить и когда убрать.
 *
 * Ответ и разбор лежат в `shared/lsp-signature.ts`, показ — в `widgets/signature-widget.ts`.
 * Этот модуль решает КОГДА, и это как раз то поведение, которое человек замечает:
 *
 *   • набрал `(` или `,` — спросили сервер и показали карточку (открыли вызов или
 *     перешли к следующему доводу);
 *   • набрал `)` — карточка закрылась: вызов закончен;
 *   • ушёл строкой ниже или на другое место — карточка не висит над чужим вызовом;
 *   • внутри строк и комментариев не показывается: там скобка — это текст, а не вызов.
 *
 * Совсем без языкового сервера подсказки нет: сигнатуру своей грамматикой не вывести,
 * и выдумывать её — врать человеку. Поэтому источник даёт вызывающий, а не задан —
 * слоя просто нет.
 *
 * Роль знака под курсором берём у подсветки (`view.tokenTypeAt`) — второй таблицы
 * «где мы находимся» держать не нужно.
 */

import { signatureTrigger, type SignatureContext, type SignatureHelp } from '../../../shared/lsp-signature';
import { COMMENT, STRING } from '../highlight/tokens';
import type { TextBuffer } from '../core/text-buffer';
import type { EditorChange, EditorController } from '../input/editor-controller';
import type { KeyInterceptor } from '../input/editor-input';
import type { EditorView } from '../view/editor-view';
import type { SignatureWidget } from '../widgets/signature-widget';

export interface SignatureAssistantOptions {
  /**
   * Ответ сервера на позицию курсора (1-based). `null` — сказать нечего. Обязателен:
   * без источника подсказку не показать, и слой не создаётся.
   */
  source: (
    path: string,
    position: { line: number; column: number },
    context: SignatureContext,
  ) => Promise<SignatureHelp | null>;
  /** Активный файл (`null` — панель пуста): по нему адресуем запрос серверу. */
  path: () => string | null;
}

/** Чем вызвано решение спросить сервер: знаком-триггером, правкой в вызове или командой. */
type RequestReason = { kind: 'trigger'; character: string } | { kind: 'content' } | { kind: 'manual' };

export class SignatureAssistant implements KeyInterceptor {
  private readonly view: EditorView;
  private readonly controller: EditorController;
  private readonly widget: SignatureWidget;
  private readonly source: SignatureAssistantOptions['source'];
  private readonly path: () => string | null;
  private buffer: TextBuffer;
  /** Номер запроса: ответ на прежнее место не показываем, если курсор уехал. */
  private requestId = 0;
  /** Строка, где показана карточка: ушли на другую — карточка уже не про этот вызов. */
  private shownLine = -1;
  /** Что показано: уходит серверу в контексте, чтобы он не прислал то же второй раз. */
  private shownHelp: SignatureHelp | null = null;
  private requests = 0;
  private dismissed = 0;

  constructor(
    view: EditorView,
    controller: EditorController,
    buffer: TextBuffer,
    widget: SignatureWidget,
    options: SignatureAssistantOptions,
  ) {
    this.view = view;
    this.controller = controller;
    this.buffer = buffer;
    this.widget = widget;
    this.source = options.source;
    this.path = options.path;
  }

  /** Новый документ: подсказка о прежнем вызове к нему не относится. */
  setBuffer(buffer: TextBuffer): void {
    this.buffer = buffer;
    this.hide();
  }

  get isVisible(): boolean {
    return this.widget.isVisible;
  }

  /** Сколько раз спросили сервер, сколько раз показали и что показано — для проб. */
  get diagnostics(): { requests: number; shown: number; dismissed: number; signatures: number } {
    return {
      requests: this.requests,
      shown: this.widget.diagnostics.shows,
      dismissed: this.dismissed,
      signatures: this.widget.diagnostics.signatures,
    };
  }

  /** Клавиши карточки (стрелки листают подписи, Escape закрывает) — раньше редактора. */
  handleKey(event: KeyboardEvent): boolean {
    return this.widget.handleKey(event);
  }

  /**
   * Показать подсказку по команде (`Ctrl+Shift+Space`), а не по знаку-триггеру.
   *
   * Человек зовёт карточку сам — например, вернулся в готовый вызов и хочет понять,
   * какой довод сейчас. Значит не смотрим на последний набранный знак (его могло и не
   * быть), достаточно того, что курсор не в строке/комментарии: там вызова нет, и
   * врать карточкой не надо. Повторный зов на уже открытой карточке — это запрос
   * заново (`triggerKind: 1`), а не перелистывание: так VS Code и делает.
   */
  trigger(): void {
    const caret = this.controller.caret;
    const tokenType = this.view.tokenTypeAt(caret);
    if (tokenType === STRING || tokenType === COMMENT) {
      this.hide();
      return;
    }
    void this.request(caret, { kind: 'manual' });
  }

  /** Текст изменился: решаем, спросить подсказку, оставить или закрыть. */
  onChange(change: EditorChange): void {
    if (change.kind === 'selection') {
      this.hide();
      return;
    }
    const caret = this.controller.caret;
    // В строке или комментарии вызова нет — там скобка это текст.
    const tokenType = this.view.tokenTypeAt(caret);
    if (tokenType === STRING || tokenType === COMMENT) {
      this.hide();
      return;
    }
    const before = this.buffer.getText(Math.max(0, caret - 1), caret);
    const action = signatureTrigger(before);
    if (action === 'dismiss') {
      this.hide();
      return;
    }
    if (action === 'request') {
      void this.request(caret, { kind: 'trigger', character: before });
      return;
    }
    // Прочая правка: карточка живёт, пока курсор на той же строке, — иначе она над чужим
    // вызовом и вводит в заблуждение.
    if (this.widget.isVisible && this.buffer.lineAt(caret) !== this.shownLine) {
      this.hide();
      return;
    }
    // Дописали символ довода при открытой карточке — номер довода мог смениться (`f(a, b`).
    if (this.widget.isVisible) void this.request(caret, { kind: 'content' });
  }

  /** Спросить сервер и показать карточку, если ответ ещё про текущее место. */
  private async request(caret: number, reason: RequestReason): Promise<void> {
    const path = this.path();
    if (!path) {
      this.hide();
      return;
    }
    const id = ++this.requestId;
    this.requests += 1;
    const position = this.buffer.positionAt(caret);
    let help: SignatureHelp | null = null;
    try {
      help = await this.source(path, position, this.contextAt(caret, position, reason));
    } catch {
      // Сервер недоступен — молчания достаточно: карточки не будет.
      return;
    }
    if (id !== this.requestId || this.controller.caret !== caret) return;
    if (!help) {
      this.hide();
      return;
    }
    this.shownLine = this.buffer.lineAt(caret);
    this.shownHelp = help;
    this.widget.show(help, this.anchor(caret));
  }

  private hide(): void {
    if (this.widget.isVisible) this.dismissed += 1;
    this.requestId += 1;
    this.shownLine = -1;
    this.shownHelp = null;
    this.widget.hide();
  }

  /**
   * Контекст вызова для сервера: чем он вызван, что уже показано и строка до каретки.
   * По контексту сервер перебирает перегрузки (`f(a, b` — второй довод) и не шлёт
   * заново то, что уже показал.
   */
  private contextAt(
    caret: number,
    position: { line: number; column: number },
    reason: RequestReason,
  ): SignatureContext {
    const lineStart = this.buffer.lineStart(position.line);
    const head =
      reason.kind === 'trigger'
        ? { triggerKind: 2 as const, triggerCharacter: reason.character }
        : reason.kind === 'manual'
          ? { triggerKind: 1 as const }
          : { triggerKind: 3 as const };
    return {
      ...head,
      isRetrigger: this.shownHelp !== null,
      activeSignatureHelp: this.shownHelp ?? undefined,
      text: this.buffer.getText(lineStart, caret),
    };
  }

  /** Где каретка: карточку показываем у неё, а не у края окна. */
  private anchor(offset: number): { left: number; top: number; bottom: number } {
    const point = this.view.clientPoint(offset);
    return { left: point.left, top: point.top, bottom: point.bottom };
  }

  dispose(): void {
    this.widget.dispose();
  }
}
