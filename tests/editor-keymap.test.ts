import { describe, expect, it } from 'vitest';
import { chordCommand, chordName, isChordPrefix, resolveKey } from '../src/renderer/editor/input/keymap';

describe('движения', () => {
  it('стрелки без модификаторов', () => {
    expect(resolveKey({ key: 'ArrowLeft' })).toEqual({ kind: 'move', motion: 'left', extend: false });
    expect(resolveKey({ key: 'ArrowRight', shift: true })).toEqual({ kind: 'move', motion: 'right', extend: true });
  });

  it('Ctrl+стрелка — по словам, Ctrl+Home/End — в начало и конец документа', () => {
    expect(resolveKey({ key: 'ArrowLeft', ctrl: true })).toEqual({ kind: 'move', motion: 'wordLeft', extend: false });
    expect(resolveKey({ key: 'ArrowRight', ctrl: true, shift: true })).toEqual({
      kind: 'move',
      motion: 'wordRight',
      extend: true,
    });
    expect(resolveKey({ key: 'Home', ctrl: true })).toEqual({ kind: 'move', motion: 'docStart', extend: false });
    expect(resolveKey({ key: 'End', ctrl: true })).toEqual({ kind: 'move', motion: 'docEnd', extend: false });
  });

  it('Home без Ctrl — к началу текста строки, PageUp/PageDown — постранично', () => {
    expect(resolveKey({ key: 'Home' })).toEqual({ kind: 'move', motion: 'smartLineStart', extend: false });
    expect(resolveKey({ key: 'PageDown' })).toEqual({ kind: 'move', motion: 'pageDown', extend: false });
  });
});

describe('правки', () => {
  it('Backspace и Delete, с Ctrl — по словам', () => {
    expect(resolveKey({ key: 'Backspace' })).toEqual({ kind: 'edit', edit: 'backspace' });
    expect(resolveKey({ key: 'Backspace', ctrl: true })).toEqual({ kind: 'edit', edit: 'deleteWordBackward' });
    expect(resolveKey({ key: 'Delete' })).toEqual({ kind: 'edit', edit: 'delete' });
    expect(resolveKey({ key: 'Delete', ctrl: true })).toEqual({ kind: 'edit', edit: 'deleteWordForward' });
  });

  it('Enter — перевод строки, Tab — отступ, Shift+Tab — снятие отступа', () => {
    expect(resolveKey({ key: 'Enter' })).toEqual({ kind: 'edit', edit: 'newline' });
    expect(resolveKey({ key: 'Tab' })).toEqual({ kind: 'edit', edit: 'indent' });
    expect(resolveKey({ key: 'Tab', shift: true })).toEqual({ kind: 'edit', edit: 'outdent' });
  });

  it('Ctrl+Z отменяет, Ctrl+Shift+Z и Ctrl+Y повторяют', () => {
    expect(resolveKey({ key: 'z', ctrl: true })).toEqual({ kind: 'edit', edit: 'undo' });
    expect(resolveKey({ key: 'z', ctrl: true, shift: true })).toEqual({ kind: 'edit', edit: 'redo' });
    expect(resolveKey({ key: 'y', ctrl: true })).toEqual({ kind: 'edit', edit: 'redo' });
  });

  it('F1 открывает палитру команд (у Monaco — его действие)', () => {
    expect(resolveKey({ key: 'F1' })).toEqual({ kind: 'edit', edit: 'palette' });
  });

  it('F12, Shift+F12, Ctrl+Shift+F12 — навигация по символу', () => {
    expect(resolveKey({ key: 'F12' })).toEqual({ kind: 'edit', edit: 'goToDefinition' });
    expect(resolveKey({ key: 'F12', shift: true })).toEqual({ kind: 'edit', edit: 'references' });
    expect(resolveKey({ key: 'F12', ctrl: true, shift: true })).toEqual({ kind: 'edit', edit: 'peekDefinition' });
  });

  it('Ctrl+Shift+T — обернуть выделение (surround with)', () => {
    expect(resolveKey({ key: 'T', ctrl: true, shift: true })).toEqual({ kind: 'edit', edit: 'surroundWith' });
    // Без Shift это не наша клавиша — там обычный разбор.
    expect(resolveKey({ key: 't', ctrl: true })).toEqual({ kind: 'swallow' });
  });

  it('Ctrl+A, C, X, V — выделить, копировать, вырезать, вставить', () => {
    expect(resolveKey({ key: 'a', ctrl: true })).toEqual({ kind: 'edit', edit: 'selectAll' });
    expect(resolveKey({ key: 'c', ctrl: true })).toEqual({ kind: 'edit', edit: 'copy' });
    expect(resolveKey({ key: 'x', ctrl: true })).toEqual({ kind: 'edit', edit: 'cut' });
    expect(resolveKey({ key: 'v', ctrl: true })).toEqual({ kind: 'edit', edit: 'paste' });
  });

  it('сочетания меню редактор не забирает: Ctrl+Shift+A/F/G и Alt+F12', () => {
    // Нажатие акселератора доходит и сюда — здесь оно не должно ничего делать.
    expect(resolveKey({ key: 'A', ctrl: true, shift: true })).toEqual({ kind: 'swallow' });
    expect(resolveKey({ key: 'F', ctrl: true, shift: true })).toEqual({ kind: 'swallow' });
    expect(resolveKey({ key: 'G', ctrl: true, shift: true })).toEqual({ kind: 'swallow' });
    // Alt+F12 — терминал, а не переход к определению (его слушает приложение).
    expect(resolveKey({ key: 'F12', alt: true })).toBeNull();
  });

  it('сочетания меню редактор не забирает: Ctrl+Shift+A/F/G и Alt+F12', () => {
    // Нажатие акселератора доходит и сюда — здесь оно не должно ничего делать.
    expect(resolveKey({ key: 'A', ctrl: true, shift: true })).toEqual({ kind: 'swallow' });
    expect(resolveKey({ key: 'F', ctrl: true, shift: true })).toEqual({ kind: 'swallow' });
    expect(resolveKey({ key: 'G', ctrl: true, shift: true })).toEqual({ kind: 'swallow' });
    // Alt+F12 — терминал, а не переход к определению (его слушает приложение).
    expect(resolveKey({ key: 'F12', alt: true })).toBeNull();
  });
});

