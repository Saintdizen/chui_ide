import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { EditorController } from '../src/renderer/editor/input/editor-controller';
import type { KeyChord } from '../src/renderer/editor/input/keymap';
import { VimBinding, type VimSearchAction } from '../src/renderer/editor/input/vim-binding';
import {
  isHorizontalMotion,
  toggleCaseText,
  vimInitialState,
  vimKey,
  vimMotionRange,
  vimMoveTarget,
  type VimCommand,
  type VimState,
} from '../src/renderer/editor/input/vim';

/**
 * Vim-режим: разбор клавиш (режим, счётчики, операторы) и подсчёт движений и участков.
 * Проверяется без окна: на вход — клавиши и текст, на выходе — команда или смещение.
 */

const buffer = (text: string): TextBuffer => new TextBuffer(text);
const chord = (key: string, mods: Omit<KeyChord, 'key'> = {}): KeyChord => ({ key, ...mods });

/** Прогнать последовательность клавиш и вернуть последнюю команду (или null, если ждали). */
function run(
  chords: readonly KeyChord[],
  start: VimState = vimInitialState('normal'),
): { command: VimCommand | null; state: VimState } {
  let state = start;
  let command: VimCommand | null = null;
  for (const key of chords) {
    const step = vimKey(key, state);
    if (step.kind === 'run') {
      command = step.command;
      state = step.state;
    } else if (step.kind === 'wait') {
      state = step.state;
    } else {
      command = null;
    }
  }
  return { command, state };
}

