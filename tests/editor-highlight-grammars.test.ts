import { describe, expect, it } from 'vitest';
import type { Grammar } from '../src/renderer/editor/highlight/grammar';
import { grammarFor, highlightedLanguages } from '../src/renderer/editor/highlight/registry';
import {
  ATTRIBUTE,
  COMMENT,
  CONTROL,
  FUNCTION,
  IDENTIFIER,
  KEYWORD,
  NUMBER,
  STRING,
  TAG,
  TYPE,
  VARIABLE,
  type Token,
} from '../src/renderer/editor/highlight/tokens';

/**
 * Прогнать набор строк через грамматику, перенося состояние строки в строку — так же,
 * как это делает подсветка. Возвращает токены по строкам: их и проверяем.
 */
function run(grammar: Grammar, lines: readonly string[]): Token[][] {
  const out: Token[][] = [];
  let state = 0;
  for (const line of lines) {
    const result = grammar.line(line, state);
    out.push(result.tokens);
    state = result.state;
  }
  return out;
}

/** Тип токена, покрывающего смещение. `null` — смещение не покрыто (значит, бесцветно). */
function typeAt(tokens: readonly Token[], offset: number): string | null {
  for (const token of tokens) {
    if (offset >= token.start && offset < token.end) return token.type;
  }
  return null;
}

/** Тип токена, начинающегося со слова. Ищем вхождение слова в строке. */
function typeOfWord(line: string, word: string, tokens: readonly Token[]): string | null {
  return typeAt(tokens, line.indexOf(word));
}

/** Грамматика языка или провал с понятным сообщением. */
function grammarOf(language: string): Grammar {
  const grammar = grammarFor(language);
  if (!grammar) throw new Error(`нет грамматики для «${language}»`);
  return grammar;
}

/** Первая строка и её токены — самый частый случай в проверках. */
function first(language: string, line: string): Token[] {
  return run(grammarOf(language), [line])[0]!;
}

describe('реестр грамматик', () => {
  it('языки приложения получают подсветку или честный отказ', () => {
    expect(grammarFor('typescript')?.id).toBe('typescript');
    // Родственные языки берут общую грамматику.
    expect(grammarFor('jsonc')?.id).toBe('json');
    expect(grammarFor('xml')?.id).toBe('html');
    expect(grammarFor('scss')?.id).toBe('css');
    expect(grammarFor('dockerfile')?.id).toBe('shell');
    // Текст — без подсветки, и это не ошибка.
    expect(grammarFor('plaintext')).toBeNull();
  });

  it('идентификатор языка не зависит от регистра', () => {
    expect(grammarFor('TypeScript')?.id).toBe('typescript');
  });

  it('подсветка объявлена для основных языков проекта', () => {
    const languages = highlightedLanguages();
    for (const expected of [
      'python',
      'javascript',
      'typescript',
      'json',
      'yaml',
      'markdown',
      'html',
      'css',
      'shell',
      'sql',
    ]) {
      expect(languages).toContain(expected);
    }
  });
});

