import { describe, expect, it } from 'vitest';
import { combineIgnoreFiles, IgnoreRules } from '../src/shared/ignore';

/**
 * Правила исключения обхода. Формат взят у git, поэтому проверяем именно те
 * случаи, на которых люди обычно и спотыкаются: `!`, хвостовой и ведущий слэш,
 * `**`, и то, что файл внутри исключённой папки вернуть нельзя.
 */
const ignores = (text: string, path: string, isDir = false): boolean => IgnoreRules.parse(text).ignores(path, isDir);

describe('простые шаблоны', () => {
  it('имя папки исключает её и всё внутри', () => {
    expect(ignores('build/', 'build', true)).toBe(true);
    expect(ignores('build/', 'build/')).toBe(true);
    expect(ignores('build/', 'build/x.js')).toBe(true);
    expect(ignores('build/', 'src/build', true)).toBe(true);
    expect(ignores('build/', 'src/build/x.js')).toBe(true);
  });

  it('правило с хвостовым слэшем файл с таким именем не задевает', () => {
    // Так же считает git (`git check-ignore`): `build/` — только про папки,
    // файл `build` без расширения под него не подходит.
    expect(ignores('build/', 'build')).toBe(false);
    expect(ignores('build/', 'src/build')).toBe(false);
  });

  it('имя папки не задевает похожие имена', () => {
    expect(ignores('build/', 'buildx')).toBe(false);
    expect(ignores('build/', 'src/buildx/y')).toBe(false);
  });

  it('маска по расширению работает на любой глубине', () => {
    expect(ignores('*.log', 'a.log')).toBe(true);
    expect(ignores('*.log', 'var/log/a.log')).toBe(true);
    expect(ignores('*.log', 'a/b.log')).toBe(true);
    expect(ignores('*.log', 'a.log.txt')).toBe(false);
    // Проверено `git check-ignore`: `*.log` без слэша действует на любой глубине,
    // поэтому слэш в маске нужен только для привязки к месту, а не для глубины.
    expect(ignores('docs/*.log', 'docs/a.log')).toBe(true);
    expect(ignores('docs/*.log', 'src/docs/a.log')).toBe(false);
  });

  it('слэш внутри привязывает правило к корню', () => {
    expect(ignores('docs/*.md', 'docs/a.md')).toBe(true);
    expect(ignores('docs/*.md', 'src/docs/a.md')).toBe(false);
  });

  it('ведущий слэш привязывает к корню', () => {
    expect(ignores('/todo.txt', 'todo.txt')).toBe(true);
    expect(ignores('/todo.txt', 'sub/todo.txt')).toBe(false);
    expect(ignores('todo.txt', 'sub/todo.txt')).toBe(true);
  });
});

describe('возврат обратно знаком !', () => {
  it('позднее правило побеждает', () => {
    expect(ignores('*.log\n!important.log', 'important.log')).toBe(false);
    expect(ignores('*.log\n!important.log', 'other.log')).toBe(true);
  });

  it('порядок обратный — снова исключено', () => {
    expect(ignores('!important.log\n*.log', 'important.log')).toBe(true);
  });

  it('файл внутри исключённой папки вернуть нельзя', () => {
    // Так же ведёт себя git: в исключённую папку мы просто не заходим.
    expect(ignores('build/\n!build/keep.js', 'build/keep.js')).toBe(true);
  });

  it('возврат папки целиком работает', () => {
    expect(ignores('docs/\n!docs/', 'docs/a.md')).toBe(false);
  });

  it('идиома «вернуть один файл из исключённой папки»', () => {
    // Единственный способ, который понимает и git: сперва вернуть саму папку,
    // внутри исключить всё, затем вернуть нужный файл.
    const rules = 'vendor/\n!vendor/\nvendor/*\n!vendor/keep.js';
    expect(ignores(rules, 'vendor/keep.js')).toBe(false);
    expect(ignores(rules, 'vendor/other.js')).toBe(true);
  });
});

describe('звёздочки', () => {
  it('`**` перешагивает папки', () => {
    expect(ignores('**/temp', 'a/b/temp')).toBe(true);
    expect(ignores('**/temp', 'temp')).toBe(true);
    expect(ignores('logs/**', 'logs/a/b.txt')).toBe(true);
    expect(ignores('logs/**', 'logs/a')).toBe(true);
  });

  it('`?` заменяет один символ, но не слэш', () => {
    expect(ignores('file?.txt', 'file1.txt')).toBe(true);
    expect(ignores('file?.txt', 'file12.txt')).toBe(false);
    expect(ignores('a?b', 'a/b')).toBe(false);
  });

  it('класс символов переносится', () => {
    expect(ignores('file[0-9].txt', 'file3.txt')).toBe(true);
    expect(ignores('file[0-9].txt', 'filex.txt')).toBe(false);
  });
});

describe('разбор строк', () => {
  it('комментарии и пустые строки пропускаются', () => {
    const rules = IgnoreRules.parse('# комментарий\n\n   \n*.log\n');
    expect(rules.size).toBe(1);
    expect(rules.ignores('a.log')).toBe(true);
  });

  it('экранированная решётка — это шаблон, а не комментарий', () => {
    expect(ignores('\\#temp', '#temp')).toBe(true);
  });

  it('точка в шаблоне не работает как «любой символ»', () => {
    expect(ignores('a.txt', 'a.txt')).toBe(true);
    expect(ignores('a.txt', 'aXtxt')).toBe(false);
  });

  it('пустой набор ничего не исключает', () => {
    expect(IgnoreRules.empty().ignores('что-угодно/файл.ts')).toBe(false);
    expect(IgnoreRules.empty().size).toBe(0);
  });

  it('путь с ведущим слэшем и точкой нормализуется', () => {
    expect(ignores('build/', './build/x.js')).toBe(true);
    expect(ignores('build/', '/build/')).toBe(true);
    expect(IgnoreRules.parse('').ignores('')).toBe(false);
  });
});

describe('несколько файлов правил', () => {
  it('`.ai_ignore` перебивает `.gitignore`', () => {
    const rules = combineIgnoreFiles(['dist/\n*.tmp\n', '!dist/\n']);
    expect(rules.ignores('dist/app.js')).toBe(false);
    expect(rules.ignores('a.tmp')).toBe(true);
  });

  it('правила складываются', () => {
    const rules = combineIgnoreFiles(['*.log\n', 'coverage/\n']);
    expect(rules.size).toBe(2);
    expect(rules.ignores('x.log')).toBe(true);
    expect(rules.ignores('coverage/lcov.info')).toBe(true);
  });
});

describe('крайние случаи шаблонов', () => {
  it('незакрытый класс символов — обычная открывающая скобка', () => {
    expect(ignores('file[', 'file[')).toBe(true);
    expect(ignores('a[b.txt', 'a[b.txt')).toBe(true);
  });

  it('правило, оставшееся пустым после разбора, ничего не исключает', () => {
    expect(IgnoreRules.parse('/\n!\n').size).toBe(0);
  });
});