describe('разбор клавиш Vim', () => {
  it('i входит в режим вставки и ставит каретку перед знаком', () => {
    const { command, state } = run([chord('i')]);
    expect(command).toEqual({ kind: 'enterInsert', at: 'before' });
    expect(state.mode).toBe('insert');
  });

  it('a, A, I, o, O задают разное место вставки', () => {
    expect(run([chord('a')]).command).toEqual({ kind: 'enterInsert', at: 'after' });
    expect(run([chord('A')]).command).toEqual({ kind: 'enterInsert', at: 'lineEnd' });
    expect(run([chord('I')]).command).toEqual({ kind: 'enterInsert', at: 'lineStart' });
    expect(run([chord('o')]).command).toEqual({ kind: 'enterInsert', at: 'newLineBelow' });
    expect(run([chord('O')]).command).toEqual({ kind: 'enterInsert', at: 'newLineAbove' });
  });

  it('движения разбираются без оператора', () => {
    expect(run([chord('j')]).command).toEqual({ kind: 'motion', motion: 'lineDown', count: 1 });
    expect(run([chord('w')]).command).toEqual({ kind: 'motion', motion: 'wordForward', count: 1 });
    expect(run([chord('$')]).command).toEqual({ kind: 'motion', motion: 'lineEnd', count: 1 });
    expect(run([chord('0')]).command).toEqual({ kind: 'motion', motion: 'lineStart', count: 1 });
  });

  it('счётчик умножает движение', () => {
    expect(run([chord('3'), chord('j')]).command).toEqual({ kind: 'motion', motion: 'lineDown', count: 3 });
    expect(run([chord('1'), chord('2'), chord('w')]).command).toEqual({
      kind: 'motion',
      motion: 'wordForward',
      count: 12,
    });
  });

  it('оператор + движение и удвоенный оператор', () => {
    expect(run([chord('d'), chord('w')]).command).toEqual({
      kind: 'operator',
      operator: 'delete',
      motion: 'wordForward',
      count: 1,
    });
    expect(run([chord('c'), chord('$')]).command).toEqual({
      kind: 'operator',
      operator: 'change',
      motion: 'lineEnd',
      count: 1,
    });
    expect(run([chord('y'), chord('e')]).command).toEqual({
      kind: 'operator',
      operator: 'yank',
      motion: 'wordEnd',
      count: 1,
    });
    expect(run([chord('d'), chord('d')]).command).toEqual({ kind: 'operatorLines', operator: 'delete', count: 1 });
    expect(run([chord('y'), chord('y')]).command).toEqual({ kind: 'operatorLines', operator: 'yank', count: 1 });
  });

  it('счётчики оператора и движения перемножаются', () => {
    expect(run([chord('2'), chord('d'), chord('3'), chord('w')]).command).toEqual({
      kind: 'operator',
      operator: 'delete',
      motion: 'wordForward',
      count: 6,
    });
    expect(run([chord('2'), chord('d'), chord('d')]).command).toEqual({
      kind: 'operatorLines',
      operator: 'delete',
      count: 2,
    });
  });

  it('объекты текста: diw и daw', () => {
    expect(run([chord('d'), chord('i'), chord('w')]).command).toEqual({
      kind: 'operator',
      operator: 'delete',
      motion: 'innerWord',
      count: 1,
    });
    expect(run([chord('d'), chord('a'), chord('w')]).command).toEqual({
      kind: 'operator',
      operator: 'delete',
      motion: 'aWord',
      count: 1,
    });
  });

  it('gg ведёт к началу файла, G — к концу', () => {
    expect(run([chord('g'), chord('g')]).command).toEqual({ kind: 'motion', motion: 'docStart', count: 1 });
    expect(run([chord('G')]).command).toEqual({ kind: 'motion', motion: 'docEnd', count: 1 });
  });

  it('r заменяет знак на следующий набранный', () => {
    expect(run([chord('r'), chord('x')]).command).toEqual({ kind: 'replaceChar', char: 'x', count: 1 });
    expect(run([chord('3'), chord('r'), chord('z')]).command).toEqual({ kind: 'replaceChar', char: 'z', count: 3 });
  });

  it('простые правки: x, X, D, C, p, P, u, ~, J', () => {
    expect(run([chord('x')]).command).toEqual({ kind: 'deleteChar', count: 1 });
    expect(run([chord('X')]).command).toEqual({ kind: 'deleteCharBefore', count: 1 });
    expect(run([chord('D')]).command).toEqual({ kind: 'deleteToEnd', change: false });
    expect(run([chord('C')]).command).toEqual({ kind: 'deleteToEnd', change: true });
    expect(run([chord('p')]).command).toEqual({ kind: 'put', after: true, count: 1 });
    expect(run([chord('P')]).command).toEqual({ kind: 'put', after: false, count: 1 });
    expect(run([chord('u')]).command).toEqual({ kind: 'undo' });
    expect(run([chord('~')]).command).toEqual({ kind: 'toggleCase', count: 1 });
    expect(run([chord('J')]).command).toEqual({ kind: 'join', count: 1 });
  });

  it('Ctrl+r — повтор; прочие Ctrl-сочетания идут обычным путём', () => {
    expect(run([chord('r', { ctrl: true })]).command).toEqual({ kind: 'redo' });
    expect(vimKey(chord('a', { ctrl: true }), vimInitialState('normal')).kind).toBe('pass');
  });

  it('визуальный режим: вход, движения тянут выделение, операторы', () => {
    const entered = run([chord('v')]);
    expect(entered.command).toEqual({ kind: 'mode', mode: 'visual' });
    expect(entered.state.mode).toBe('visual');

    const moved = run([chord('l')], entered.state);
    expect(moved.command).toEqual({ kind: 'motion', motion: 'charRight', count: 1 });

    const deleted = run([chord('d')], entered.state);
    expect(deleted.command).toEqual({ kind: 'operatorSelection', operator: 'delete' });

    const yanked = run([chord('y')], entered.state);
    expect(yanked.command).toEqual({ kind: 'operatorSelection', operator: 'yank' });
  });

  it('V включает визуально-строчный режим, o меняет концы', () => {
    const line = run([chord('V')]);
    expect(line.command).toEqual({ kind: 'mode', mode: 'visual-line' });
    expect(line.state.mode).toBe('visual-line');
    const swap = run([chord('o')], line.state);
    expect(swap.command).toEqual({ kind: 'swapEnds' });
  });

  it('стрелки и Escape в нормальном режиме', () => {
    expect(run([chord('ArrowLeft')]).command).toEqual({ kind: 'motion', motion: 'charLeft', count: 1 });
    expect(run([chord('ArrowDown')]).command).toEqual({ kind: 'motion', motion: 'lineDown', count: 1 });
    expect(run([chord('Home')]).command).toEqual({ kind: 'motion', motion: 'lineStart', count: 1 });
    expect(run([chord('Escape')]).command).toEqual({ kind: 'mode', mode: 'normal' });
  });

  it('неизвестная печатная клавиша в нормальном режиме гасится (не печатается)', () => {
    const step = vimKey(chord('q'), vimInitialState('normal'));
    expect(step.kind).toBe('wait');
  });
});

