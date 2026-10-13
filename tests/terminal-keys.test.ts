import { describe, expect, it } from 'vitest';
import {
  encodeKey,
  encodeMouse,
  encodePaste,
  type KeyModes,
  type KeyStroke,
} from '../src/renderer/terminal/input/keys';

/**
 * Кодирование клавиш: нажатие → байты для pty. Правило чистое, проверяется без окна.
 * Главные случаи: печать, управляющие комбинации, служебные клавиши, стрелки в обычном
 * и прикладном режиме, модификаторы навигации и вставка со скобками.
 */

const modes = (applicationCursorKeys = false): KeyModes => ({ applicationCursorKeys });
const stroke = (key: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('encodeKey: печать и управляющие', () => {
  it('обычный знак идёт как есть', () => {
    expect(encodeKey(stroke('a'), modes())).toBe('a');
  });

  it('Ctrl+буква даёт управляющий код', () => {
    expect(encodeKey(stroke('c', { ctrlKey: true }), modes())).toBe('\x03');
    expect(encodeKey(stroke('A', { ctrlKey: true }), modes())).toBe('\x01');
  });

  it('Alt добавляет префикс ESC', () => {
    expect(encodeKey(stroke('f', { altKey: true }), modes())).toBe('\x1bf');
  });

  it('Ctrl+Alt вместе дают и префикс, и код', () => {
    expect(encodeKey(stroke('c', { ctrlKey: true, altKey: true }), modes())).toBe('\x1b\x03');
  });
});

describe('encodeKey: служебные клавиши', () => {
  it('Enter, Backspace, Escape, Tab', () => {
    expect(encodeKey(stroke('Enter'), modes())).toBe('\r');
    expect(encodeKey(stroke('Backspace'), modes())).toBe('\x7f');
    expect(encodeKey(stroke('Escape'), modes())).toBe('\x1b');
    expect(encodeKey(stroke('Tab'), modes())).toBe('\t');
    expect(encodeKey(stroke('Tab', { shiftKey: true }), modes())).toBe('\x1b[Z');
  });
});

describe('encodeKey: стрелки и навигация', () => {
  it('обычный режим — CSI-последовательности', () => {
    expect(encodeKey(stroke('ArrowUp'), modes())).toBe('\x1b[A');
    expect(encodeKey(stroke('Home'), modes())).toBe('\x1b[H');
  });

  it('прикладной режим меняет стрелки на SS3', () => {
    expect(encodeKey(stroke('ArrowUp'), modes(true))).toBe('\x1bOA');
  });

  it('модификатор добавляет параметр 1;N', () => {
    expect(encodeKey(stroke('ArrowRight', { ctrlKey: true }), modes())).toBe('\x1b[1;5C');
    expect(encodeKey(stroke('ArrowUp', { shiftKey: true }), modes())).toBe('\x1b[1;2A');
  });

  it('функциональные клавиши и Delete', () => {
    expect(encodeKey(stroke('F5'), modes())).toBe('\x1b[15~');
    expect(encodeKey(stroke('Delete'), modes())).toBe('\x1b[3~');
  });

  it('неизвестную клавишу не кодируем', () => {
    expect(encodeKey(stroke('AudioVolumeUp'), modes())).toBeNull();
  });
});

describe('encodePaste', () => {
  it('без режима текст идёт как есть', () => {
    expect(encodePaste('ls -la', false)).toBe('ls -la');
  });

  it('с режимом текст обрамляется маркерами', () => {
    expect(encodePaste('ls', true)).toBe('\x1b[200~ls\x1b[201~');
  });
});

describe('encodeMouse', () => {
  const mouse = (over: Partial<Parameters<typeof encodeMouse>[0]> = {}) => ({
    action: 'press' as const,
    button: 'left' as const,
    col: 0,
    row: 0,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  });

  it('нажатие левой в SGR: координаты с единицы', () => {
    expect(encodeMouse(mouse({ col: 4, row: 2 }), true)).toBe('\x1b[<0;5;3M');
  });

  it('отпускание в SGR помечается строчной `m`', () => {
    expect(encodeMouse(mouse({ action: 'release', col: 4, row: 2 }), true)).toBe('\x1b[<0;5;3m');
  });

  it('движение добавляет бит 32 к коду кнопки', () => {
    expect(encodeMouse(mouse({ action: 'move', button: 'none', col: 1, row: 1 }), true)).toBe('\x1b[<35;2;2M');
  });

  it('модификаторы добавляют биты к коду', () => {
    expect(encodeMouse(mouse({ ctrl: true }), true)).toBe('\x1b[<16;1;1M');
    expect(encodeMouse(mouse({ shift: true, alt: true }), true)).toBe('\x1b[<12;1;1M');
  });

  it('колесо кодируется как 64/65', () => {
    expect(encodeMouse(mouse({ button: 'wheelUp' }), true)).toBe('\x1b[<64;1;1M');
    expect(encodeMouse(mouse({ button: 'wheelDown' }), true)).toBe('\x1b[<65;1;1M');
  });

  it('старый формат — три байта со смещением 32', () => {
    expect(encodeMouse(mouse({ col: 0, row: 0 }), false)).toBe('\x1b[M !!');
  });
});

describe('encodeMouse', () => {
  const mouse = (over: Partial<Parameters<typeof encodeMouse>[0]> = {}) => ({
    action: 'press' as const,
    button: 'left' as const,
    col: 0,
    row: 0,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  });

  it('нажатие левой в SGR: координаты с единицы', () => {
    expect(encodeMouse(mouse({ col: 4, row: 2 }), true)).toBe('\x1b[<0;5;3M');
  });

  it('отпускание в SGR помечается строчной `m`', () => {
    expect(encodeMouse(mouse({ action: 'release', col: 4, row: 2 }), true)).toBe('\x1b[<0;5;3m');
  });

  it('движение добавляет бит 32 к коду кнопки', () => {
    expect(encodeMouse(mouse({ action: 'move', button: 'none', col: 1, row: 1 }), true)).toBe('\x1b[<35;2;2M');
  });

  it('модификаторы добавляют биты к коду', () => {
    expect(encodeMouse(mouse({ ctrl: true }), true)).toBe('\x1b[<16;1;1M');
    expect(encodeMouse(mouse({ shift: true, alt: true }), true)).toBe('\x1b[<12;1;1M');
  });

  it('колесо кодируется как 64/65', () => {
    expect(encodeMouse(mouse({ button: 'wheelUp' }), true)).toBe('\x1b[<64;1;1M');
    expect(encodeMouse(mouse({ button: 'wheelDown' }), true)).toBe('\x1b[<65;1;1M');
  });

  it('старый формат — три байта со смещением 32', () => {
    expect(encodeMouse(mouse({ col: 0, row: 0 }), false)).toBe('\x1b[M !!');
  });
});
