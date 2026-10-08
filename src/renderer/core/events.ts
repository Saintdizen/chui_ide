export interface Disposable {
  dispose(): void;
}

/**
 * Крошечный типизированный emitter. Свой, а не EventTarget, потому что нужны
 * строгие типы полезной нагрузки и предсказуемый порядок подписчиков.
 */
export class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  readonly event = (listener: (event: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