describe('движения Vim', () => {
  it('h и l не выходят за строку', () => {
    const text = buffer('abc');
    expect(vimMoveTarget(text, 0, 'charLeft', 1).offset).toBe(0);
    expect(vimMoveTarget(text, 0, 'charRight', 1).offset).toBe(1);
    expect(vimMoveTarget(text, 3, 'charRight', 1).offset).toBe(3);
    expect(vimMoveTarget(text, 3, 'charLeft', 1).offset).toBe(2);
  });

  it('w и e ходят по словам', () => {
    const text = buffer('foo bar baz');
    expect(vimMoveTarget(text, 0, 'wordForward', 1).offset).toBe(4);
    expect(vimMoveTarget(text, 0, 'wordForward', 2).offset).toBe(8);
    expect(vimMoveTarget(text, 0, 'wordEnd', 1).offset).toBe(2);
    expect(vimMoveTarget(text, 0, 'wordEnd', 2).offset).toBe(6);
  });

  it('b возвращает к началу предыдущего слова', () => {
    const text = buffer('foo bar baz');
    expect(vimMoveTarget(text, 11, 'wordBackward', 1).offset).toBe(8);
    expect(vimMoveTarget(text, 11, 'wordBackward', 2).offset).toBe(4);
  });

  it('w переходит на следующую строку в её первое слово', () => {
    const text = buffer('foo\nbar');
    expect(vimMoveTarget(text, 1, 'wordForward', 1).offset).toBe(4);
  });

  it('вертикаль держит желаемый столбец', () => {
    const text = buffer('aaaaa\nb\nccccccccc');
    const down = vimMoveTarget(text, 3, 'lineDown', 1, 3);
    expect(down.offset).toBe(7);
    expect(down.goal).toBe(3);
    const down2 = vimMoveTarget(text, down.offset, 'lineDown', 1, down.goal);
    expect(down2.offset).toBe(11);
  });

  it('gg и G ведут к краям файла', () => {
    const text = buffer('alpha\n  beta\n');
    expect(vimMoveTarget(text, 5, 'docStart', 1).offset).toBe(0);
    expect(vimMoveTarget(text, 0, 'docEnd', 1).offset).toBe(13);
  });

  it('isHorizontalMotion отмечает вертикальные движения', () => {
    expect(isHorizontalMotion('charRight')).toBe(true);
    expect(isHorizontalMotion('lineDown')).toBe(false);
    expect(isHorizontalMotion('docEnd')).toBe(false);
  });
});

describe('участки операторов Vim', () => {
  it('dw захватывает слово с пробелом, de — только слово', () => {
    const text = buffer('foo bar baz');
    expect(vimMotionRange(text, 0, 'wordForward', 1)).toEqual({ start: 0, end: 4, linewise: false });
    expect(vimMotionRange(text, 0, 'wordEnd', 1)).toEqual({ start: 0, end: 3, linewise: false });
  });

  it('d$ и d0 захватывают до краёв строки', () => {
    const text = buffer('foo bar baz');
    expect(vimMotionRange(text, 4, 'lineEnd', 1)).toEqual({ start: 4, end: 11, linewise: false });
    expect(vimMotionRange(text, 4, 'lineStart', 1)).toEqual({ start: 0, end: 4, linewise: false });
  });

  it('вертикальное движение даёт построчный участок', () => {
    const text = buffer('one\ntwo\nthree');
    expect(vimMotionRange(text, 0, 'lineDown', 1)).toEqual({ start: 0, end: 8, linewise: true });
  });

  it('объекты текста iw и aw', () => {
    const text = buffer('foo bar baz');
    expect(vimMotionRange(text, 5, 'innerWord', 1)).toEqual({ start: 4, end: 7, linewise: false });
    expect(vimMotionRange(text, 5, 'aWord', 1)).toEqual({ start: 4, end: 8, linewise: false });
  });
});

