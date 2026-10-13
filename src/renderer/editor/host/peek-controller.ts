/**
 * «Заглянуть в определение»: от запроса мест — до копии кода на месте.
 *
 * Языковой сервер отвечает списком мест, и каждый из них лежит в своём файле. Чтобы
 * показать копию, надо прочитать текст этого файла: у открытого он уже есть (в
 * документе), у прочего — с диска. Чтение и показ — разное дело, поэтому здесь только
 * связка: спросить, прочитать, отдать виджету; сам текст читает вызывающий (у
 * приложения есть и документы, и RPC).
 *
 * Мест бывает несколько (перегрузки, реализации). Держим список целиком и ходим по
 * нему стрелками: перезапрашивать сервер на каждый шаг незачем, а номер места
 * («2 из 5») виден в заголовке. Тексты файлов запоминаем на время показа — по одному
 * файлу может быть несколько мест.
 *
 * Ответы приходят асинхронно, а человек может жать стрелки быстрее, чем сервер
 * ответит: поэтому у каждого показа свой номер, и ответ «не на текущий показ»
 * выбрасывается. Иначе копия от предыдущего места затирала бы свежую.
 */

import type { SymbolLocation } from '../../../shared/lsp-locations';
import { uniqueLocations } from '../../../shared/lsp-locations';
import type { EditorChange } from '../input/editor-controller';
import { clampPeekIndex, peekStepIndex } from './peek-model';
import type { PeekAnchor, PeekWidget } from '../widgets/peek-widget';

export interface PeekDeps {
  /** Где берём места определения (обычно — `LspFeatures.definition`). */
  definition(path: string, position: { line: number; column: number }): Promise<SymbolLocation[]>;
  /** Текст файла: у открытого — из документа, у прочего — с диска. `null` — прочитать не вышло. */
  readText(path: string): Promise<string | null>;
  /** Куда показывать копию. */
  widget: PeekWidget;
  /** Где копию поставить — у строки, откуда заглянули. */
  anchor(): PeekAnchor;
  /** Короткая подпись места (путь файла). */
  label(target: SymbolLocation): string;
  /** Перейти к месту насовсем: открыть файл и поставить курсор. */
  reveal(target: SymbolLocation): void;
  /** Сказать, что заглянуть не удалось. */
  notice(text: string): void;
  /** Путь и позиция курсора сейчас: с них уходит запрос к серверу. */
  position(): { path: string | null; line: number; column: number };
}

export class PeekController {
  private readonly deps: PeekDeps;
  /** Найденные места и какое из них показываем. */
  private targets: SymbolLocation[] = [];
  private index = 0;
  /** Тексты по путям: один файл может содержать несколько мест. Живут до закрытия. */
  private readonly texts = new Map<string, string | null>();
  /** Номер показа: ответ на устаревший запрос не применяем. */
  private requestId = 0;

  constructor(deps: PeekDeps) {
    this.deps = deps;
    deps.widget.onOpen = () => this.openCurrent();
    deps.widget.onClose = () => this.hide();
    deps.widget.onStep = (delta) => this.step(delta);
  }

  /** Копия показывается — клавиши принадлежат ей (ввод спрашивает об этом первым). */
  handleKey(event: KeyboardEvent): boolean {
    return this.deps.widget.handleKey(event);
  }

  /** Заглянуть в определение символа под курсором. */
  peekDefinition(): void {
    void this.run();
  }

  /** Текст или курсор изменились: копия про прежнее место больше не годится. */
  onChange(_change: EditorChange): void {
    if (this.deps.widget.isVisible) this.hide();
  }

  hide(): void {
    this.requestId += 1;
    this.targets = [];
    this.index = 0;
    this.texts.clear();
    this.deps.widget.hide();
  }

  private async run(): Promise<void> {
    const { path, line, column } = this.deps.position();
    if (!path) return;

    let locations: SymbolLocation[];
    try {
      locations = await this.deps.definition(path, { line, column });
    } catch {
      this.deps.notice('Не удалось прочитать определение');
      return;
    }

    // Повторы убираем: одно место дважды — это не два места.
    const targets = uniqueLocations(locations);
    if (targets.length === 0) {
      this.deps.notice('Определение не найдено');
      return;
    }

    this.targets = targets;
    this.index = 0;
    this.texts.clear();
    await this.showCurrent();
  }

  private step(delta: number): void {
    if (this.targets.length === 0) return;
    const next = peekStepIndex(this.index, delta, this.targets.length);
    if (next === this.index) return;
    this.index = clampPeekIndex(next, this.targets.length);
    void this.showCurrent();
  }

  private async showCurrent(): Promise<void> {
    const target = this.targets[this.index];
    if (!target) return;
    const id = (this.requestId += 1);

    const text = await this.textFor(target.path);
    // Пока читали, копию закрыли или перешли на другое место — ответ уже не к месту.
    if (id !== this.requestId) return;
    if (text === null) {
      this.deps.notice(`Не удалось прочитать файл: ${this.deps.label(target)}`);
      return;
    }

    this.deps.widget.show(
      {
        text,
        path: target.path,
        targetLine: target.line,
        title: `${this.deps.label(target)}:${target.line}`,
        index: this.index,
        total: this.targets.length,
      },
      this.deps.anchor(),
    );
  }

  /** Текст файла с памятью на время показа. `null` — прочитать не удалось. */
  private async textFor(path: string): Promise<string | null> {
    if (this.texts.has(path)) return this.texts.get(path) ?? null;
    let text: string | null = null;
    try {
      text = await this.deps.readText(path);
    } catch {
      text = null;
    }
    this.texts.set(path, text);
    return text;
  }

  private openCurrent(): void {
    const target = this.targets[this.index];
    this.hide();
    if (target) this.deps.reveal(target);
  }
}
