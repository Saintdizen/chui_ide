import type { TextDocument } from "./document";
import type { DocumentStore } from "./document-store";
import { Emitter } from "./events";

/**
 * Открытые вкладки: порядок, активная, dirty-состояние, предпросмотр и закрепление.
 * Отдельная модель, а не состояние UI — потому что вкладки нужны и командам,
 * и (позже) ассистенту, который захочет понять, что сейчас открыто.
 *
 * Предпросмотр — вкладка «на посмотреть»: её открывает одиночный клик по файлу в
 * дереве, и следующая такая же вкладка её вытесняет, чтобы просмотр не плодил
 * десятки вкладок. Вкладка перестаёт быть предпросмотром, как только её начали
 * править (файл стал изменённым), закрепили или открыли из навигации «насовсем».
 *
 * Закрепление — вкладка «насовсем»: предпросмотр её не вытесняет, а «закрыть
 * другие» её не трогает. Закреплённые стоят левее прочих (порядок показывает полоса).
 */
export class OpenEditors {
  private readonly order: string[] = [];
  private activeId: string | null = null;
  /** Вкладка-предпросмотр (одна) или `null`, если предпросмотра нет. */
  private previewPath: string | null = null;
  private readonly pinned = new Set<string>();
  /**
   * Порядок ИСПОЛЬЗОВАНИЯ — отдельно от порядка вкладок в полосе: `Ctrl+Tab` идёт
   * по нему, как в VS Code. Свежая вкладка впереди.
   */
  private recentlyUsed: string[] = [];
  /**
   * Перебор по `Ctrl+Tab`: снимок порядка на время, пока клавишу не отпустили.
   * Без снимка каждый шаг ставил бы в голову только что показанную вкладку, и
   * сочетание ходило бы «туда-обратно» между двумя файлами.
   */
  private recentCycle: { order: string[]; index: number } | null = null;

  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly documents: DocumentStore) {
    // Правка в предпросмотре делает вкладку постоянной: файл, который правили, уже не
    // «посмотреть», а работать с ним. Следим за изменениями документа — этого довольно.
    this.documents.onDidChange(() => {
      if (!this.previewPath) return;
      if (this.documents.get(this.previewPath)?.dirty) {
        this.previewPath = null;
        this.changeEmitter.fire();
      }
    });
  }

  get paths(): readonly string[] {
    return this.order;
  }

  get active(): TextDocument | null {
    return this.activeId ? (this.documents.get(this.activeId) ?? null) : null;
  }

  has(path: string): boolean {
    return this.order.includes(path);
  }

  isPinned(path: string): boolean {
    return this.pinned.has(path);
  }

  isPreview(path: string): boolean {
    return this.previewPath === path;
  }

  /** Порядок использования: свежие впереди. Его же хранит сессия. */
  get recent(): readonly string[] {
    return this.recentlyUsed;
  }

  /** Запомнить показ вкладки: она становится свежей. */
  private touch(path: string): void {
    const at = this.recentlyUsed.indexOf(path);
    if (at >= 0) this.recentlyUsed.splice(at, 1);
    this.recentlyUsed.unshift(path);
    // Перебор продолжается, только пока шагаем по его же снимку: любой другой показ
    // (клик по вкладке, открытие файла) начинает порядок заново.
    if (
      this.recentCycle &&
      this.recentCycle.order[this.recentCycle.index] !== path
    ) {
      this.recentCycle = null;
    }
  }

  /** Выкинуть путь из порядка использования: вкладки больше нет. */
  private forget(path: string): void {
    const at = this.recentlyUsed.indexOf(path);
    if (at >= 0) this.recentlyUsed.splice(at, 1);
  }

  /**
   * Вкладка на шаг по порядку использования: `1` — предыдущая, `-1` — следующая.
   * Возвращает путь, но НЕ активирует: показ (и редактор) — дело команды.
   */
  cycleRecent(step: 1 | -1): string | null {
    if (!this.recentCycle) {
      const order = this.recentlyUsed.filter((path) =>
        this.order.includes(path),
      );
      // Активная свежее всех по определению; иначе первый шаг вёл бы в неё же.
      const at = this.activeId ? order.indexOf(this.activeId) : -1;
      if (this.activeId && at > 0) {
        order.splice(at, 1);
        order.unshift(this.activeId);
      }
      // Вкладки, которых нет в порядке использования (сессия открыта в обход `open`),
      // дописываем в конец — иначе они выпали бы из перебора.
      for (const path of this.order)
        if (!order.includes(path)) order.push(path);
      this.recentCycle = { order, index: 0 };
    }

    // Закрытые за время перебора вкладки из снимка выпадают.
    const order = this.recentCycle.order.filter((path) =>
      this.order.includes(path),
    );
    if (order.length < 2) {
      this.recentCycle = null;
      return null;
    }
    const current = this.recentCycle.order[this.recentCycle.index];
    const from = current ? Math.max(order.indexOf(current), 0) : 0;
    const index = (from + step + order.length) % order.length;
    this.recentCycle = { order, index };
    return order[index] ?? null;
  }

  /** Закончить перебор: клавишу отпустили или окно потеряло фокус. */
  endRecentCycle(): void {
    this.recentCycle = null;
  }

  /**
   * Показать вкладки в записанном порядке.
   *
   * Нужно, чтобы порядок полосы переживал перезапуск: восстановление открывает
   * файлы в том же порядке, что и в сессии, но путь через `open()` мог бы его
   * сдвинуть (предпросмотр, закреплённые). Чужие пути отбрасываются.
   */
  restoreOrder(paths: readonly string[]): void {
    const order: string[] = [];
    for (const path of paths) {
      if (this.order.includes(path) && !order.includes(path)) order.push(path);
    }
    // Вкладки, о которых сессия не знала (открылись сами), остаются справа.
    for (const path of this.order) if (!order.includes(path)) order.push(path);
    this.order.splice(0, this.order.length, ...order);
  }

  /** Вернуть порядок использования из сессии: чужие и закрытые пути отбрасываются. */
  restoreRecent(paths: readonly string[]): void {
    const recent: string[] = [];
    for (const path of paths) {
      if (this.order.includes(path) && !recent.includes(path))
        recent.push(path);
    }
    for (const path of this.order)
      if (!recent.includes(path)) recent.push(path);
    this.recentlyUsed = recent;
    this.recentCycle = null;
  }

  /** Открыть файл. `preview` — вкладка «на посмотреть» (вытеснит прежний предпросмотр). */
  open(document: TextDocument, options: { preview?: boolean } = {}): void {
    const path = document.path;
    const preview = options.preview === true;

    if (this.order.includes(path)) {
      // Уже открыт: открытие «насовсем» снимает с него метку предпросмотра.
      if (!preview && this.previewPath === path) this.previewPath = null;
      this.activeId = path;
      this.touch(path);
      this.changeEmitter.fire();
      return;
    }

    if (preview) {
      const current = this.previewPath;
      if (
        current &&
        current !== path &&
        this.order.includes(current) &&
        !this.pinned.has(current)
      ) {
        // Вытесняем прежний предпросмотр, вставая на его место: полоса вкладок не дёргается.
        const index = this.order.indexOf(current);
        this.order.splice(index, 1);
        this.forget(current);
        this.documents.close(current);
        this.order.splice(index, 0, path);
      } else {
        this.order.push(path);
      }
      this.previewPath = path;
    } else {
      this.order.push(path);
    }

    this.activeId = path;
    this.touch(path);
    this.changeEmitter.fire();
  }

  activate(path: string): void {
    if (!this.order.includes(path)) return;
    if (this.activeId === path) {
      // Вкладка уже показана, но в порядке использования могла отстать — выправляем.
      this.touch(path);
      return;
    }
    this.activeId = path;
    this.touch(path);
    this.changeEmitter.fire();
  }

  /** Закрепить вкладку: предпросмотром она больше не станет. */
  pin(path: string): void {
    if (!this.order.includes(path)) return;
    const wasPreview = this.previewPath === path;
    const wasPinned = this.pinned.has(path);
    this.pinned.add(path);
    if (wasPreview) this.previewPath = null;
    if (!wasPinned || wasPreview) this.changeEmitter.fire();
  }

  /**
   * Переставить вкладку на место `before` (путь вкладки, перед которой стать;
   * `null` — в конец). Отдаёт новый порядок или `null`, если переставлять
   * нечего.
   *
   * Закреплённые вкладки двигаются только среди закреплённых: иначе
   * перетаскивание младшей вкладки через закреплённую сломало бы саму идею
   * закрепления — «эти всегда слева».
   */
  move(path: string, before: string | null): string[] | null {
    const from = this.order.indexOf(path);
    if (from < 0) return null;
    const pinnedCount = this.pinnedCount();
    const isPinned = this.pinned.has(path);

    let to = before === null ? this.order.length : this.order.indexOf(before);
    if (to < 0) return null;

    // Индекс цели считался до извлечения: если двигаем вперёд, сдвигаем на один.
    // Это ДО ограничения зонами: сначала переводим «перед целью» в «место в
    // списке», потом держим место внутри своей зоны. Наоборот — граница
    // закреплённых сдвигалась бы вместе с движением.
    const target = from < to ? to - 1 : to;
    // Границы зон: закреплённые в начале, остальные после них.
    const lowest = isPinned ? 0 : pinnedCount;
    const highest = isPinned ? pinnedCount - 1 : this.order.length - 1;
    const clamped = Math.min(Math.max(target, lowest), highest);
    if (clamped === from) return null;

    this.order.splice(from, 1);
    this.order.splice(clamped, 0, path);
    this.changeEmitter.fire();
    return [...this.order];
  }

  /** Сколько закреплённых идут в начале — граница между зонами вкладок. */
  private pinnedCount(): number {
    let count = 0;
    for (const path of this.order) if (!this.pinned.has(path)) break;
    else count += 1;
    return count;
  }

  unpin(path: string): void {
    if (this.pinned.delete(path)) this.changeEmitter.fire();
  }

  close(path: string): string | null {
    const index = this.order.indexOf(path);
    if (index < 0) return this.activeId;

    this.order.splice(index, 1);
    this.pinned.delete(path);
    this.forget(path);
    if (this.previewPath === path) this.previewPath = null;
    this.documents.close(path);

    if (this.activeId === path) {
      this.activeId =
        this.order[Math.min(index, this.order.length - 1)] ?? null;
    }
    this.changeEmitter.fire();
    return this.activeId;
  }

  /** Закрыть все, кроме указанной и закреплённых: закреплённое — «насовсем». */
  closeOthers(keep: string): void {
    for (const path of [...this.order]) {
      if (path === keep || this.pinned.has(path)) continue;
      this.order.splice(this.order.indexOf(path), 1);
      this.forget(path);
      this.documents.close(path);
    }
    if (this.order.includes(keep)) this.activeId = keep;
    this.changeEmitter.fire();
  }

  closeAll(): void {
    for (const path of [...this.order]) this.documents.close(path);
    this.order.length = 0;
    this.pinned.clear();
    this.recentlyUsed.length = 0;
    this.recentCycle = null;
    this.previewPath = null;
    this.activeId = null;
    this.changeEmitter.fire();
  }
}