describe('смена регистра', () => {
  it('toggleCaseText переворачивает регистр знаков', () => {
    expect(toggleCaseText('aBc')).toBe('AbC');
    expect(toggleCaseText('Привет')).toBe('пРИВЕТ');
  });
});

function setup(text: string, caret = 0, onSearch?: (action: VimSearchAction) => void) {
  const buffer = new TextBuffer(text);
  const controller = new EditorController(buffer);
  controller.setSelection({ anchor: caret, active: caret });
  const vim = new VimBinding(controller, undefined, onSearch);
  vim.setEnabled(true);
  const press = (key: string): void => {
    vim.handleKey({ key });
  };
  /**
   * Набор в режиме вставки: Vim пропускает знак дальше (возвращает `false`), а текст
   * печатает поле ввода — здесь его роль играет `controller.type`. Знак при этом
   * проходит через Vim, поэтому попадает в запись для повтора `.`.
   */
  const type = (keys: string): void => {
    for (const ch of keys) {
      if (!vim.handleKey({ key: ch })) controller.type(ch);
    }
  };
  return { controller, vim, press, type, text: () => controller.bufferRef.text };
}

describe('применение команд (VimBinding)', () => {
  it('dw удаляет слово с пробелом', () => {
    const { press, text, controller } = setup('foo bar baz', 0);
    press('d');
    press('w');
    expect(text()).toBe('bar baz');
    expect(controller.caret).toBe(0);
  });

  it('2x удаляет два знака', () => {
    const { press, text } = setup('abcdef', 0);
    press('2');
    press('x');
    expect(text()).toBe('cdef');
  });

  it('dd удаляет строку целиком', () => {
    const { press, text } = setup('one\ntwo\nthree', 0);
    press('d');
    press('d');
    expect(text()).toBe('two\nthree');
  });

  it('yy и p вставляют строку ниже', () => {
    const { press, text } = setup('one\ntwo', 0);
    press('y');
    press('y');
    press('p');
    expect(text()).toBe('one\none\ntwo');
  });

  it('cw меняет слово до его конца и входит в режим вставки', () => {
    const { press, text, vim } = setup('foo bar', 0);
    press('c');
    press('w');
    expect(text()).toBe(' bar');
    expect(vim.mode).toBe('insert');
  });

  it('diw удаляет слово под кареткой', () => {
    const { press, text } = setup('foo bar baz', 5);
    press('d');
    press('i');
    press('w');
    expect(text()).toBe('foo  baz');
  });

  it('Escape выводит из вставки в нормальный режим', () => {
    const { press, vim } = setup('abc', 1);
    press('i');
    expect(vim.mode).toBe('insert');
    press('Escape');
    expect(vim.mode).toBe('normal');
  });

  it('u отменяет последнюю правку одним шагом', () => {
    const { press, text } = setup('one\ntwo\nthree', 0);
    press('d');
    press('d');
    expect(text()).toBe('two\nthree');
    press('u');
    expect(text()).toBe('one\ntwo\nthree');
  });

  it('выключенный режим ничего не забирает', () => {
    const buffer = new TextBuffer('abc');
    const controller = new EditorController(buffer);
    const vim = new VimBinding(controller);
    expect(vim.mode).toBe('insert');
    expect(vim.handleKey({ key: 'x' })).toBe(false);
    expect(controller.bufferRef.text).toBe('abc');
  });
});

