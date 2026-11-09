import { describe, expect, it } from 'vitest';
import { matchPattern, parseEditorConfig, resolveEditorConfig } from '../src/shared/editorconfig';

describe('parseEditorConfig: разбор файла', () => {
  it('корень, секции и свойства', () => {
    const file = parseEditorConfig(`root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4

[*.{ts,tsx}]
indent_size = 2
trim_trailing_whitespace = true`);
    expect(file.isRoot).toBe(true);
    expect(file.rules).toHaveLength(2);
    expect(file.rules[0]).toMatchObject({ endOfLine: 'lf', indentStyle: 'space', indentSize: 4 });
    expect(file.rules[1]).toMatchObject({ indentSize: 2, trimTrailingWhitespace: true });
  });

  it('indent_size важнее tab_width', () => {
    const file = parseEditorConfig('[*.py]\nindent_size = 4\ntab_width = 8');
    expect(file.rules[0]!.indentSize).toBe(4);
  });

  it('tab_width работает, когда indent_size нет', () => {
    const file = parseEditorConfig('[*.go]\nindent_style = tab\ntab_width = 8');
    expect(file.rules[0]).toMatchObject({ indentStyle: 'tab', indentSize: 8 });
  });

  it('root после секции не считается корнем', () => {
    expect(parseEditorConfig('[*]\nroot = true').isRoot).toBe(false);
  });

  it('мусор не ломает разбор', () => {
    const file = parseEditorConfig('непонятно\n[*]\nindent_style = марсианский');
    expect(file.rules).toHaveLength(1);
    expect(file.rules[0]!.indentStyle).toBeUndefined();
  });
});

describe('matchPattern: шаблоны путей', () => {
  it('без слэша сверяется с именем файла', () => {
    expect(matchPattern('*.py', 'src/deep/x.py')).toBe(true);
    expect(matchPattern('*.py', 'src/deep/x.ts')).toBe(false);
  });

  it('одна * не переходит через слэш в шаблоне с путём', () => {
    expect(matchPattern('src/*.py', 'src/x.py')).toBe(true);
    expect(matchPattern('src/*.py', 'src/deep/x.py')).toBe(false);
  });

  it('** перекрывает папки', () => {
    expect(matchPattern('src/**/*.py', 'src/a/b/x.py')).toBe(true);
    expect(matchPattern('**/*.py', 'x.py')).toBe(true);
  });

  it('группа в скобках раскрывается', () => {
    expect(matchPattern('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(matchPattern('*.{ts,tsx}', 'a.js')).toBe(false);
  });

  it('символьный класс и исключение', () => {
    expect(matchPattern('a[bc].py', 'ab.py')).toBe(true);
    expect(matchPattern('a[!bc].py', 'ad.py')).toBe(true);
    expect(matchPattern('a[!bc].py', 'ab.py')).toBe(false);
  });
});

describe('resolveEditorConfig: склейка слоёв', () => {
  const root = parseEditorConfig('root = true\n[*]\nend_of_line = lf\nindent_size = 4');
  const inner = parseEditorConfig('[*.py]\nindent_size = 2');

  it('ближний слой важнее дальнего', () => {
    const values = resolveEditorConfig('x.py', [root, inner]);
    expect(values.indentSize).toBe(2);
    // Что задано только в дальнем — остаётся.
    expect(values.endOfLine).toBe('lf');
  });

  it('секция без совпадения ничего не добавляет', () => {
    expect(resolveEditorConfig('x.ts', [root, inner]).indentSize).toBe(4);
  });

  it('поздняя секция перебивает раннюю в одном файле', () => {
    const file = parseEditorConfig('[*]\nend_of_line = crlf\n[*.md]\nend_of_line = lf');
    expect(resolveEditorConfig('a.md', [file]).endOfLine).toBe('lf');
    expect(resolveEditorConfig('a.txt', [file]).endOfLine).toBe('crlf');
  });

  it('пустые слои — пустые значения, а не ошибка', () => {
    expect(resolveEditorConfig('a.py', [])).toEqual({});
  });
});