describe('JavaScript и TypeScript', () => {
  it('роли слов: ключевое и управляющее', () => {
    const line = 'const flag = if x';
    const tokens = first('typescript', line);
    expect(typeOfWord(line, 'const', tokens)).toBe(KEYWORD);
    // «if» — управляющая конструкция, у неё своя роль.
    expect(typeOfWord(line, 'if', tokens)).toBe(CONTROL);
  });

  it('примитивы TypeScript — типы, а не ключевые слова', () => {
    const line = 'let value: string';
    const tokens = first('typescript', line);
    expect(typeOfWord(line, 'string', tokens)).toBe(TYPE);
    expect(typeOfWord(line, 'let', tokens)).toBe(KEYWORD);
  });

  it('строка, число и комментарий', () => {
    const line = 'run("hi", 42); // хвост';
    const tokens = first('typescript', line);
    expect(typeOfWord(line, '"hi"', tokens)).toBe(STRING);
    expect(typeOfWord(line, '42', tokens)).toBe(NUMBER);
    expect(typeOfWord(line, '// хвост', tokens)).toBe(COMMENT);
  });

  it('имя со скобкой — функция', () => {
    const line = 'compute(1)';
    expect(typeOfWord(line, 'compute', first('typescript', line))).toBe(FUNCTION);
  });

  it('блочный комментарий переносится на следующую строку', () => {
    const lines = ['/* начало', 'середина', 'конец */ const x'];
    const [open, middle, closed] = run(grammarOf('typescript'), lines);
    expect(typeAt(open!, 0)).toBe(COMMENT);
    expect(typeAt(middle!, 0)).toBe(COMMENT);
    expect(typeAt(closed!, 0)).toBe(COMMENT);
    // Комментарий закрылся — дальше обычный разбор.
    expect(typeOfWord(lines[2]!, 'const', closed!)).toBe(KEYWORD);
  });

  it('шаблонная строка тянется через строки', () => {
    const lines = ['const q = `начало', 'конец`;'];
    const [open, closed] = run(grammarOf('typescript'), lines);
    expect(typeAt(open!, lines[0]!.indexOf('`'))).toBe(STRING);
    expect(typeAt(closed!, 0)).toBe(STRING);
    // После закрывающей кавычки точка с запятой уже вне строки.
    expect(typeAt(closed!, lines[1]!.indexOf('`') + 1)).toBeNull();
  });

  // Причина проверки: закрывающая кавычка в НАЧАЛЕ строки (`\`;`) раньше не
  // распознавалась — строка считалась незакрытой, и весь следующий код «затягивало»
  // в строку. Воспроизводится, когда шаблон закрывают с новой строки.
  it('шаблон закрывается, даже если кавычка первая в строке', () => {
    const lines = ['const html = `', '  <div>', '`;', 'const after = 1;'];
    const [, , closed, after] = run(grammarOf('typescript'), lines);
    expect(typeAt(closed!, 0)).toBe(STRING);
    // Кавычка закрылась на третьей строке — дальше обычный код.
    expect(typeAt(closed!, 2)).toBeNull();
    expect(typeOfWord(lines[3]!, 'const', after!)).toBe(KEYWORD);
  });
});

describe('Python', () => {
  it('решётка — комментарий, решётка в строке — нет', () => {
    const line = 'x = "# не комментарий"  # комментарий';
    const tokens = first('python', line);
    expect(typeOfWord(line, '"# не комментарий"', tokens)).toBe(STRING);
    expect(typeOfWord(line, '# комментарий', tokens)).toBe(COMMENT);
  });

  it('имя после def — функция, после class — тип', () => {
    const defLine = 'def greet(name):';
    expect(typeOfWord(defLine, 'greet', first('python', defLine))).toBe(FUNCTION);
    const classLine = 'class Row:';
    expect(typeOfWord(classLine, 'Row', first('python', classLine))).toBe(TYPE);
  });

  it('тройная строка переносится на следующие строки', () => {
    const lines = ['text = """документ', 'ещё строка', 'конец"""', 'x = 1'];
    const tokens = run(grammarOf('python'), lines);
    expect(typeAt(tokens[0]!, lines[0]!.indexOf('"""'))).toBe(STRING);
    expect(typeAt(tokens[1]!, 0)).toBe(STRING);
    expect(typeAt(tokens[2]!, 0)).toBe(STRING);
    // После закрывающей тройки разбор обычный.
    expect(typeOfWord(lines[3]!, 'x', tokens[3]!)).toBe(IDENTIFIER);
  });

  it('управляющие конструкции и встроенные типы', () => {
    const line = 'for item in items:';
    const tokens = first('python', line);
    expect(typeOfWord(line, 'for', tokens)).toBe(CONTROL);
    expect(typeOfWord(line, 'in', tokens)).toBe(CONTROL);
    const typed = 'count: int = 0';
    expect(typeOfWord(typed, 'int', first('python', typed))).toBe(TYPE);
  });

  it('префикс строки входит в строку целиком', () => {
    const line = 'msg = f"привет"';
    const tokens = first('python', line);
    expect(typeAt(tokens, line.indexOf('f"'))).toBe(STRING);
  });
});

