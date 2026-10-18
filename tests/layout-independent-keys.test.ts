import { describe, expect, it } from 'vitest';
import { physicalKeyName, shortcutKey } from '../src/shared/physical-key';
import { comboFromEvent } from '../src/renderer/core/keybindings';
import { resolveKey } from '../src/renderer/editor/input/keymap';

/**
 * Раскладка не должна отменять горячие клавиши.
 *
 * `KeyboardEvent.key` зависит от раскладки: при русской `Ctrl+S` даёт `key === 'ы'`.
 * Поэтому сочетания и команды разбираются по `KeyboardEvent.code` — физическому
 * положению клавиши, — а символ для ввода текста берётся из `key`.
 */

describe('physicalKeyName', () => {
  it('буквы, цифры и знаки — по положению клавиши', () => {
    expect(physicalKeyName('KeyS')).toBe('S');
    expect(physicalKeyName('KeyZ')).toBe('Z');
    expect(physicalKeyName('Digit1')).toBe('1');
    expect(physicalKeyName('Comma')).toBe(',');
    expect(physicalKeyName('Slash')).toBe('/');
    expect(physicalKeyName('Backquote')).toBe('`');
    expect(physicalKeyName('BracketLeft')).toBe('[');
  });

  it('цифры на цифровом блоке — та же цифра', () => {
    expect(physicalKeyName('Numpad7')).toBe('7');
  });

  it('служебные клавиши имени не дают: у них и так нет раскладки', () => {
    expect(physicalKeyName('F5')).toBeNull();
    expect(physicalKeyName('Escape')).toBeNull();
    expect(physicalKeyName('ArrowLeft')).toBeNull();
    expect(physicalKeyName('')).toBeNull();
    expect(physicalKeyName(undefined)).toBeNull();
  });
});

describe('shortcutKey: сочетание не зависит от раскладки', () => {
  it('русская раскладка поверх латинской клавиши даёт латинское имя', () => {
    expect(shortcutKey({ key: 'ы', code: 'KeyS' })).toBe('S');
    expect(shortcutKey({ key: 'я', code: 'KeyZ' })).toBe('Z');
    expect(shortcutKey({ key: 'б', code: 'Comma' })).toBe(',');
  });

  it('без `code` (событие без физической клавиши) берётся символ', () => {
    expect(shortcutKey({ key: 's' })).toBe('S');
    expect(shortcutKey({ key: 'F5' })).toBe('F5');
  });
});

describe('comboFromEvent при русской раскладке', () => {
  const event = (parts: Partial<KeyboardEvent>): KeyboardEvent => parts as unknown as KeyboardEvent;

  it('Ctrl+S по физической клавише остаётся Ctrl+S', () => {
    // Так приходит нажатие при русской раскладке: знак — «ы», клавиша — S.
    expect(comboFromEvent(event({ ctrlKey: true, key: 'ы', code: 'KeyS' }))).toBe('Ctrl+S');
  });

  it('Ctrl+Shift+Z, Ctrl+, и Ctrl+` тоже не меняются', () => {
    expect(comboFromEvent(event({ ctrlKey: true, shiftKey: true, key: 'Я', code: 'KeyZ' }))).toBe('Ctrl+Shift+Z');
    expect(comboFromEvent(event({ ctrlKey: true, key: 'б', code: 'Comma' }))).toBe('Ctrl+,');
    expect(comboFromEvent(event({ ctrlKey: true, key: 'ё', code: 'Backquote' }))).toBe('Ctrl+`');
  });

  it('служебные клавиши от раскладки не зависят и раньше', () => {
    expect(comboFromEvent(event({ ctrlKey: true, key: 'F5', code: 'F5' }))).toBe('Ctrl+F5');
    expect(comboFromEvent(event({ key: 'F5' }))).toBe('F5');
  });
});

describe('resolveKey при русской раскладке', () => {
  it('Ctrl+Z — отмена, хотя знак русский', () => {
    expect(resolveKey({ key: 'я', physical: 'Z', ctrl: true })).toEqual({ kind: 'edit', edit: 'undo' });
  });

  it('Ctrl+Y — повтор', () => {
    expect(resolveKey({ key: 'н', physical: 'Y', ctrl: true })).toEqual({ kind: 'edit', edit: 'redo' });
  });

  it('Ctrl+/ — комментарий строки', () => {
    // На русской раскладке та же клавиша даёт «.», но команда остаётся прежней.
    expect(resolveKey({ key: '.', physical: '/', ctrl: true })).toEqual({ kind: 'edit', edit: 'toggleComment' });
  });

  it('Ctrl+D — следующее вхождение', () => {
    expect(resolveKey({ key: 'в', physical: 'D', ctrl: true })).toEqual({ kind: 'edit', edit: 'selectNextOccurrence' });
  });

  it('Ctrl+Shift+[ сворачивает блок', () => {
    expect(resolveKey({ key: '{', physical: '[', ctrl: true, shift: true })).toEqual({ kind: 'edit', edit: 'fold' });
  });

  it('печать по-русски остаётся русской: ввод идёт символом раскладки', () => {
    expect(resolveKey({ key: 'я', physical: 'Z' })).toEqual({ kind: 'insert', text: 'я' });
    expect(resolveKey({ key: 'ж', physical: ';' })).toEqual({ kind: 'insert', text: 'ж' });
  });
});
