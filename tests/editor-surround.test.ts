import { describe, expect, it } from 'vitest';
import { TextBuffer } from '../src/renderer/editor/core/text-buffer';
import { surroundOptionById, surroundOptions, wrapSelection } from '../src/renderer/editor/input/surround';
import { caret, isEmpty } from '../src/renderer/editor/view/selection';

/** Буфер с текстом и выделением по подстрокам: `[` — начало, `]` — конец. */
function setup(marked: string): { buffer: TextBuffer; from: number; to: number; clean: string } {
  const from = marked.indexOf('[');
  const to = marked.indexOf(']') - 1;
  const clean = marked.replace('[', '').replace(']', '');
  return { buffer: new TextBuffer(clean), from, to, clean };
}

describe('surroundOptions: из чего выбирать', () => {
  it('общие пары есть у любого языка', () => {
    const ids = surroundOptions(null).map((option) => option.id);
    expect(ids).toEqual(['paren', 'bracket', 'brace', 'double-quote', 'single-quote', 'backtick']);
  });

  it('блочный комментарий добавляется языку, у которого он есть', () => {
    const typescript = surroundOptions('typescript');
    expect(typescript.some((option) => option.id === 'block-comment')).toBe(true);
    // У Python блочный комментарий — тройная строка, и он тоже доступен.
    expect(surroundOptions('python').some((option) => option.id === 'block-comment')).toBe(true);
    // У простого текста блочного комментария нет — остаются одни общие пары.
    expect(surroundOptions('plaintext').some((option) => option.id === 'block-comment')).toBe(false);
    expect(surroundOptions('plaintext').length).toBe(6);
  });

  it('тег доступен только разметке', () => {
    expect(surroundOptions('html').some((option) => option.id === 'tag')).toBe(true);
    expect(surroundOptions('typescript').some((option) => option.id === 'tag')).toBe(false);
  });

  it('вариант находится по ключу', () => {
    expect(surroundOptionById('typescript', 'brace')).toEqual({
      id: 'brace',
      label: 'Фигурные скобки',
      open: '{',
      close: '}',
    });
    expect(surroundOptionById('typescript', 'нет-такого')).toBeNull();
  });
});

describe('wrapSelection: обёртка выделения', () => {
  it('оборачивает выделение и оставляет его выделенным вокруг прежнего текста', () => {
    const { buffer, from, to, clean } = setup('a [b + c] d');
    const result = wrapSelection(buffer, { anchor: from, active: to }, surroundOptionById(null, 'paren')!);
    expect(buffer.text).toBe('a (b + c) d');
    expect(clean.slice(from, to)).toBe('b + c');
    // Выделен по-прежнему сам текст — обёртку можно накладывать одну за другой.
    expect(result!.selection).toEqual({ anchor: from + 1, active: from + 1 + 5 });
  });

  it('кавычки оборачивают так же, как скобки', () => {
    const { buffer, from, to } = setup('[слово]');
    wrapSelection(buffer, { anchor: from, active: to }, surroundOptionById(null, 'double-quote')!);
    expect(buffer.text).toBe('"слово"');
  });

  it('пустое выделение даёт пару с кареткой между знаками', () => {
    const buffer = new TextBuffer('ab');
    const result = wrapSelection(buffer, caret(1), surroundOptionById(null, 'brace')!);
    expect(buffer.text).toBe('a{}b');
    expect(result!.selection).toEqual({ anchor: 2, active: 2 });
  });

  it('блочный комментарий оборачивает выделение', () => {
    const { buffer, from, to } = setup('let x = [1 + 2];');
    const option = surroundOptionById('typescript', 'block-comment')!;
    wrapSelection(buffer, { anchor: from, active: to }, option);
    expect(buffer.text).toBe('let x = /*1 + 2*/;');
  });

  it('многострочное выделение оборачивается без переформатирования', () => {
    // Обёртка ставит знаки вокруг, но строки не двигает: переформатирование —
    // отдельная задача, и решать её за человека тут нечего.
    const body = '{\n  a,\n  b,\n}';
    const before = `f(${body})`;
    const from = before.indexOf(body);
    const buffer = new TextBuffer(before);
    wrapSelection(buffer, { anchor: from, active: from + body.length }, surroundOptionById(null, 'bracket')!);
    expect(buffer.text).toBe(`f([${body}])`);
    expect(buffer.lineCount).toBe(new TextBuffer(before).lineCount);
  });

  it('правка описана для истории: старт, что удалено и что вставлено', () => {
    const { buffer, from, to } = setup('[ab]');
    const result = wrapSelection(buffer, { anchor: from, active: to }, surroundOptionById(null, 'brace')!);
    expect(result!.change).toEqual({ start: 0, removed: 'ab', inserted: '{ab}' });
  });

  it('пустая обёртка ничего не делает', () => {
    const buffer = new TextBuffer('ab');
    expect(wrapSelection(buffer, { anchor: 0, active: 1 }, { id: 'x', label: 'x', open: '', close: '' })).toBeNull();
    expect(buffer.text).toBe('ab');
  });

  it('выделение остаётся непустым после обёртки', () => {
    const { buffer, from, to } = setup('[ab]');
    const result = wrapSelection(buffer, { anchor: from, active: to }, surroundOptionById(null, 'paren')!);
    expect(isEmpty(result!.selection)).toBe(false);
  });
});
