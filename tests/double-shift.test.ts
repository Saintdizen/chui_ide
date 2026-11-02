import { beforeEach, describe, expect, it } from 'vitest';
import { attachDoubleShift, DOUBLE_SHIFT_MS, DoubleShiftDetector } from '../src/renderer/core/double-shift';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Двойное нажатие Shift (`renderer/core/double-shift.ts`).
 *
 * Открывает палитру команд. Опасность не в том, что палитра не откроется, а в том,
 * что откроется невпопад: при наборе заглавных («АБ» — это Shift, буква, Shift) или
 * при Shift+клике по тексту. Поэтому проверяется и «сработало», и каждый способ «не
 * сработало».
 *
 * Время приходит снаружи: тест двигает его сам, таймеры не нужны.
 */

const shift = { key: 'Shift' };
const letter = { key: 'а' };

/** Чистое нажатие Shift длиной 30 мс в момент `at`. */
function tap(detector: DoubleShiftDetector, at: number): boolean {
  detector.keyDown(shift);
  return detector.keyUp(shift, at + 30);
}

describe('счётчик двойного Shift', () => {
  it('два чистых нажатия подряд в пределах окна — сработало', () => {
    const detector = new DoubleShiftDetector();

    expect(tap(detector, 0)).toBe(false);
    expect(tap(detector, 100)).toBe(true);
  });

  it('медленнее окна — не сработало', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 0); // отпускание в 30 мс

    // Следующее отпускание позже окна, считая ОТ предыдущего отпускания.
    expect(tap(detector, DOUBLE_SHIFT_MS + 100)).toBe(false);
  });

  it('ровно на границе окна — сработало', () => {
    // Окно считается между ОТПУСКАНИЯМИ, а не нажатиями: важно, как быстро человек
    // отпустил и снова нажал. Граница включительная.
    const detector = new DoubleShiftDetector();
    detector.keyDown(shift);
    detector.keyUp(shift, 0);
    detector.keyDown(shift);

    expect(detector.keyUp(shift, DOUBLE_SHIFT_MS)).toBe(true);
  });

  it('третье нажатие после срабатывания — уже новое, а не второе', () => {
    // Иначе удержание в ритме открывало бы палитру на каждом нажатии.
    const detector = new DoubleShiftDetector();
    tap(detector, 0);
    expect(tap(detector, 100)).toBe(true);

    expect(tap(detector, 200)).toBe(false);
  });
});

describe('что рвёт серию', () => {
  it('набор заглавных: Shift, буква, Shift', () => {
    // «АБ» — это Shift, «а», Shift, «б». Палитра тут была бы помехой набору.
    const detector = new DoubleShiftDetector();
    tap(detector, 0);
    detector.keyDown(letter);
    detector.keyUp(letter, 50);

    expect(tap(detector, 100)).toBe(false);
  });

  it('Shift с буквой — сочетание, а не чистое нажатие', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 0);
    detector.keyDown(shift);
    detector.keyDown(letter);
    detector.keyUp(letter, 40);

    expect(detector.keyUp(shift, 60)).toBe(false);
  });

  it('автоповтор удержанного Shift — одно нажатие', () => {
    const detector = new DoubleShiftDetector();
    detector.keyDown(shift);
    detector.keyDown(shift);
    detector.keyDown(shift);

    expect(detector.keyUp(shift, 10)).toBe(false);
    expect(tap(detector, 20)).toBe(true);
  });

  it('сброс (клик мышью, потеря фокуса) рвёт серию', () => {
    // Отпускание Shift могло пройти мимо окна: считать его нельзя.
    const detector = new DoubleShiftDetector();
    tap(detector, 0);

    detector.reset();

    expect(tap(detector, 100)).toBe(false);
  });

  it('отпускание не-Shift не считается завершением нажатия', () => {
    const detector = new DoubleShiftDetector();

    expect(detector.keyUp(letter, 0)).toBe(false);
  });
});

describe('подключение к окну', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('двойной Shift зовёт действие, а отписка его прекращает', () => {
    let fired = 0;
    const detach = attachDoubleShift(window as never, () => {
      fired += 1;
    });

    const press = (): void => {
      window.dispatchEvent({ type: 'keydown', key: 'Shift' } as never);
      window.dispatchEvent({ type: 'keyup', key: 'Shift' } as never);
    };
    press();
    press();
    expect(fired).toBe(1);

    detach();
    press();
    press();
    expect(fired).toBe(1);
  });

  it('одно нажатие действие не зовёт', () => {
    let fired = 0;
    attachDoubleShift(window as never, () => {
      fired += 1;
    });

    window.dispatchEvent({ type: 'keydown', key: 'Shift' } as never);
    window.dispatchEvent({ type: 'keyup', key: 'Shift' } as never);

    expect(fired).toBe(0);
  });
});
