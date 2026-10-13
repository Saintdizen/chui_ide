import { describe, expect, it } from 'vitest';
import { importStyleOf, rewriteImports, type ImportStyle } from '../src/shared/import-rewrite';

/** Правим один файл под переезд цели — как это делает main. */
function rewrite(
  text: string,
  file: string,
  oldTarget: string,
  newTarget: string,
  style: ImportStyle = 'js',
): { text: string; count: number } {
  return rewriteImports(text, { file, oldTarget, newTarget, style });
}

/**
 * Переезд путей в импортах: переименовали `utils/foo.ts` — и все относительные
 * ссылки на него в проекте должны указывать на новое имя. Логика чистая, поэтому
 * проверяется строками, без диска.
 */
describe('importStyleOf', () => {
  it('узнаёт язык по расширению файла', () => {
    expect(importStyleOf('src/app.ts')).toBe('js');
    expect(importStyleOf('App.tsx')).toBe('js');
    expect(importStyleOf('styles/main.css')).toBe('js');
    expect(importStyleOf('pkg/utils.py')).toBe('python');
  });

  it('невнятное имя и чужой язык — не наши', () => {
    expect(importStyleOf('Makefile')).toBeNull();
    expect(importStyleOf('README.md')).toBeNull();
    expect(importStyleOf('src.v2/app')).toBeNull();
  });
});

describe('rewriteImports: JS/TS', () => {
  it('переписывает обычный import из', () => {
    const source = "import { foo } from './foo';\n";
    expect(rewrite(source, 'src/app.ts', 'src/foo.ts', 'src/bar.ts')).toEqual({
      text: "import { foo } from './bar';\n",
      count: 1,
    });
  });

  it('понимает require, динамический import, побочный импорт и export from', () => {
    const source = [
      "const a = require('./foo');",
      "const b = await import('./foo');",
      "import './foo';",
      "export { x } from './foo';",
      '',
    ].join('\n');
    const result = rewrite(source, 'src/app.ts', 'src/foo.ts', 'src/bar.ts');
    expect(result.count).toBe(4);
    expect(result.text).not.toContain('./foo');
    expect(result.text.match(/\.\/bar/g)).toHaveLength(4);
  });

  it('сохраняет расширение, как было написано', () => {
    expect(rewrite("import x from './foo.js';", 'src/app.ts', 'src/foo.ts', 'src/bar.ts').text).toBe(
      "import x from './bar.js';",
    );
    expect(rewrite("import x from './foo.ts';", 'src/app.ts', 'src/foo.ts', 'src/bar.ts').text).toBe(
      "import x from './bar.ts';",
    );
  });

  it('пересчитывает подъём вверх по дереву', () => {
    // Файл в подпапке: к цели путь идёт через «../».
    expect(rewrite("import x from '../foo';", 'src/deep/app.ts', 'src/foo.ts', 'src/bar.ts').text).toBe(
      "import x from '../bar';",
    );
    // Цель ушла в соседнюю подпапку — путь удлиняется.
    expect(rewrite("import x from '../foo';", 'src/deep/app.ts', 'src/foo.ts', 'lib/foo.ts').text).toBe(
      "import x from '../../lib/foo';",
    );
  });

  it('переименование папки правит и вложенные пути', () => {
    const source = [
      "import a from './utils/one';",
      "import b from './utils/two';",
      "import c from './utils';",
      '',
    ].join('\n');
    const result = rewrite(source, 'src/app.ts', 'src/utils', 'src/helpers');
    expect(result.count).toBe(3);
    expect(result.text).toBe(
      ["import a from './helpers/one';", "import b from './helpers/two';", "import c from './helpers';", ''].join('\n'),
    );
  });

  it('не трогает чужие пути и границу сегмента', () => {
    const source = ["import a from './utilsx';", "import b from '@/utils/one';", "import c from 'react';", ''].join(
      '\n',
    );
    expect(rewrite(source, 'src/app.ts', 'src/utils', 'src/helpers')).toEqual({ text: source, count: 0 });
  });

  it('берёт @import в CSS', () => {
    expect(rewrite("@import './base.css';\n", 'styles/main.css', 'styles/base.css', 'styles/foundation.css').text).toBe(
      "@import './foundation.css';\n",
    );
  });

  it('строка без ключевого слова перед ней импортом не считается', () => {
    const source = "const path = './foo';\n";
    expect(rewrite(source, 'src/app.ts', 'src/foo.ts', 'src/bar.ts')).toEqual({ text: source, count: 0 });
  });

  it('одинаковые старый и новый путь — ничего не делаем', () => {
    const source = "import x from './foo';\n";
    expect(rewrite(source, 'src/app.ts', 'src/foo.ts', 'src/foo.ts')).toEqual({ text: source, count: 0 });
  });
});

