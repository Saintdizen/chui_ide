import { describe, expect, it } from 'vitest';
import { exportedNames, supportsExports } from '../src/shared/symbol-exports';

const ts = (text: string) => exportedNames(text, 'typescript');
const py = (text: string) => exportedNames(text, 'python');

describe('exportedNames: TypeScript и JavaScript', () => {
  it('объявления через export', () => {
    const names = ts(
      [
        'export const a = 1;',
        'export function foo() {}',
        'export async function bar() {}',
        'export class Baz {}',
        'export interface Shape {}',
        'export type Alias = number;',
        'export enum Color {}',
      ].join('\n'),
    );
    expect(names.map((entry) => entry.name)).toEqual(['a', 'foo', 'bar', 'Baz', 'Shape', 'Alias', 'Color']);
    expect(names.every((entry) => entry.kind === 'declaration')).toBe(true);
    expect(names[1]?.line).toBe(2);
  });

  it('список экспорта, алиас виден снаружи', () => {
    const names = ts('export { one, two as three };');
    expect(names).toEqual([
      { name: 'one', line: 1, kind: 'named' },
      { name: 'three', line: 1, kind: 'named' },
    ]);
  });

  it('экспорт по умолчанию и звёздочка', () => {
    expect(ts('export default function main() {}')[0]).toEqual({ name: 'default', line: 1, kind: 'default' });
    expect(ts("export * from './x'")[0]).toEqual({ name: '*', line: 1, kind: 'star' });
    expect(ts("export * as ns from './x'")[0]).toEqual({ name: 'ns', line: 1, kind: 'star' });
  });

  it('реэкспорт с указанием модуля', () => {
    expect(ts("export { helper } from './helper';")).toEqual([{ name: 'helper', line: 1, kind: 'named' }]);
  });

  it('строчный комментарий не мешает', () => {
    expect(ts('export const value = 1; // вот это значение')).toEqual([
      { name: 'value', line: 1, kind: 'declaration' },
    ]);
  });

  it('не экспортированное наружу не попадает', () => {
    expect(ts('const local = 1;\nfunction inner() {}\nimport { x } from "y";')).toEqual([]);
  });

  it('тип в списке экспорта тоже виден', () => {
    expect(ts('export type { Foo };').map((entry) => entry.name)).toEqual(['Foo']);
  });
});

describe('exportedNames: Python', () => {
  it('публичные def и class верхнего уровня', () => {
    const names = py('def foo():\n    pass\n\n\nclass Bar:\n    pass\n');
    expect(names).toEqual([
      { name: 'foo', line: 1, kind: 'declaration' },
      { name: 'Bar', line: 5, kind: 'declaration' },
    ]);
  });

  it('приватное и вложенное наружу не выходит', () => {
    const names = py('def _secret():\n    pass\n\n\ndef outer():\n    def inner():\n        pass\n');
    expect(names.map((entry) => entry.name)).toEqual(['outer']);
  });

  it('__all__ задаёт видимое явно, в том числе на нескольких строках', () => {
    const names = py("__all__ = [\n    'foo',\n    'bar',\n]\n");
    expect(names).toEqual([
      { name: 'foo', line: 1, kind: 'named' },
      { name: 'bar', line: 1, kind: 'named' },
    ]);
  });

  it('async def виден', () => {
    expect(py('async def fetch():\n    pass\n').map((entry) => entry.name)).toEqual(['fetch']);
  });
});

describe('supportsExports: где разбор есть', () => {
  it('JS/TS и Python поддержаны', () => {
    expect(supportsExports('typescript')).toBe(true);
    expect(supportsExports('javascript')).toBe(true);
    expect(supportsExports('python')).toBe(true);
  });

  it('прочие языки — нет', () => {
    expect(supportsExports('css')).toBe(false);
    expect(supportsExports('plaintext')).toBe(false);
    expect(supportsExports(null)).toBe(false);
  });

  it('неизвестный язык — пусто', () => {
    expect(exportedNames('export const a = 1;', 'css')).toEqual([]);
    expect(exportedNames('export const a = 1;', null)).toEqual([]);
  });
});
