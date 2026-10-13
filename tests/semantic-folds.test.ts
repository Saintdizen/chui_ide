import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grammarFoldRanges, MAX_SEMANTIC_FOLD_LINES, semanticFoldRanges } from '../src/renderer/editor/highlight/folds';
import { grammarFor } from '../src/renderer/editor/highlight/registry';
import { indentFoldRanges, mergeFoldRanges } from '../src/shared/fold-ranges';

/** Запустить свёртку по грамматике языка на готовом тексте. */
function folds(text: string, language: string) {
  return semanticFoldRanges(text, language);
}

describe('semanticFoldRanges: блоки по скобкам', () => {
  it('блок C-подобного кода сворачивается от строки со скобкой до закрывающей', () => {
    const text = ['function f() {', '  const x = 1;', '  return x;', '}'].join('\n');
    expect(folds(text, 'javascript')).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it('скобка на своей строке (стиль Allman) тоже даёт блок', () => {
    const text = ['if (ready)', '{', '  go();', '}'].join('\n');
    expect(folds(text, 'c')).toContainEqual({ startLine: 2, endLine: 4 });
  });

  it('однострочный блок не сворачивается — складывать нечего', () => {
    expect(folds('const o = { a: 1 };\n', 'javascript')).toEqual([]);
  });

  it('вложенные скобки дают два диапазона', () => {
    const text = ['function f() {', '  if (x) {', '    y();', '  }', '}'].join('\n');
    expect(folds(text, 'typescript')).toEqual([
      { startLine: 1, endLine: 5 },
      { startLine: 2, endLine: 4 },
    ]);
  });

  it('скобки в строке и комментарии не считаются блоками', () => {
    const text = ['const s = "{";', 'const t = "}" + s;', 'ok();'].join('\n');
    expect(folds(text, 'javascript')).toEqual([]);
  });

  it('многострочный список аргументов в скобках сворачивается', () => {
    const text = ['call(', '  one,', '  two,', ');'].join('\n');
    expect(folds(text, 'javascript')).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it('битые скобки не соединяют разные блоки', () => {
    // Закрывающая `)` без пары — не должна закрыть стоящую выше `{`.
    const text = ['{', '  a', ')'].join('\n');
    expect(folds(text, 'javascript')).toEqual([]);
  });
});

describe('semanticFoldRanges: многострочные конструкции', () => {
  it('блочный комментарий складывается целиком', () => {
    const text = ['/* первая', '   вторая', '   третья */', 'code();'].join('\n');
    expect(folds(text, 'javascript')).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('однострочный комментарий не сворачивается', () => {
    expect(folds('/* раз */\ncode();\n', 'javascript')).toEqual([]);
  });

  it('тройная строка Python складывается', () => {
    const text = ['doc = """', 'строка', 'текст', '"""', 'go()'].join('\n');
    expect(folds(text, 'python')).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it('шаблонная строка в обратных кавычках складывается', () => {
    const text = ['const html = `', '  <div>', '`;'].join('\n');
    expect(folds(text, 'javascript')).toEqual([{ startLine: 1, endLine: 3 }]);
  });
});

describe('semanticFoldRanges: пределы и отсутствие грамматики', () => {
  it('язык без грамматики — пусто', () => {
    expect(semanticFoldRanges('{\n}\n', 'plaintext')).toEqual([]);
    expect(semanticFoldRanges('{\n}\n', 'неведомый-язык')).toEqual([]);
  });

  it('файл длиннее предела не разбираем — останутся отступы', () => {
    const text = '{\n'.repeat(MAX_SEMANTIC_FOLD_LINES + 1);
    expect(semanticFoldRanges(text, 'javascript')).toEqual([]);
    // Предел можно задать и самому — им пользуются проверки на больших текстах.
    expect(semanticFoldRanges(text, 'javascript', { maxLines: 5 })).toEqual([]);
  });

  it('разбор для готовой грамматики доступен отдельно', () => {
    const grammar = grammarFor('javascript')!;
    expect(grammarFoldRanges(grammar, ['a = {', '  b', '}'])).toEqual([{ startLine: 1, endLine: 3 }]);
  });
});

describe('свёртка на настоящем файле проекта', () => {
  // Проверка на живом коде: грамматика должна находить блоки в файле, который
  // написан не под тест. Блоков у большого TypeScript-файла заведомо много.
  it('в исходнике проекта находятся сворачиваемые блоки', () => {
    const file = path.join(__dirname, '..', 'src', 'renderer', 'editor', 'host', 'editor-commands.ts');
    const text = readFileSync(file, 'utf8');
    const ranges = semanticFoldRanges(text, 'typescript');
    expect(ranges.length).toBeGreaterThan(5);
    // Все диапазоны осмысленны: начало раньше конца, конец не вылезает за файл.
    const lines = text.split('\n').length;
    for (const range of ranges) {
      expect(range.startLine).toBeGreaterThanOrEqual(1);
      expect(range.endLine).toBeGreaterThan(range.startLine);
      expect(range.endLine).toBeLessThanOrEqual(lines);
    }
  });
});

describe('скобки и отступы вместе накрывают больше, чем по отдельности', () => {
  it('C-подобный блок с одинаковым отступом строки и скобки виден только по скобкам', () => {
    const text = ['int main() {', 'printf("hi");', 'return 0;', '}'].join('\n');
    // По отступам: строка 2 и 3 имеют тот же отступ, что и 1, — блока нет.
    expect(indentFoldRanges(text, 4)).toEqual([]);
    // По скобкам: блок есть.
    expect(folds(text, 'c')).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it('Python-блок виден только по отступам, по скобкам — нет', () => {
    const text = ['def f():', '    if x:', '        return 1', '    return 0'].join('\n');
    expect(folds(text, 'python')).toEqual([]);
    expect(indentFoldRanges(text, 4)).toEqual([
      { startLine: 1, endLine: 4 },
      { startLine: 2, endLine: 3 },
    ]);
  });

  it('объединение двух источников без дублей', () => {
    const text = ['def f():', '    data = {', '        "a": 1,', '    }', '    return data'].join('\n');
    const merged = mergeFoldRanges([...folds(text, 'python'), ...indentFoldRanges(text, 4)]);
    // Блок скобок (2–4) и блок по отступам (1–5) — оба на месте, без повторов.
    expect(merged).toContainEqual({ startLine: 1, endLine: 5 });
    expect(merged).toContainEqual({ startLine: 2, endLine: 4 });
    expect(new Set(merged.map((range) => `${range.startLine}:${range.endLine}`)).size).toBe(merged.length);
  });
});