describe('rewriteImports: Python', () => {
  it('правит относительный импорт модуля', () => {
    expect(rewrite('from .utils import one\n', 'pkg/app.py', 'pkg/utils.py', 'pkg/helpers.py', 'python')).toEqual({
      text: 'from .helpers import one\n',
      count: 1,
    });
  });

  it('правит вложенный относительный импорт при переименовании пакета', () => {
    expect(rewrite('from .utils.foo import one\n', 'pkg/app.py', 'pkg/utils', 'pkg/helpers', 'python').text).toBe(
      'from .helpers.foo import one\n',
    );
  });

  it('добавляет или убирает ведущие точки при смене пакета файла', () => {
    // Файл глубже цели: нужен подъём до общего предка.
    expect(
      rewrite('from ..utils import one\n', 'pkg/deep/app.py', 'pkg/utils.py', 'pkg/helpers.py', 'python').text,
    ).toBe('from ..helpers import one\n');
    // Цель переехала в подпакет соседа — путь стал длиннее при том же подъёме.
    expect(rewrite('from .utils import one\n', 'pkg/app.py', 'pkg/utils.py', 'pkg/sub/utils.py', 'python').text).toBe(
      'from .sub.utils import one\n',
    );
  });

  it('правит абсолютный импорт по полному пути модуля', () => {
    expect(
      rewrite('import pkg.utils.foo\n', 'other/mod.py', 'pkg/utils/foo.py', 'pkg/helpers/foo.py', 'python').text,
    ).toBe('import pkg.helpers.foo\n');
    expect(
      rewrite('from pkg.utils import one\n', 'other/mod.py', 'pkg/utils.py', 'pkg/helpers.py', 'python').text,
    ).toBe('from pkg.helpers import one\n');
  });

  it('оставляет псевдонимы и несколько модулей в import', () => {
    const source = 'import os, pkg.utils as u\n';
    expect(rewrite(source, 'other/mod.py', 'pkg/utils.py', 'pkg/helpers.py', 'python').text).toBe(
      'import os, pkg.helpers as u\n',
    );
  });

  it('не трогает имена, импортируемые поимённо, и чужие пакеты', () => {
    const source = 'from .other import utils\nimport django.utils\n';
    expect(rewrite(source, 'pkg/app.py', 'pkg/utils.py', 'pkg/helpers.py', 'python')).toEqual({
      text: source,
      count: 0,
    });
  });
});

describe('rewriteImports: разбор пути до модуля', () => {
  it('__init__ — это сам пакет, а не модуль внутри него', () => {
    expect(
      rewrite('from .utils import one\n', 'pkg/app.py', 'pkg/utils/__init__.py', 'pkg/helpers/__init__.py', 'python')
        .text,
    ).toBe('from .helpers import one\n');
  });

  it('пустой текст и пустые пути — не повод падать', () => {
    expect(rewrite('', 'src/app.ts', 'src/foo.ts', 'src/bar.ts')).toEqual({ text: '', count: 0 });
    expect(rewrite('x\n', 'src/app.ts', '', 'src/bar.ts')).toEqual({ text: 'x\n', count: 0 });
  });
});
