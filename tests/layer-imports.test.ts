import { describe, expect, it } from 'vitest';
import { findImports } from '../src/shared/layer-imports';

/** Спецификаторы в порядке появления — тесты почти всегда про них. */
function specs(source: string): string[] {
  return findImports(source).map((found) => found.specifier);
}

describe('разбор импортов для сторожа границ', () => {
  it('обычный импорт, реэкспорт и динамический импорт', () => {
    expect(specs('import { a } from "./a";')).toEqual(['./a']);
    expect(specs('export { a } from "./b";')).toEqual(['./b']);
    expect(specs('export * from "./c";')).toEqual(['./c']);
    expect(specs('const m = await import("./d");')).toEqual(['./d']);
    expect(specs('import "./side-effect";')).toEqual(['./side-effect']);
  });

  it('типовый импорт виден так же, как обычный', () => {
    expect(specs('import type { Thing } from "node-pty";')).toEqual(['node-pty']);
  });

  it('одно- и двойные кавычки равноправны', () => {
    expect(specs("import a from './x';\nimport b from './y';")).toEqual(['./x', './y']);
  });

  it('импорт внутри строки не считается', () => {
    const source = "const s = 'import x from \"y\"';\nimport z from './real';";
    expect(specs(source)).toEqual(['./real']);
  });

  it('импорт внутри комментария не считается', () => {
    const source = ['// import x from "./commented"', '/* import y from "./block" */', 'import z from "./real";'].join(
      '\n',
    );
    expect(specs(source)).toEqual(['./real']);
  });

  it('другая кавычка внутри литерала не рвёт разбор', () => {
    // Ровно то, на чём спотыкалась первая версия: апостроф внутри двойных кавычек.
    const source = 'const t = "it\'s";\nimport z from "./real";';
    expect(specs(source)).toEqual(['./real']);
  });

  it('экранированная кавычка не закрывает литерал', () => {
    const source = "const t = 'a\\'b';\nimport z from './real';";
    expect(specs(source)).toEqual(['./real']);
  });

  it('слово from внутри идентификатора не ловится', () => {
    expect(specs('const fromage = 1;\nimport z from "./real";')).toEqual(['./real']);
  });

  it('шаблонная строка не ломает следующие импорты', () => {
    // Обратная кавычка с подстановкой внутри: разбор не должен уехать в неё и
    // считать подстановку кодом. Фрагмент собирается по частям — так в исходнике нет
    // уведомления «в строке подстановка».
    const tick = String.fromCharCode(96);
    const dollar = String.fromCharCode(36);
    const braces = String.fromCharCode(123) + 'b' + String.fromCharCode(125);
    const source = ['const t = ' + tick + 'a ' + dollar + braces + ' c' + tick + ';', 'import z from "./real";'].join(
      '\n',
    );
    expect(specs(source)).toEqual(['./real']);
  });

  it('отдаёт смещение спецификатора в исходнике', () => {
    const source = 'import z from "./real";';
    const [found] = findImports(source);
    expect(found?.specifier).toBe('./real');
    expect(source.slice(found?.offset)).toBe('./real";');
  });

  it('незакрытый литерал не выдумывает импорт', () => {
    expect(specs('import z from "./real')).toEqual([]);
  });
});