describe('разбор повтора и поиска (vim.ts)', () => {
  it('точка, слеш, вопросительный знак и n/N дают свои команды', () => {
    expect(run([chord('.')]).command).toEqual({ kind: 'repeat' });
    expect(run([chord('/')]).command).toEqual({ kind: 'search', forward: true });
    expect(run([chord('?')]).command).toEqual({ kind: 'search', forward: false });
    expect(run([chord('n')]).command).toEqual({ kind: 'searchRepeat', same: true });
    expect(run([chord('N')]).command).toEqual({ kind: 'searchRepeat', same: false });
  });

  it('счётчик перед точкой не мешает разбору', () => {
    // Счётчик у `.` мы пока не учитываем, но набранное число не должно ломать разбор.
    expect(run([chord('3'), chord('.')]).command).toEqual({ kind: 'repeat' });
  });
});

describe('повтор правки (`.`)', () => {
  it('повторяет удаление слова (dw)', () => {
    const { press, text } = setup('foo bar baz', 0);
    press('d');
    press('w');
    expect(text()).toBe('bar baz');
    press('.');
    expect(text()).toBe('baz');
  });

  it('повторяет удаление знака (x) и строки (dd)', () => {
    const { press, text } = setup('abcdef', 0);
    press('x');
    press('.');
    expect(text()).toBe('cdef');

    const lines = setup('one\ntwo\nthree', 0);
    lines.press('d');
    lines.press('d');
    lines.press('.');
    expect(lines.text()).toBe('three');
  });

  it('повторяет вставку вместе с набранным текстом (i…Esc)', () => {
    const { press, type, text } = setup('abc', 0);
    press('i');
    type('hello');
    press('Escape');
    expect(text()).toBe('helloabc');
    press('$');
    press('.');
    expect(text()).toBe('helloabchello');
  });

  it('повторяет замену слова (cw…Esc) целиком', () => {
    const { press, type, text } = setup('foo bar', 0);
    press('c');
    press('w');
    type('foo');
    press('Escape');
    expect(text()).toBe('foo bar');
    press('w');
    press('.');
    expect(text()).toBe('foo foo');
  });

  it('без правки повторять нечего', () => {
    const { press, text } = setup('abc', 1);
    press('.');
    expect(text()).toBe('abc');
  });

  it('вставку со стрелками не повторяем, но прежняя правка остаётся', () => {
    const { press, vim, text } = setup('abcdef', 0);
    press('x');
    expect(text()).toBe('bcdef');
    // Вставка со стрелкой: текст её повтору не поддаётся, поэтому прежний повтор (x) цел.
    press('i');
    vim.handleKey({ key: 'ArrowLeft' });
    press('Escape');
    press('.');
    expect(text()).toBe('cdef');
  });
});

describe('поиск Vim отдаётся наружу (`/`, `?`, `n`, `N`)', () => {
  function withSearch(): { actions: VimSearchAction[]; press: (key: string) => void } {
    const actions: VimSearchAction[] = [];
    const { press } = setup('abc', 0, (action) => actions.push(action));
    return { actions, press };
  }

  it('слеш и вопросительный знак просят открыть поиск с направлением', () => {
    const { actions, press } = withSearch();
    press('/');
    press('?');
    expect(actions).toEqual([
      { kind: 'open', forward: true },
      { kind: 'open', forward: false },
    ]);
  });

  it('n идёт в ту же сторону, что последний поиск, N — в обратную', () => {
    const forward = withSearch();
    forward.press('/');
    forward.press('n');
    forward.press('N');
    expect(forward.actions.slice(1)).toEqual([
      { kind: 'step', forward: true },
      { kind: 'step', forward: false },
    ]);

    const backward = withSearch();
    backward.press('?');
    backward.press('n');
    backward.press('N');
    expect(backward.actions.slice(1)).toEqual([
      { kind: 'step', forward: false },
      { kind: 'step', forward: true },
    ]);
  });
});
