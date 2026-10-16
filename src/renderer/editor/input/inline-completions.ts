/**
 * Подсказка «допиши за меня» (inline-автодополнение) для своего редактора.
 *
 * Модель дописывает код в месте курсора, а редактор показывает это призрачным текстом
 * (серым, будто уже набранным) — ровно так же, как это делал прежний движок. Здесь живёт
 * ПОВЕДЕНИЕ: когда спросить, что сделать с ответом и как принять подсказку. Показ
 * призрачного текста — дело представления (`view/editor-view.ts`), сборка промпта и
 * очистка ответа — общих модулей (`shared/inline-ai.ts`), а сам запрос к модели —
 * `rpc` в приложении (main спрашивает провайдера).
 *
 * Слой — перехватчик ввода (`KeyInterceptor`): пока призрачный текст виден, Tab его
 * принимает, Escape убирает. Остальные клавиши уходят редактору, и подсказка гаснет
 * на первом же изменении текста или курсора — она говорила о прежнем месте.
 *
 * Задержка — не украшение: подсказку нельзя спрашивать на каждое нажатие. Пока идёт
 * пауза, человек печатает дальше — и старый ответ теряет смысл. Поэтому у каждого
 * запроса есть номер, и ответ показывается, только если номер ещё актуален и курсор
 * не уехал: чужой текст в подсказке был бы хуже, чем никакой.
 *
 * Модуль почти чист: он не знает ни о DOM, ни о `rpc` — только о «представлении» и
 * «контроллере» в узком смысле (призрачный текст, курсор, вставка). Поэтому его видно
 * в тестах с подставными двойниками и ручным планировщиком задержки.
 */

import { cleanCompletion, inlineContext } from '../../../shared/inline-ai';
import type { EditorChange } from './editor-controller';

/** Что слою нужно от представления: показать или убрать призрачный текст. */
export interface GhostView {
  setGhostText(offset: number, text: string): void;
  clearGhostText(): void;
}

/** Что слою нужно от контроллера: где курсор, текст и как вставить принятое. */
export interface GhostController {
  readonly caret: number;
  readonly bufferRef: {
    readonly text: string;
    positionAt(offset: number): { line: number; column: number };
  };
  applyEdit(edit: { start: number; removed: string; inserted: string }): void;
}

export interface InlineCompletionOptions {
  /** Включено ли автодополнение сейчас (настройка `ai.inlineCompletion.enabled`). */
  enabled(): boolean;
  /** Пауза после последнего ввода перед запросом, мс: на каждую букву не спрашиваем. */
  debounceMs(): number;
  /** Запрос к модели: контекст вокруг курсора → готовый текст. `null`/пусто — подсказки нет. */
  complete(prefix: string, suffix: string): Promise<string | null>;
  /** Планировщик задержки. По умолчанию `setTimeout`; в тестах — ручной (без часов). */
  schedule?(run: () => void, ms: number): () => void;
}

/** Задержка на `setTimeout`; возвращает функцию отмены. */
function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = window.setTimeout(run, ms);
  return () => window.clearTimeout(timer);
}

export class InlineCompletions {
  private readonly view: GhostView;
  private readonly controller: GhostController;
  private readonly options: InlineCompletionOptions;
  private readonly schedule: (run: () => void, ms: number) => () => void;

  /** Видимая подсказка: место (смещение каретки) и текст. `null` — не показываем. */
  private suggestion: { offset: number; text: string } | null = null;
  /** Отмена текущей паузы. `null` — пауза не идёт. */
  private cancelTimer: (() => void) | null = null;
  /** Номер запроса: ответ показываем, только если он всё ещё про текущее место. */
  private requestId = 0;
  /** Правку приняли мы сами — следующий отклик на неё не должен порождать новый запрос. */
  private suppressNext = false;

  // — счётчики для проб и тестов —
  private requests = 0;
  private shown = 0;
  private accepts = 0;
  private dismisses = 0;

  constructor(view: GhostView, controller: GhostController, options: InlineCompletionOptions) {
    this.view = view;
    this.controller = controller;
    this.options = options;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Виден ли призрачный текст. */
  get isVisible(): boolean {
    return this.suggestion !== null;
  }

  /** Текст подсказки (`null` — не показываем). */
  get text(): string | null {
    return this.suggestion?.text ?? null;
  }

  /** Сколько запросов, показов, принятий и снятий видел слой — для пробы и отладки. */
  get diagnostics(): { requests: number; shown: number; accepts: number; dismisses: number } {
    return { requests: this.requests, shown: this.shown, accepts: this.accepts, dismisses: this.dismisses };
  }

  /** Сменили документ: подсказка о прежнем файле больше не годится. */
  setBuffer(): void {
    this.dismiss();
  }

  /**
   * Текст или курсор изменились. Прежняя подсказка гаснет (она о прошлом месте), и —
   * если автодополнение включено — заводится новая пауза перед запросом.
   */
  onChange(_change: EditorChange): void {
    // Приняли подсказку — правка наша: гаснет без нового запроса, иначе подсказка
    // вылезала бы снова и снова на том же месте.
    if (this.suppressNext) {
      this.suppressNext = false;
      this.dismiss();
      return;
    }
    this.dismiss();
    if (!this.options.enabled()) return;
    this.startTimer();
  }

  /**
   * Обработать клавишу раньше редактора. `true` — клавиша наша: Tab принимает
   * подсказку (обычный, без Shift — Shift+Tab остаётся снятием отступа), Escape
   * убирает. Без видимой подсказки обе клавиши уходят редактору как обычно.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.suggestion) return false;
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      this.accept();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismiss();
      return true;
    }
    return false;
  }

  /** Убрать подсказку и обесценить ответы в полёте. */
  dismiss(): void {
    this.requestId += 1;
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    if (this.suggestion) {
      this.suggestion = null;
      this.view.clearGhostText();
      this.dismisses += 1;
    }
  }

  private startTimer(): void {
    const delay = Math.max(0, this.options.debounceMs());
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      void this.request();
    }, delay);
  }

  /** Сходить к модели за подсказкой и показать ответ, если он ещё актуален. */
  private async request(): Promise<void> {
    const caret = this.controller.caret;
    const buffer = this.controller.bufferRef;
    const position = buffer.positionAt(caret);
    const { prefix, suffix } = inlineContext(buffer.text, position);
    // Пустой контекст — подсказывать нечего, а запрос всё равно стоил бы денег.
    if (!prefix.trim() && !suffix.trim()) return;

    const id = ++this.requestId;
    this.requests += 1;

    let text: string | null = null;
    try {
      text = await this.options.complete(prefix, suffix);
    } catch {
      // Модель недоступна, ключа нет, выключено — подсказки просто нет.
      return;
    }

    // Пока ждали ответ, курсор уехал или пришёл новый запрос — старую подсказку не показываем.
    if (id !== this.requestId || this.controller.caret !== caret) return;
    const clean = text ? cleanCompletion(text) : '';
    if (!clean) return;

    this.suggestion = { offset: caret, text: clean };
    this.view.setGhostText(caret, clean);
    this.shown += 1;
  }

  /** Принять подсказку: вставить её текст в курсор обычной правкой (Ctrl+Z вернёт). */
  private accept(): void {
    const suggestion = this.suggestion;
    if (!suggestion) return;
    this.dismiss();
    this.accepts += 1;
    // Своя правка не должна сама звать новый запрос — иначе подсказка вернётся на том же месте.
    this.suppressNext = true;
    this.controller.applyEdit({ start: suggestion.offset, removed: '', inserted: suggestion.text });
  }
}