describe('сочетания-приставки (Ctrl+K Ctrl+F)', () => {
  it('имя сочетания собирается в привычном порядке', () => {
    expect(chordName({ key: 'k', ctrl: true })).toBe('Ctrl+K');
    expect(chordName({ key: 'f', ctrl: true, shift: true })).toBe('Ctrl+Shift+F');
    expect(chordName({ key: 'F12' })).toBe('F12');
  });

  it('Ctrl+K — приставка: сама ничего не делает, ждёт вторую клавишу', () => {
    expect(isChordPrefix('Ctrl+K')).toBe(true);
    expect(isChordPrefix('Ctrl+F')).toBe(false);
  });

  it('вторая часть пары даёт команду', () => {
    expect(chordCommand('Ctrl+K', 'Ctrl+F')).toBe('formatSelection');
  });

  it('незнакомая пара — null: клавишу разбираем как обычную', () => {
    expect(chordCommand('Ctrl+K', 'Ctrl+Z')).toBeNull();
    expect(chordCommand('Ctrl+J', 'Ctrl+F')).toBeNull();
  });
});

describe('ввод символов', () => {
  it('обычный символ идёт на ввод', () => {
    expect(resolveKey({ key: 'a' })).toEqual({ kind: 'insert', text: 'a' });
    expect(resolveKey({ key: 'Я' })).toEqual({ kind: 'insert', text: 'Я' });
    expect(resolveKey({ key: ' ' })).toEqual({ kind: 'insert', text: ' ' });
    // Буква с Shift (заглавная) — тоже ввод.
    expect(resolveKey({ key: 'A', shift: true })).toEqual({ kind: 'insert', text: 'A' });
    // Составной эмодзи — один печатный символ.
    expect(resolveKey({ key: '😀' })).toEqual({ kind: 'insert', text: '😀' });
  });

  it('без Ctrl неизвестные команды не перехватываются', () => {
    // F5 и подобные — не наше дело, возвращаем null (пусть решает приложение).
    expect(resolveKey({ key: 'F5' })).toBeNull();
    expect(resolveKey({ key: 'Shift' })).toBeNull();
  });

  it('Ctrl с незнакомой буквой гасим, чтобы символ не просочился', () => {
    expect(resolveKey({ key: 'k', ctrl: true })).toEqual({ kind: 'swallow' });
  });

  it('Alt+Enter не переводит строку (его слушает приложение)', () => {
    expect(resolveKey({ key: 'Enter', alt: true })).toBeNull();
  });
});
