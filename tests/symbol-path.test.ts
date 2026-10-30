import { describe, expect, it } from 'vitest';
import type { FileSymbol } from '../src/shared/lsp-symbols';
import { symbolPathAt, symbolPathLabel } from '../src/shared/symbol-path';

function sym(name: string, line: number, endLine: number, children: FileSymbol[] = [], kind = 'класс'): FileSymbol {
  return { name, kind, line, endLine, children };
}

const tree: FileSymbol[] = [
  sym('App', 1, 100, [
    sym('Chat', 10, 90, [sym('render', 40, 60, [], 'метод'), sym('close', 70, 75, [], 'метод')], 'класс'),
  ]),
  sym('main', 102, 110, [], 'функция'),
];

describe('symbolPathAt: путь к объявлению по строке', () => {
  it('курсор внутри метода — цепочка от самого внешнего', () => {
    expect(symbolPathAt(tree, 50).map((l) => l.name)).toEqual(['App', 'Chat', 'render']);
  });

  it('на границах диапазона символ свой: и в начале, и в конце', () => {
    expect(symbolPathAt(tree, 40).map((l) => l.name)).toEqual(['App', 'Chat', 'render']);
    expect(symbolPathAt(tree, 60).map((l) => l.name)).toEqual(['App', 'Chat', 'render']);
  });

  it('рядом с методом, но не внутри — глубина меньше', () => {
    expect(symbolPathAt(tree, 20).map((l) => l.name)).toEqual(['App', 'Chat']);
  });

  it('вне всякого объявления — пустая цепочка', () => {
    expect(symbolPathAt(tree, 101)).toEqual([]);
    expect(symbolPathAt(tree, 0)).toEqual([]);
  });

  it('верхний уровень: одна ссылка', () => {
    expect(symbolPathAt(tree, 105).map((l) => l.name)).toEqual(['main']);
  });

  it('пустая структура — пустая цепочка, а не падение', () => {
    expect(symbolPathAt([], 5)).toEqual([]);
  });

  it('ссылка хранит вид и строку — по ним переносимся к объявлению', () => {
    const [, chat, render] = symbolPathAt(tree, 50);
    expect(chat).toEqual({ name: 'Chat', kind: 'класс', line: 10 });
    expect(render).toEqual({ name: 'render', kind: 'метод', line: 40 });
  });

  it('плоский список от сервера: побеждает самый тесный диапазон', () => {
    // Серверы в форме SymbolInformation отдают всех на равных: метод и его
    // класс покрывают строку одновременно. Брать первого — показать класс
    // вместо метода, то есть соврать про место.
    const flat: FileSymbol[] = [sym('Chat', 10, 90), sym('render', 40, 60)];
    expect(symbolPathAt(flat, 50).map((l) => l.name)).toEqual(['render']);
  });

  it('однострочный символ на курсоре виден', () => {
    const single: FileSymbol[] = [sym('value', 7, 7, [], 'поле')];
    expect(symbolPathAt(single, 7).map((l) => l.name)).toEqual(['value']);
  });
});

describe('symbolPathLabel', () => {
  it('собирает цепочку словами через разделитель', () => {
    expect(symbolPathLabel(symbolPathAt(tree, 50))).toBe('App › Chat › render');
  });

  it('пустая цепочка — пустая строка', () => {
    expect(symbolPathLabel([])).toBe('');
  });
});
