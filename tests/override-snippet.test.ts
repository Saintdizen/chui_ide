import { describe, expect, it } from 'vitest';
import {
  argumentNames,
  declarationOf,
  enclosingClassAt,
  overrideSnippet,
  paramsOf,
} from '../src/renderer/editor/complete/override';

/**
 * Переопределение метода предка: где класс, какие параметры и как выглядит заглушка.
 *
 * Проверяем то, на чём легко ошибиться молча: класс вокруг курсора (вложенный и
 * закончившийся), параметры с вложенными скобками, `self` у Python и то, что вызов
 * предка идёт с именами, а не с объявлениями типов.
 */

const python = [
  'import abc',
  '',
  'class Base(abc.ABC):',
  '    def run(self, value: int):',
  '        pass',
  '',
  'def helper():',
  '    pass',
  '',
].join('\n');

/** Смещение начала строки с номером `line` (1-based). */
function offsetOf(text: string, line: number, column = 1): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset + column - 1;
}

describe('enclosingClassAt', () => {
  it('находит класс вокруг курсора и конец его тела', () => {
    const found = enclosingClassAt(python, offsetOf(python, 5, 9));
    expect(found).toMatchObject({ name: 'Base', indent: 0, endLine: 5, language: 'python' });
  });

  it('вне класса — ничего: верхний уровень файла не класс', () => {
    expect(enclosingClassAt(python, offsetOf(python, 8, 5))).toBeNull();
  });

  it('TypeScript: класс с `{` распознаётся как javascript', () => {
    const text = 'export class Widget extends Base {\n  draw() {}\n}\n';
    expect(enclosingClassAt(text, offsetOf(text, 2, 4))).toMatchObject({
      name: 'Widget',
      language: 'javascript',
      endLine: 2,
    });
  });
});

describe('paramsOf', () => {
  it('Python: параметры как есть, вместе с self', () => {
    expect(paramsOf('    def run(self, value: int = 3):')).toBe('self, value: int = 3');
  });

  it('вложенные скобки не обрывают список', () => {
    expect(paramsOf('  draw(style: dict[str, int], size: int) {')).toBe('style: dict[str, int], size: int');
  });

  it('без параметров — пустая строка', () => {
    expect(paramsOf('  draw() {')).toBe('');
  });
});

describe('overrideSnippet', () => {
  it('Python: def с self, вызов предка без self и без типов', () => {
    const snippet = overrideSnippet({ language: 'python', name: 'run', params: 'self, value: int', indent: 4 });
    expect(snippet).toContain('def run(self, value: int):');
    expect(snippet).toContain('super().run(value)');
  });

  it('Python: self добавляется, если предок его не назвал', () => {
    expect(overrideSnippet({ language: 'python', name: 'run', params: '', indent: 4 })).toContain('def run(self):');
  });

  it('TypeScript: метод с телом и вызовом super', () => {
    const snippet = overrideSnippet({ language: 'javascript', name: 'draw', params: 'style: Style', indent: 2 });
    expect(snippet).toContain('draw(style: Style) {');
    expect(snippet).toContain('super.draw(style);');
  });
});

describe('argumentNames', () => {
  it('нормализует имена: без типов, значений по умолчанию и self', () => {
    expect(argumentNames('self, value: int = 3, *rest', 'python')).toBe('value, *rest');
    expect(argumentNames('style: Style, size = 10', 'javascript')).toBe('style, size');
  });

  it('именованные параметры передаются по имени: позиционно они падают', () => {
    // `def run(self, *, strict=False)` — `super().run(value, strict)` дал бы TypeError.
    expect(argumentNames('self, value: int, *, strict=False', 'python')).toBe('value, strict=strict');
    expect(argumentNames('self, *, flag', 'python')).toBe('flag=flag');
  });

  it('**kwargs остаётся со звёздочками: иначе словарь развернётся в один аргумент', () => {
    expect(argumentNames('self, **kwargs', 'python')).toBe('**kwargs');
  });
});

describe('declarationOf', () => {
  it('находит строку объявления по имени, не путая с вызовом', () => {
    const text = '  super().run(1)\n    def run(self, value):\n        pass\n';
    expect(declarationOf(text, 'run')).toBe('    def run(self, value):');
  });

  it('нет такого метода — null', () => {
    expect(declarationOf('def other():\n    pass\n', 'run')).toBeNull();
  });
});
