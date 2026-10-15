import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';
import type { KeyChord } from '../src/renderer/editor/input/keymap';
import { resolveEmacs } from '../src/renderer/editor/input/emacs';
import { EmacsBinding } from '../src/renderer/editor/input/emacs-binding';
import { isEmpty } from '../src/renderer/editor/view/selection';

/**
 * Emacs-режим: разбор сочетаний и применение команд. Проверяется без окна — на вход
 * клавиши и текст, на выходе движение или правка буфера.
 */

const chord = (key: string, mods: Omit<KeyChord, 'key'> = {}): KeyChord => ({ key, ...mods });

describe('разбор сочетаний Emacs', () => {
  it('движения по Ctrl и Alt', () => {
    expect(resolveEmacs(chord('f', { ctrl: true }))).toEqual({ kind: 'move', motion: 'right' });
    expect(resolveEmacs(chord('b', { ctrl: true }))).toEqual({ kind: 'move', motion: 'left' });
    expect(resolveEmacs(chord('n', { ctrl: true }))).toEqual({ kind: 'move', motion: 'down' });
    expect(resolveEmacs(chord('p', { ctrl: true }))).toEqual({ kind: 'move', motion: 'up' });
    expect(resolveEmacs(chord('a', { ctrl: true }))).toEqual({ kind: 'move', motion: 'lineStart' });
    expect(resolveEmacs(chord('e', { ctrl: true }))).toEqual({ kind: 'move', motion: 'lineEnd' });
    expect(resolveEmacs(chord('f', { alt: true }))).toEqual({ kind: 'move', motion: 'wordRight' });
    expect(resolveEmacs(chord('b', { alt: true }))).toEqual({ kind: 'move', motion: 'wordLeft' });
    expect(resolveEmacs(chord('<', { alt: true }))).toEqual({ kind: 'move', motion: 'docStart' });
    expect(resolveEmacs(chord('>', { alt: true }))).toEqual({ kind: 'move', motion: 'docEnd' });
  });

  it('правки и метка', () => {
    expect(resolveEmacs(chord('d', { ctrl: true }))).toEqual({ kind: 'deleteForward' });
    expect(resolveEmacs(chord('h', { ctrl: true }))).toEqual({ kind: 'deleteBackward' });
    expect(resolveEmacs(chord('k', { ctrl: true }))).toEqual({ kind: 'killLine' });
    expect(resolveEmacs(chord('u', { ctrl: true }))).toEqual({ kind: 'killToStart' });
    expect(resolveEmacs(chord('y', { ctrl: true }))).toEqual({ kind: 'yank' });
    expect(resolveEmacs(chord('g', { ctrl: true }))).toEqual({ kind: 'cancel' });
    expect(resolveEmacs(chord('t', { ctrl: true }))).toEqual({ kind: 'transpose' });
    expect(resolveEmacs(chord('o', { ctrl: true }))).toEqual({ kind: 'openLine' });
    expect(resolveEmacs(chord(' ', { ctrl: true }))).toEqual({ kind: 'setMark' });
    expect(resolveEmacs(chord('_', { ctrl: true }))).toEqual({ kind: 'undo' });
    expect(resolveEmacs(chord('d', { alt: true }))).toEqual({ kind: 'killWordForward' });
    expect(resolveEmacs(chord('Backspace', { alt: true }))).toEqual({ kind: 'killWordBackward' });
    expect(resolveEmacs(chord('y', { alt: true }))).toEqual({ kind: 'yankPop' });
  });

  it('обычный ввод и системные сочетания не перехватываются', () => {
    expect(resolveEmacs(chord('a'))).toBeNull();
    expect(resolveEmacs(chord('с', { ctrl: true }))).toBeNull();
    expect(resolveEmacs(chord('c', { ctrl: true }))).toBeNull();
    expect(resolveEmacs(chord('v', { ctrl: true }))).toBeNull();
    expect(resolveEmacs(chord('z', { ctrl: true }))).toBeNull();
    expect(resolveEmacs(chord('s', { ctrl: true }))).toBeNull();
    // Ctrl и Alt вместе — это уже другие команды редактора.
    expect(resolveEmacs(chord('f', { ctrl: true, alt: true }))).toBeNull();
  });
});

