/**
 * Пауза агентского прогона на границе шага.
 *
 * Не то же, что «стоп»: стоп рвёт стрим и теряет недосказанное; пауза даёт текущему
 * вызову инструмента доработать и держит следующий шаг. Цикл шагов — единственное
 * место, где стоим: посреди шага пауза оборвала бы вызов на полуслове.
 *
 * Состояние живёт в main, а не в запросе: renderer ставит и снимает его отдельным
 * методом (`ai.setPaused`) и ничего не теряет при перерисовке.
 */
export class PauseGate {
  private paused = false;
  private waiters: Array<() => void> = [];

  get isPaused(): boolean {
    return this.paused;
  }

  /** Поставить («пауза») или снять («продолжить»). Снятие будит всех ожидающих. */
  set(value: boolean): void {
    this.paused = value;
    if (value) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Дождаться снятия паузы. Прерывание (стоп, закрытие вкладки) будит ожидание
   * так же, как «продолжить», — иначе прогон провисел бы вечно.
   * Возвращает true, если ожидание случилось (нужно сообщить в ленту).
   */
  async wait(signal: AbortSignal): Promise<boolean> {
    if (!this.paused || signal.aborted) return false;
    await new Promise<void>((resolve) => {
      let settle = () => {
        settle = () => {};
        signal.removeEventListener('abort', settle);
        resolve();
      };
      signal.addEventListener('abort', settle);
      this.waiters.push(settle);
    });
    return true;
  }
}
