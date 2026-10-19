import { describe, expect, it } from 'vitest';
import { canCompleteStatement, completeStatement } from '../src/renderer/editor/complete/statement';

/**
 * «Закончить оператор»: дописать то, чего не хватает строке.
 *
 * Решения, которые легко принять неверно и трудно заметить: закрыть скобку внутри строки
 * (`"("`) , дописать в середину уже набранного оператора, поставить `;` заголовку с
 * блоком. Поэтому проверяем не «что получилось», а каждое из этих мест.
 */

/** Место под кареткой: `|` в тексте — курсор. */
function run(marked: string, languageId = 'python', indent = '    ') {
  const caret = marked.indexOf('|');
  return completeStatement(marked.replace('|', ''), caret, languageId, indent);
}

describe('Python', () => {
  it('заголовок блока получает двоеточие, отступ и новую строку', () => {
    expect(run('if order.total > 0|')).toEqual({ insert: ':\n    ' });
    expect(run('  for item in items|')).toEqual({ insert: ':\n      ' });
  });

  it('законченный заголовок — только переход в тело блока', () => {
    expect(run('def parse(path):|')).toEqual({ insert: '\n    ' });
  });

  it('обычный оператор не трогаем: в Python его завершать нечем', () => {
    expect(run('value = compute()|')).toBeNull();
  });

  it('незакрытые скобки закрываются первыми, даже после заголовка', () => {
    expect(run('if check(a, b|')).toEqual({ insert: ')' });
    expect(run('print(items[0|')).toEqual({ insert: '])' });
  });
});

describe('JS и TS', () => {
  it('оператор получает точку с запятой и новую строку с тем же отступом', () => {
    expect(run('const total = items.reduce(f)|', 'typescript')).toEqual({ insert: ';\n' });
    expect(run('  total += 1|', 'typescript')).toEqual({ insert: ';\n  ' });
  });

  it('заголовок с блоком получает фигурные скобки, а не `;`', () => {
    expect(run('if (ready)|', 'typescript')).toEqual({ insert: ' {\n    \n}', caret: 7 });
    expect(run('while (index < size)|', 'javascript')).toMatchObject({ insert: ' {\n    \n}' });
  });

  it('открытая фигурная скобка — переход внутрь блока', () => {
    expect(run('function load() {|', 'typescript')).toEqual({ insert: '\n    ' });
  });

  it('законченный оператор не дописывается второй раз', () => {
    expect(run('total += 1;|', 'typescript')).toBeNull();
    expect(run('const value = {|', 'typescript')).toEqual({ insert: '\n    ' });
  });
});

describe('где оператор не завершают', () => {
  it('после каретки уже есть код — дописывать в середину нельзя', () => {
    expect(run('if ready|: pass')).toBeNull();
  });

  it('комментарий и пустая строка — не оператор', () => {
    expect(run('# пример|')).toBeNull();
    expect(run('// пример|', 'typescript')).toBeNull();
    expect(run('   |')).toBeNull();
  });

  it('скобка внутри строки не считается открытой', () => {
    expect(run('name = "("|')).toBeNull();
    expect(run('if name == ")"|')).toEqual({ insert: ':\n    ' });
  });

  it('у языка без правил ничего не делает', () => {
    expect(canCompleteStatement('go')).toBe(false);
    expect(run('func main()|', 'go')).toBeNull();
  });

  it('шаг отступа берётся из настроек, а не угадывается', () => {
    expect(run('if ready|', 'python', '\t')).toEqual({ insert: ':\n\t' });
  });
});