describe('JSON', () => {
  it('ключ отличается от значения, литералы — ключевые слова', () => {
    const line = '{ "name": "chui", "count": 3, "ok": true }';
    const tokens = first('json', line);
    expect(typeOfWord(line, '"name"', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, '"chui"', tokens)).toBe(STRING);
    expect(typeOfWord(line, '3', tokens)).toBe(NUMBER);
    expect(typeOfWord(line, 'true', tokens)).toBe(KEYWORD);
  });

  it('комментарии понимаются, хотя в строгом JSON их нет', () => {
    expect(typeOfWord('{ // заметка', '// заметка', first('json', '{ // заметка'))).toBe(COMMENT);
  });
});

describe('Shell', () => {
  it('имя команды в начале строки — функция, аргументы — идентификаторы', () => {
    const line = 'grep -r "x" path';
    const tokens = first('shell', line);
    expect(typeOfWord(line, 'grep', tokens)).toBe(FUNCTION);
    expect(typeOfWord(line, 'path', tokens)).toBe(IDENTIFIER);
    expect(typeOfWord(line, '"x"', tokens)).toBe(STRING);
  });

  it('переменные и управляющие конструкции', () => {
    const line = 'export PATH=$HOME/bin';
    const tokens = first('shell', line);
    expect(typeOfWord(line, 'export', tokens)).toBe(KEYWORD);
    expect(typeOfWord(line, '$HOME', tokens)).toBe(VARIABLE);
    const flow = 'if [ -f x ]; then';
    const flowTokens = first('shell', flow);
    expect(typeOfWord(flow, 'if', flowTokens)).toBe(CONTROL);
    expect(typeOfWord(flow, 'then', flowTokens)).toBe(CONTROL);
  });

  it('решётка в начале слова — комментарий, в середине — часть слова', () => {
    expect(typeOfWord('  # заметка', '# заметка', first('shell', '  # заметка'))).toBe(COMMENT);
    const line = 'echo a#b';
    expect(typeOfWord(line, 'a#b', first('shell', line))).toBe(IDENTIFIER);
  });
});

describe('YAML', () => {
  it('ключ и значение различаются', () => {
    const line = 'name: chui # заметка';
    const tokens = first('yaml', line);
    expect(typeOfWord(line, 'name', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, '# заметка', tokens)).toBe(COMMENT);
  });

  it('литералы и ключ в элементе списка', () => {
    const line = '- enabled: true';
    const tokens = first('yaml', line);
    expect(typeOfWord(line, 'enabled', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, 'true', tokens)).toBe(KEYWORD);
  });

  it('двоеточие в адресе не делает строку ключом', () => {
    const line = 'url: https://example.com';
    const tokens = first('yaml', line);
    expect(typeOfWord(line, 'url', tokens)).toBe(ATTRIBUTE);
    // `https` — значение, а не ключ: двоеточие к слову вплотную.
    expect(typeOfWord(line, 'https', tokens)).toBeNull();
  });
});

describe('Markdown', () => {
  it('заголовок целиком — ключевое слово', () => {
    const line = '## Раздел';
    const tokens = first('markdown', line);
    expect(typeAt(tokens, 0)).toBe(KEYWORD);
    expect(typeAt(tokens, line.length - 1)).toBe(KEYWORD);
  });

  it('код в строке и ссылка', () => {
    const line = 'текст `код` и [ссылка](https://x)';
    const tokens = first('markdown', line);
    expect(typeOfWord(line, '`код`', tokens)).toBe(STRING);
    expect(typeOfWord(line, 'ссылка', tokens)).toBe(KEYWORD);
    expect(typeOfWord(line, 'https://x', tokens)).toBe(STRING);
  });

  it('ограждённый блок кода: строки внутри не разбираются как разметка', () => {
    const lines = ['```js', '# это код, а не заголовок', '```', 'текст'];
    const tokens = run(grammarOf('markdown'), lines);
    expect(typeAt(tokens[0]!, 0)).toBe(STRING);
    expect(tokens[1]!).toHaveLength(0);
    expect(typeAt(tokens[2]!, 0)).toBe(STRING);
    expect(tokens[3]!).toHaveLength(0);
  });
});

