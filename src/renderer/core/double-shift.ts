/**
 * Двойное нажатие Shift — открыть палитру команд.
 *
 * Считается только «чистое» нажатие: Shift нажат и отпущен, а между ними не нажимались
 * другие клавиши и не было клика мышью. Иначе Shift при наборе заглавных («АБ») или
 * Shift+клик по тексту открывали бы палитру посреди работы.
 */
export const DOUBLE_SHIFT_MS = 400;

export interface KeyLike {
  readonly key: string;
}

/**
 * Счётчик двойного Shift. Держит три вещи: нажат ли Shift сейчас, «испорчено» ли
 * текущее нажатие (рядом нажимали что-то ещё) и когда было прошлое чистое нажатие.
 * Время приходит снаружи — так это проверяется без таймеров.
 */
export class DoubleShiftDetector {
  private pressed = false;
  private tainted = false;
  private lastTap = 0;

  keyDown(event: KeyLike): void {
    if (event.key === 'Shift') {
      // Автоповтор удержанного Shift — не новое нажатие.
      if (!this.pressed) {
        this.pressed = true;
        this.tainted = false;
      }
      return;
    }
    // Любая другая клавиша: текущий Shift — часть сочетания, а не отдельное нажатие.
    this.tainted = true;
    // И прошлое чистое нажатие больше не «половина двойного»: человек печатал.
    if (!this.pressed) this.lastTap = 0;
  }

  /** Отпускание Shift. Истина — это было второе быстрое чистое нажатие подряд. */
  keyUp(event: KeyLike, now: number): boolean {
    if (event.key !== 'Shift') return false;
    this.pressed = false;
    if (this.tainted) {
      this.tainted = false;
      return false;
    }
    const doubled = this.lastTap !== 0 && now - this.lastTap <= DOUBLE_SHIFT_MS;
    this.lastTap = doubled ? 0 : now;
    return doubled;
  }

  /** Клик мышью или потеря фокуса окна рвут серию: отпускание могло пройти мимо нас. */
  reset(): void {
    this.pressed = false;
    this.tainted = false;
    this.lastTap = 0;
  }
}

/** Вешает двойное нажатие Shift на окно. Возвращает отписку. */
export function attachDoubleShift(target: Window, action: () => void): () => void {
  const detector = new DoubleShiftDetector();
  const onKeyDown = (event: KeyboardEvent): void => detector.keyDown(event);
  const onKeyUp = (event: KeyboardEvent): void => {
    if (detector.keyUp(event, performance.now())) action();
  };
  const onReset = (): void => detector.reset();
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('pointerdown', onReset, true);
  target.addEventListener('blur', onReset);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('pointerdown', onReset, true);
    target.removeEventListener('blur', onReset);
  };
}
