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
 *
 * Внутри строк и комментариев карточки о слове нет: там это не код, и «встречается
 * 2 раза / впервые на строке 18» про литерал — шум, а не польза. Ровно то же правило
 * у автодополнения (`complete/assistant.ts`). Ответ языкового сервера при этом не
 * гасится: он может быть по делу и внутри строки.
 */

import { describeWord, wordInfoAt } from '../hover/word-info';
import { COMMENT, roleLabel, STRING } from '../highlight/tokens';
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

/**
 * Проблема (диагностика) в месте под курсором. Нужна потому, что волна под словом сама
 * по себе ничего не объясняет: человек видит подчёркивание и не знает, что не так.
 * Здесь — тот самый текст, который и надо прочитать.
 */
export interface HoverProblem {
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  /** Кто сообщил (`pyright`, `ts`, `chui`) — видно, к кому идти за подробностями. */
  readonly source?: string;
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
  /**
   * Проблемы (пометки языка, орфография) в месте под курсором — текст ошибки.
   * Показываются ПЕРВЫМИ: увидев волну, человек хочет прочитать, в чём дело.
   */
  problems?: (offset: number) => readonly HoverProblem[];
}

export class HoverWidget {
  private buffer: TextBuffer;
  private readonly view: EditorView;
  private readonly root: HTMLElement;
  private readonly sources: readonly ((offset: number) => Promise<HoverExternalInfo | null>)[];
  /** Пометки языка в месте под курсором (текст ошибки), если их дали. */
  private readonly problems: ((offset: number) => readonly HoverProblem[]) | undefined;
  /** Заголовок и строки уже показанной проблемы: сервер обязан их ДОПОЛНИТЬ, а не стереть. */
  private problemTitle: string | null = null;
  private problemLines: readonly string[] = [];
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
    this.problems = options.problems;

    this.root = document.createElement('div');
    this.root.className = 'own-editor-hover';
    this.root.hidden = true;
    // Попап живёт ВНЕ полотна редактора: у `.own-editor` стоит `contain: layout paint style`,
    // а `contain` делает элемент точкой отсчёта для `position: fixed`. Внутри редактора
    // подсказка уезжала бы на его смещение в окне: координаты мыши — оконные, а fixed
    // считался бы от редактора. Соседние попапы по той же причине крепятся к контейнеру
    // (см. `editor-host.ts`: подсказки, подпись, список мест).
    (view.element.parentElement ?? view.element).append(this.root);

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
    const tokenType = this.view.tokenTypeAt(offset);
    // Внутри строк и комментариев слова — не код: «встречается N раз / впервые на строке»
    // там только мешает (то же правило, что у автодополнения, см. `complete/assistant.ts`).
    const quiet = tokenType === STRING || tokenType === COMMENT;
    const role = roleLabel(tokenType);
    let shownLocal = false;
    // Проблемы этого места — то, что человек ищет, увидев волну: сам ТЕКСТ ошибки, а не
    // только подчёркивание. Показываем их первыми и даже там, где о самом слове сказать
    // нечего (в строке или комментарии пометка тоже бывает).
    const problems = this.problems ? this.problems(offset) : [];
    this.problemTitle = null;
    this.problemLines = [];
    if (problems.length > 0) {
      this.problemTitle = titleForProblem(problems[0]!);
      this.problemLines = linesForProblems(problems);
      this.show(this.problemTitle, this.problemLines, clientX, clientY);
      shownLocal = true;
    } else if (info && !quiet) {
      const worthShowing = role !== null || info.occurrences > 1 || info.declaredAt !== null;
      if (worthShowing) {
        const described = describeWord(info);
        const lines = role ? [role, ...described.lines] : described.lines;
        this.show(described.title, lines, clientX, clientY);
        shownLocal = true;
      }
    }
    // Прячем карточку, но НЕ отменяем запрос: «локально сказать нечего» — не значит,
    // что не ответит языковой сервер. `hide()` сдвинул бы `requestId` и заглушил ответ.
    if (!shownLocal) this.hideCard();

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
      const external = result.text.split('\n').map((line) => line.replace(/\s+$/, ''));
      // Текст проблемы остаётся СВЕРХУ: именно его ищут, увидев волну. Ответ сервера
      // (тип, сигнатура) идёт следом и не должен вытеснять сообщение об ошибке.
      const title = this.problemTitle ?? result.title ?? this.currentTitle ?? '';
      const lines = this.problemLines.length > 0 ? [...this.problemLines, '', ...external] : external;
      this.show(title, lines, clientX, clientY);
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

  /** Спрятать карточку, не отменяя запрос к источникам: так локальное молчание
   *  не гасит ответ языкового сервера (см. `showAt`). */
  private hideCard(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  hide(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.requestId += 1;
    this.hideCard();
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

/** Заголовок карточки проблемы: «Ошибка · pyright». */
function titleForProblem(problem: HoverProblem): string {
  const label = severityLabel(problem.severity);
  return problem.source ? `${label} · ${problem.source}` : label;
}

/** Степень важности словами: волна красная, жёлтая или синяя — а что это значит? */
function severityLabel(severity: HoverProblem['severity']): string {
  if (severity === 'error') return 'Ошибка';
  if (severity === 'warning') return 'Предупреждение';
  return 'Замечание';
}

/** Строки карточки: сообщения проблем. Несколько — со степенью важности и разрывом. */
function linesForProblems(problems: readonly HoverProblem[]): string[] {
  const lines: string[] = [];
  for (const problem of problems) {
    if (lines.length > 0) lines.push('');
    const marked = problems.length > 1 ? `${severityLabel(problem.severity)}: ` : '';
    for (const [index, line] of problem.message.split('\n').entries()) {
      lines.push(index === 0 ? `${marked}${line}` : line);
    }
  }
  return lines;
}
