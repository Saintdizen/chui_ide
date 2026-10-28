import { describe, expect, it } from 'vitest';
import { DoubleShiftDetector } from '../src/renderer/core/double-shift';

const shift = { key: 'Shift' };

/** Одно чистое нажатие Shift: вниз, вверх. */
function tap(detector: DoubleShiftDetector, at: number): boolean {
  detector.keyDown(shift);
  return detector.keyUp(shift, at);
}

describe('двойное нажатие Shift', () => {
  it('одно нажатие — палитра не открывается', () => {
    expect(tap(new DoubleShiftDetector(), 1000)).toBe(false);
  });

  it('два быстрых подряд — палитра открывается', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 1000);
    expect(tap(detector, 1150)).toBe(true);
  });

  it('два с паузой — это не двойное нажатие', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 1000);
    expect(tap(detector, 2000)).toBe(false);
  });

  // Главная причина, по которой это не «два Shift подряд»: Shift — рабочий модификатор.
  it('Shift вместе с буквой не считается нажатием', () => {
    const detector = new DoubleShiftDetector();
    detector.keyDown(shift);
    detector.keyDown({ key: 'А' });
    expect(detector.keyUp(shift, 1000)).toBe(false);
    detector.keyDown(shift);
    detector.keyDown({ key: 'Б' });
    expect(detector.keyUp(shift, 1050)).toBe(false);
  });

  it('автоповтор удержанного Shift не превращается в двойное нажатие', () => {
    const detector = new DoubleShiftDetector();
    detector.keyDown(shift);
    detector.keyDown(shift);
    detector.keyDown(shift);
    expect(detector.keyUp(shift, 1000)).toBe(false);
  });

  it('печать между нажатиями гасит счёт', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 1000);
    detector.keyDown({ key: 'a' });
    detector.keyUp({ key: 'a' }, 1020);
    expect(tap(detector, 1060)).toBe(false);
  });

  it('клик мышью рвёт серию', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 1000);
    detector.reset();
    expect(tap(detector, 1100)).toBe(false);
  });

  it('третье нажатие после срабатывания снова ждёт пары', () => {
    const detector = new DoubleShiftDetector();
    tap(detector, 1000);
    expect(tap(detector, 1100)).toBe(true);
    expect(tap(detector, 1200)).toBe(false);
    expect(tap(detector, 1300)).toBe(true);
  });
});
