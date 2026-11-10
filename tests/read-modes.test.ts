import { describe, expect, it } from 'vitest';
import { importsBlock, indentationTree, readModeArg, treeMaxLines, treeOffset } from '../src/main/ai/agent-read-modes';

const TS_SAMPLE = [
  "import { a } from './a';",
  'import {',
  '  b,',
  "} from './b';",
  '',
  'export interface Box {',
  '  readonly x: number;',
  '  readonly y: number;',
  '}',
  '',
  'export function draw(box: Box): void {',
  '  if (box.x > 0) {',
  '    plot(box.x, box.y);',
  '  } else {',
  '    skip();',
  '  }',
  '}',
];

describe('дерево по отступам', () => {
  it('берёт заголовки и ветки, тела пропускает', () => {
    const tree = indentationTree(TS_SAMPLE);
    // Объявление на нулевой глубине — в каркасе; `if` внутри него — уже тело.
    expect(tree.text).toContain('11 | export function draw(box: Box): void { ▸');
    expect(tree.text).not.toContain('if (box.x > 0)');
    expect(tree.text).not.toContain('plot(box.x, box.y)');
    expect(tree.text).not.toContain('skip()');
  });

  it('объявление без тела и без продолжения в каркас не идёт', () => {
    // Одинокая строка: тело нигде не открывается — сказать каркасу нечего.
    const tree = indentationTree(['export interface Box {']);
    expect(tree.total).toBe(0);
  });

  it('импорты в каркас не идут — для них режим imports', () => {
    const tree = indentationTree(TS_SAMPLE);
    expect(tree.text).not.toContain("import { a } from './a';");
  });

  it('плоский файл данных даёт пустое дерево — каркаса нет', () => {
    const tree = indentationTree(['const x = 1;', 'const y = 2;']);
    expect(tree.total).toBe(0);
    expect(tree.text).toBe('');
  });

  it('сохраняет номера строк исходного файла и вложенность', () => {
    const tree = indentationTree([
      'export class A {',
      '  private x = 1;',
      '  run(): void {',
      '    this.go();',
      '  }',
      '}',
      '',
      'export function tail(): void {',
      '  go();',
      '}',
    ]);
    const rows = tree.text.split('\n');
    expect(rows[0]).toBe('1 | export class A {');
    expect(rows[1]).toBe('  3 | run(): void { ▸');
    expect(rows[2]).toBe('8 | export function tail(): void { ▸');
  });

  it('продолжение объявления уровнем не считается', () => {
    const tree = indentationTree([
      'const config = {',
      '  a: {',
      '    b: 1,',
      '  },',
      '  c: 2,',
      '};',
      'export function go(): void {',
      '  run();',
      '}',
    ]);
    expect(tree.text).toContain('7 | export function go(): void {');
    expect(tree.text).not.toContain('c: 2');
  });

  it('режет по maxLines и offset', () => {
    const lines = ['a() {', '  b() {', '    c();', '  }', '}', 'd() {', '  e() {', '    f();', '  }', '}'];
    const full = indentationTree(lines);
    expect(full.total).toBe(2);
    // Вложенные `b()`/`e()` — тела, а не уровни: уровней всего два.
    const page = indentationTree(lines, { maxLines: 1, offset: 2 });
    expect(page.shown).toBe(1);
    expect(page.text).toBe('6 | d() { ▸');
  });

  it('одиночное объявление без тела в дерево не идёт', () => {
    expect(indentationTree(['export interface Box {']).total).toBe(0);
  });
});

describe('импорты', () => {
  it('забирает импорты вместе с многострочными', () => {
    const block = importsBlock(TS_SAMPLE);
    expect(block.text).toContain("1 | import { a } from './a';");
    expect(block.text).toContain("4 | } from './b';");
    // `export interface Box {` после импортов не прилипает: импорт уже закрыт.
    expect(block.text).not.toContain('interface Box');
    expect(block.count).toBe(4);
  });

  it('файл без импортов — пусто', () => {
    expect(importsBlock(['const x = 1;']).count).toBe(0);
  });

  it('видит require, use и #include', () => {
    const block = importsBlock(["const fs = require('fs');", 'use strict;', '#include <stdio.h>', 'int main() {']);
    expect(block.count).toBe(3);
  });
});

describe('аргументы режима', () => {
  it('без mode — lines', () => {
    expect(readModeArg({})).toBe('lines');
    expect(readModeArg({ mode: null })).toBe('lines');
  });

  it('принимает режимы и регистр', () => {
    expect(readModeArg({ mode: 'indentation' })).toBe('indentation');
    expect(readModeArg({ mode: ' IMPORTS ' })).toBe('imports');
  });

  it('опечатка — ошибка, а не тихий lines', () => {
    expect(() => readModeArg({ mode: 'indent' })).toThrow(/indentation/);
    expect(() => readModeArg({ mode: 42 })).toThrow(/mode/);
  });

  it('maxLines и offset: мусор и нули — «по умолчанию»', () => {
    expect(treeMaxLines({ maxLines: 50 })).toBe(50);
    expect(treeMaxLines({ maxLines: 0 })).toBeUndefined();
    expect(treeMaxLines({ maxLines: 'abc' })).toBeUndefined();
    expect(treeOffset({ offset: 3 })).toBe(3);
    expect(treeOffset({ offset: -1 })).toBeUndefined();
  });
});
