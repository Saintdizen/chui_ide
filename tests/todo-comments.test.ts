import { describe, expect, it } from 'vitest';
import { todoMarks } from '../src/shared/todo-comments';

/**
 * Поиск пометок TODO/FIXME в строке. Пометка — целое слово: `TODOS` или `mytodo`
 * пометками не считаются, иначе подсветка цеплялась бы к обычным словам.
 */
describe('todoMarks', () => {
  it('находит пометки и их границы', () => {
    expect(todoMarks('// TODO: починить')).toEqual([{ start: 3, end: 7 }]);
    expect(todoMarks('# FIXME later')).toEqual([{ start: 2, end: 7 }]);
  });

  it('несколько пометок в строке', () => {
    expect(todoMarks('TODO и XXX')).toEqual([
      { start: 0, end: 4 },
      { start: 7, end: 10 },
    ]);
  });

  it('только целое слово: TODOS и myTODO — не пометки', () => {
    expect(todoMarks('TODOS myTODO TODO2')).toEqual([]);
  });

  it('регистр не важен', () => {
    expect(todoMarks('todo и Hack')).toEqual([
      { start: 0, end: 4 },
      { start: 7, end: 11 },
    ]);
  });

  it('нет пометок — пустой список', () => {
    expect(todoMarks('обычная строка')).toEqual([]);
  });

  it('повторный вызов не «залипает» на прошлой строке', () => {
    expect(todoMarks('TODO')).toEqual([{ start: 0, end: 4 }]);
    expect(todoMarks('TODO')).toEqual([{ start: 0, end: 4 }]);
  });
});