describe('применение команд Emacs (EmacsBinding)', () => {
  function setup(text: string, caret = 0) {
    const buffer = new TextBuffer(text);
    const controller = new EditorController(buffer);
    controller.setSelection({ anchor: caret, active: caret });
    const emacs = new EmacsBinding(controller);
    emacs.setEnabled(true);
    const press = (key: string, mods: Omit<KeyChord, 'key'> = {}): boolean => emacs.handleKey({ key, ...mods });
    return { controller, emacs, press, text: () => controller.bufferRef.text };
  }

  it('выключенный режим ничего не забирает', () => {
    const buffer = new TextBuffer('abc');
    const controller = new EditorController(buffer);
    const emacs = new EmacsBinding(controller);
    expect(emacs.handleKey(chord('f', { ctrl: true }))).toBe(false);
    expect(controller.caret).toBe(0);
  });

  it('Ctrl+F/B двигают по знакам, Ctrl+A/E — к краям строки', () => {
    const { press, controller } = setup('hello', 0);
    press('f', { ctrl: true });
    expect(controller.caret).toBe(1);
    press('e', { ctrl: true });
    expect(controller.caret).toBe(5);
    press('a', { ctrl: true });
    expect(controller.caret).toBe(0);
    press('f', { ctrl: true });
    press('f', { ctrl: true });
    press('b', { ctrl: true });
    expect(controller.caret).toBe(1);
  });

  it('обычная буква не перехватывается (идёт в ввод)', () => {
    const { press } = setup('abc', 1);
    expect(press('я')).toBe(false);
    expect(press('a')).toBe(false);
  });

  it('Ctrl+D удаляет знак вперёд, Ctrl+H — назад', () => {
    const { press, text, controller } = setup('abc', 1);
    press('d', { ctrl: true });
    expect(text()).toBe('ac');
    expect(controller.caret).toBe(1);
    press('h', { ctrl: true });
    expect(text()).toBe('c');
    expect(controller.caret).toBe(0);
  });

  it('Ctrl+K убивает до конца строки, Ctrl+Y возвращает убитое', () => {
    const { press, text, controller } = setup('hello world', 5);
    press('k', { ctrl: true });
    expect(text()).toBe('hello');
    expect(controller.caret).toBe(5);
    press('y', { ctrl: true });
    expect(text()).toBe('hello world');
  });

  it('подряд идущие убийства сливаются в один кусок', () => {
    const { press, text } = setup('foo bar baz', 0);
    press('d', { alt: true });
    press('d', { alt: true });
    expect(text()).toBe(' baz');
    press('y', { ctrl: true });
    expect(text()).toBe('foo bar baz');
  });

  it('убийства назад сливаются в правильном порядке', () => {
    const { press, text } = setup('foo bar', 7);
    press('Backspace', { alt: true });
    press('u', { ctrl: true });
    expect(text()).toBe('');
    press('y', { ctrl: true });
    expect(text()).toBe('foo bar');
  });

  it('Ctrl+Y вставляет свежее, Alt+Y прокручивает к предыдущему убитому', () => {
    const { press, text } = setup('aaa\nbbb', 0);
    press('k', { ctrl: true });
    press('n', { ctrl: true });
    press('k', { ctrl: true });
    expect(text()).toBe('\n');
    press('y', { ctrl: true });
    expect(text()).toBe('\nbbb');
    press('y', { alt: true });
    expect(text()).toBe('\naaa');
  });

  it('Ctrl+K в конце строки убивает перевод строки', () => {
    const { press, text, controller } = setup('one\ntwo', 3);
    expect(controller.caret).toBe(3);
    press('k', { ctrl: true });
    expect(text()).toBe('onetwo');
  });

  it('Ctrl+U убивает до начала строки', () => {
    const { press, text } = setup('hello world', 5);
    press('u', { ctrl: true });
    expect(text()).toBe(' world');
  });

  it('Alt+D и Alt+Backspace убивают слово', () => {
    const forward = setup('foo bar baz', 0);
    forward.press('d', { alt: true });
    // M-d убивает слово до его конца (без пробела) — так делает Emacs.
    expect(forward.text()).toBe(' bar baz');

    const backward = setup('foo bar baz', 11);
    backward.press('Backspace', { alt: true });
    expect(backward.text()).toBe('foo bar ');
  });

  it('Ctrl+Space ставит метку, движения тянут выделение, Ctrl+G сбрасывает', () => {
    const { press, controller, emacs } = setup('hello', 1);
    press(' ', { ctrl: true });
    expect(emacs.mark).toBe(1);
    press('f', { ctrl: true });
    press('f', { ctrl: true });
    const sel = controller.selection;
    expect(Math.min(sel.anchor, sel.active)).toBe(1);
    expect(Math.max(sel.anchor, sel.active)).toBe(3);
    expect(isEmpty(sel)).toBe(false);
    press('g', { ctrl: true });
    expect(emacs.mark).toBeNull();
    expect(isEmpty(controller.selection)).toBe(true);
  });

  it('набор текста снимает метку', () => {
    const { press, emacs } = setup('hello', 1);
    press(' ', { ctrl: true });
    expect(emacs.mark).toBe(1);
    emacs.clearMark();
    expect(emacs.mark).toBeNull();
  });

  it('Ctrl+T меняет местами знаки', () => {
    const { press, text } = setup('ab', 2);
    press('t', { ctrl: true });
    expect(text()).toBe('ba');
  });

  it('Ctrl+O вставляет строку, каретка остаётся перед ней', () => {
    const { press, text, controller } = setup('ab', 1);
    press('o', { ctrl: true });
    expect(text()).toBe('a\nb');
    expect(controller.caret).toBe(1);
  });

  it('Ctrl+_ отменяет правку', () => {
    const { press, text } = setup('abc', 0);
    press('d', { ctrl: true });
    expect(text()).toBe('bc');
    press('_', { ctrl: true });
    expect(text()).toBe('abc');
  });

  it('Alt+< и Alt+> ведут к краям файла', () => {
    const { press, controller } = setup('one\ntwo\nthree', 5);
    press('>', { alt: true });
    expect(controller.caret).toBe(13);
    press('<', { alt: true });
    expect(controller.caret).toBe(0);
  });
});
