import { describe, expect, it } from 'vitest';
import {
  findSubtypes,
  findSupertypes,
  normalizeBase,
  supportsInheritance,
  typeDeclarations,
} from '../src/shared/type-inheritance';

const ts = (text: string) => typeDeclarations(text, 'typescript');
const py = (text: string) => typeDeclarations(text, 'python');

describe('typeDeclarations: TypeScript и JavaScript', () => {
  it('класс с extends и implements', () => {
    const decls = ts('export class Child extends Parent implements A, B {}\n');
    expect(decls).toEqual([{ name: 'Child', line: 1, kind: 'class', bases: ['Parent', 'A', 'B'] }]);
  });

  it('модификаторы не мешают имени', () => {
    const decls = ts('export default abstract class Base<T> extends Other<T> {}\n');
    expect(decls[0]).toMatchObject({ name: 'Base', kind: 'class' });
    expect(decls[0]?.bases).toEqual(['Other']);
  });

  it('интерфейс с extends-списком', () => {
    const decls = ts('export interface Shape extends A, B.C {}\n');
    expect(decls).toEqual([{ name: 'Shape', line: 1, kind: 'interface', bases: ['A', 'B.C'] }]);
  });

  it('класс без родителей', () => {
    expect(ts('class Plain {}')).toEqual([{ name: 'Plain', line: 1, kind: 'class', bases: [] }]);
  });

  it('строчный комментарий не мешает', () => {
    const decls = ts('class Foo extends Bar {} // нужен родитель');
    expect(decls[0]?.bases).toEqual(['Bar']);
  });
});

describe('typeDeclarations: Python', () => {
  it('родители в скобках', () => {
    const decls = py('class Child(Parent, Mix):\n    pass\n');
    expect(decls).toEqual([{ name: 'Child', line: 1, kind: 'class', bases: ['Parent', 'Mix'] }]);
  });

  it('метакласс и дженерик-родитель отсеиваются/чистятся', () => {
    const decls = py('class Child(Base[T], metaclass=Meta):\n    pass\n');
    expect(decls[0]?.bases).toEqual(['Base[T]']);
  });

  it('класс без родителей и вложенный', () => {
    const decls = py('class Plain:\n    pass\n\nclass Outer:\n    class Inner(Base):\n        pass\n');
    // Вложенный класс верхним уровнем не считается.
    expect(decls.map((declaration) => declaration.name)).toEqual(['Plain', 'Outer']);
    expect(decls[1]?.bases).toEqual([]);
  });
});

describe('нормализация имени типа', () => {
  it('убирает дженерик и путь до модуля', () => {
    expect(normalizeBase('Base<T>')).toBe('Base');
    expect(normalizeBase('mod.Base')).toBe('Base');
    expect(normalizeBase('React.Component')).toBe('Component');
    expect(normalizeBase(' Plain ')).toBe('Plain');
  });
});

describe('поиск наследования', () => {
  const text = [
    'class Base {}',
    'class Child extends Base {}',
    'class Grand extends mod.Child {}',
    'interface Iface extends Base, Other {}',
  ].join('\n');

  it('кто наследует имя', () => {
    const subtypes = findSubtypes(text, 'typescript', 'Base');
    expect(subtypes.map((declaration) => declaration.name)).toEqual(['Child', 'Iface']);
  });

  it('совпадение по последнему отрезку пути', () => {
    const subtypes = findSubtypes(text, 'typescript', 'Child');
    expect(subtypes.map((declaration) => declaration.name)).toEqual(['Grand']);
  });

  it('от кого наследует имя', () => {
    const supertypes = findSupertypes(text, 'typescript', 'Iface');
    expect(supertypes).toEqual([{ name: 'Iface', line: 4, kind: 'interface', bases: ['Base', 'Other'] }]);
  });

  it('не нашлось — пусто, а не ошибка', () => {
    expect(findSubtypes(text, 'typescript', 'Nope')).toEqual([]);
    expect(findSupertypes(text, 'typescript', 'Nope')).toEqual([]);
  });
});

describe('supportsInheritance', () => {
  it('JS/TS и Python поддержаны, прочие — нет', () => {
    expect(supportsInheritance('typescript')).toBe(true);
    expect(supportsInheritance('javascript')).toBe(true);
    expect(supportsInheritance('python')).toBe(true);
    expect(supportsInheritance('css')).toBe(false);
    expect(supportsInheritance(null)).toBe(false);
  });

  it('неизвестный язык — пусто', () => {
    expect(typeDeclarations('class A(B):', 'go')).toEqual([]);
    expect(findSubtypes('class A(B):', null, 'B')).toEqual([]);
  });
});
