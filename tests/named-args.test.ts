import { describe, expect, it } from 'vitest';
import { callContextAt, namedArgumentItems, parameterNames } from '../src/renderer/editor/complete/named-args';

/**
 * Именованные аргументы вызова.
 *
 * Ломается здесь чаще всего одно и то же: разбор заходит не в тот вызов (вложенный),
 * предлагает уже переданное имя или подсказывает имена там, где печатают значение.
 * Поэтому проверяем не только «что предложили», но и каждое «здесь не надо».
 */

/** Место под кареткой: `|` в тексте — курсор. `from` — сколько знаков слева брать. */
function at(marked: string, languageId = 'python') {
  const column = marked.indexOf('|');
  const text = marked.replace('|', '');
  return callContextAt(text, column, languageId);
}

const source = [
  'def parse(text, strict=False, *, encoding="utf-8"):',
  '    return text',
  '',
  'class Reader:',
  '    def load(self, path, mode="r"):',
  '        return path',
  '',
  'def outer(value):',
  '    return value',
].join('\n');

describe('где подсказывать имена аргументов', () => {
  it('внутри вызова видно функцию и набранное', () => {
    expect(at('parse(te|')).toEqual({ callee: 'parse', typed: 'te', passed: new Set(), positional: 0 });
  });

  it('переданные имена собираются, чтобы не предлагать их снова', () => {
    // Первый довод позиционный — имя `text` занято по порядку, второй передан явно.
    expect(at('parse(text, st|')).toEqual({ callee: 'parse', typed: 'st', passed: new Set(), positional: 1 });
    expect(at('parse(text, strict=False, enc|')).toEqual({
      callee: 'parse',
      typed: 'enc',
      passed: new Set(['strict']),
      positional: 1,
    });
  });

  it('вложенный вызов — это другой вызов, и внешний не мешает', () => {
    expect(at('parse(read(pa|')).toEqual({ callee: 'read', typed: 'pa', passed: new Set(), positional: 0 });
    expect(at('parse(read(path), st|')).toEqual({ callee: 'parse', typed: 'st', passed: new Set(), positional: 1 });
  });

  it('метод вызывается по последнему сегменту имени', () => {
    expect(at('reader.load(pa|')).toEqual({ callee: 'reader.load', typed: 'pa', passed: new Set(), positional: 0 });
  });

  it('управляющая конструкция — не вызов', () => {
    expect(at('if (va|')).toBeNull();
    expect(at('for item in (va|')).toBeNull();
  });

  it('печатают значение — имена не предлагаются', () => {
    expect(at('parse(text=|')).toBeNull();
    expect(at('parse(text="x|')).toBeNull();
  });

  it('вне вызова и у других языков — не предлагаются', () => {
    expect(at('value = te|')).toBeNull();
    expect(at('parse(te|', 'typescript')).toBeNull();
  });
});

describe('какие имена предлагаются', () => {
  it('параметры берутся из объявления: без self, *args и **kwargs', () => {
    expect(parameterNames('self, text, strict=False')).toEqual(['text', 'strict']);
    expect(parameterNames('text, *args, **kwargs')).toEqual(['text']);
    expect(parameterNames('text, *, strict')).toEqual(['text', 'strict']);
    expect(parameterNames('')).toEqual([]);
  });

  it('имена встают с знаком равенства и без уже переданных', () => {
    const context = at('parse(text, st|')!;
    const items = namedArgumentItems(source, context);
    expect(items.map((item) => item.label)).toEqual(['strict=']);
    expect(items[0]?.insert).toBe('strict=');
    expect(items[0]?.detail).toBe('параметр');
  });

  it('на пустом набранном показываются все свободные имена', () => {
    const context = at('parse(|')!;
    expect(namedArgumentItems(source, context).map((item) => item.label)).toEqual(['text=', 'strict=', 'encoding=']);
  });

  it('функции нет в файле — подсказок нет: имена не выдумываем', () => {
    const context = at('external_call(te|')!;
    expect(namedArgumentItems(source, context)).toEqual([]);
  });

  it('метод класса находится по имени', () => {
    const context = at('reader.load(pa|')!;
    expect(namedArgumentItems(source, context).map((item) => item.label)).toEqual(['path=']);
  });
});