describe('HTML', () => {
  it('тег, атрибут и значение атрибута различаются', () => {
    const line = '<a href="x" data-id=1>';
    const tokens = first('html', line);
    expect(typeOfWord(line, 'a ', tokens)).toBe(TAG);
    expect(typeOfWord(line, 'href', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, '"x"', tokens)).toBe(STRING);
    expect(typeOfWord(line, 'data-id', tokens)).toBe(ATTRIBUTE);
  });

  it('закрывающий тег и комментарий', () => {
    expect(typeOfWord('</div>', 'div', first('html', '</div>'))).toBe(TAG);
    expect(typeOfWord('<!-- текст -->', 'текст', first('html', '<!-- текст -->'))).toBe(COMMENT);
  });
});

describe('CSS', () => {
  it('селектор, свойство и значение различаются', () => {
    const line = '.card { color: #fff; width: 10px; }';
    const tokens = first('css', line);
    expect(typeOfWord(line, '.card', tokens)).toBe(TAG);
    expect(typeOfWord(line, 'color', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, '#fff', tokens)).toBe(NUMBER);
    expect(typeOfWord(line, 'width', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, '10px', tokens)).toBe(NUMBER);
  });

  it('блочный комментарий переносится на следующую строку', () => {
    const lines = ['/* начало', 'конец */ .a { }'];
    const tokens = run(grammarOf('css'), lines);
    expect(typeAt(tokens[0]!, 0)).toBe(COMMENT);
    expect(typeAt(tokens[1]!, 0)).toBe(COMMENT);
    // После закрытия комментария селектор снова виден.
    expect(typeOfWord(lines[1]!, '.a', tokens[1]!)).toBe(TAG);
  });

  it('вложенные блоки: внутри @media селектор, а затем свойство', () => {
    const lines = ['@media print {', '  .a { color: red; }', '}'];
    const tokens = run(grammarOf('css'), lines);
    expect(typeAt(tokens[0]!, 0)).toBe(KEYWORD);
    expect(typeOfWord(lines[1]!, '.a', tokens[1]!)).toBe(TAG);
    expect(typeOfWord(lines[1]!, 'color', tokens[1]!)).toBe(ATTRIBUTE);
  });
});

describe('SQL', () => {
  it('ключевые слова не зависят от регистра', () => {
    const upper = 'SELECT * FROM t';
    expect(typeOfWord(upper, 'SELECT', first('sql', upper))).toBe(KEYWORD);
    const lower = 'select * from t';
    expect(typeOfWord(lower, 'select', first('sql', lower))).toBe(KEYWORD);
  });

  it('строка, имя в кавычках и параметр', () => {
    const line = "WHERE name = :id AND tag = 'x'";
    const tokens = first('sql', line);
    expect(typeOfWord(line, ':id', tokens)).toBe(VARIABLE);
    expect(typeOfWord(line, "'x'", tokens)).toBe(STRING);
    const quoted = 'SELECT "col" FROM t';
    expect(typeOfWord(quoted, '"col"', first('sql', quoted))).toBe(IDENTIFIER);
  });
});

describe('TOML/INI', () => {
  it('секция, ключ и значение', () => {
    const section = '[core]';
    expect(typeOfWord(section, 'core', first('ini', section))).toBe(TAG);
    const line = 'name = "chui"';
    const tokens = first('ini', line);
    expect(typeOfWord(line, 'name', tokens)).toBe(ATTRIBUTE);
    expect(typeOfWord(line, '"chui"', tokens)).toBe(STRING);
  });

  it('точка с запятой — тоже комментарий', () => {
    expect(typeOfWord('; заметка', '; заметка', first('ini', '; заметка'))).toBe(COMMENT);
  });
});
