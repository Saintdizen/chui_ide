import { describe, expect, it } from 'vitest';
import {
  isExternalSpecifier,
  missingImports,
  packageNameOf,
  parsePythonImports,
  parseScriptImports,
  topLevelModules,
} from '../src/shared/imports';

/** Ссылки без позиций: удобно проверять сам разбор, а не столбцы. */
function modulesOf(text: string): string[] {
  return parsePythonImports(text).map((item) => item.module);
}

describe('parsePythonImports', () => {
  it('простой импорт и позиция имени', () => {
    expect(parsePythonImports('import os')).toEqual([
      { module: 'os', top: 'os', line: 1, startColumn: 8, endColumn: 10 },
    ]);
  });

  it('точечный модуль и `as`', () => {
    expect(modulesOf('import os.path as p')).toEqual(['os.path']);
    expect(modulesOf('import a.b.c')).toEqual(['a.b.c']);
  });

  it('несколько имён через запятую', () => {
    const refs = parsePythonImports('import a, b as c, d.e');
    expect(refs.map((item) => item.module)).toEqual(['a', 'b', 'd.e']);
    // У второго имени столбцы считаются от строки, а не от начала списка.
    expect(refs[1]).toMatchObject({ startColumn: 11, endColumn: 12 });
  });

  it('`from … import …` — подчёркиваем только модуль', () => {
    expect(parsePythonImports('from requests.adapters import HTTPAdapter')).toEqual([
      { module: 'requests.adapters', top: 'requests', line: 1, startColumn: 6, endColumn: 23 },
    ]);
  });

  it('относительные импорты пропускаем', () => {
    expect(modulesOf('from . import x')).toEqual([]);
    expect(modulesOf('from .mod import y')).toEqual([]);
  });

  it('отступ не сбивает столбцы', () => {
    expect(parsePythonImports('    import x')[0]).toMatchObject({ startColumn: 12, endColumn: 13 });
  });

  it('строка и комментарий — не импорт', () => {
    expect(modulesOf('s = "import os"')).toEqual([]);
    expect(modulesOf('# import os')).toEqual([]);
    expect(modulesOf("value = 'from a import b'")).toEqual([]);
  });

  it('многострочная строка скрывает импорт внутри', () => {
    const text = ['"""', 'import os', '"""', 'import sys'].join('\n');
    expect(modulesOf(text)).toEqual(['sys']);
  });

  it('несколько операторов в строке через точку с запятой', () => {
    const refs = parsePythonImports('x = 1; import os');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ module: 'os', startColumn: 15, endColumn: 17 });
  });

  it('точка в докстринге не даёт ложного импорта', () => {
    const text = ['def f():', '    """Смотри import json выше."""', '    return 1'].join('\n');
    expect(modulesOf(text)).toEqual([]);
  });
});

describe('topLevelModules', () => {
  it('уникальные верхнеуровневые имена', () => {
    const refs = parsePythonImports(['import os.path', 'import os', 'from os import sep'].join('\n'));
    expect(topLevelModules(refs)).toEqual(['os']);
  });
});

describe('missingImports', () => {
  it('возвращает только те ссылки, чей модуль отсутствует', () => {
    const refs = parsePythonImports(['import os', 'import requests', 'from flask import Flask'].join('\n'));
    const missing = missingImports(refs, new Set(['requests', 'flask']));
    expect(missing.map((item) => item.top)).toEqual(['requests', 'flask']);
  });
});

/* ── JavaScript и TypeScript ────────────────────────────────────────────── */

/** Имена модулей из текста: позиции проверяются отдельно. */
function scriptModules(text: string): string[] {
  return parseScriptImports(text).map((item) => item.module);
}

describe('packageNameOf', () => {
  it('берёт пакет, а не подпуть', () => {
    expect(packageNameOf('pkg/sub/deep')).toBe('pkg');
    expect(packageNameOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageNameOf('react')).toBe('react');
  });
});

describe('isExternalSpecifier', () => {
  it('проверяем только пакеты', () => {
    expect(isExternalSpecifier('react')).toBe(true);
    expect(isExternalSpecifier('@scope/pkg')).toBe(true);
    expect(isExternalSpecifier('./local')).toBe(false);
    expect(isExternalSpecifier('../up')).toBe(false);
    expect(isExternalSpecifier('/abs')).toBe(false);
    expect(isExternalSpecifier('node:fs')).toBe(false);
    expect(isExternalSpecifier('https://esm.sh/react')).toBe(false);
    expect(isExternalSpecifier('#internal')).toBe(false);
  });
});

describe('parseScriptImports', () => {
  it('именованный, побочный и default-импорт', () => {
    const text = ["import { a } from 'pkg-a'", "import 'pkg-b'", "import React from 'react'"].join('\n');
    expect(scriptModules(text)).toEqual(['pkg-a', 'pkg-b', 'react']);
  });

  it('позиция указывает на имя внутри кавычек', () => {
    expect(parseScriptImports("import x from 'react'")[0]).toEqual({
      module: 'react',
      top: 'react',
      line: 1,
      startColumn: 16,
      endColumn: 21,
    });
  });

  it('`export … from` тоже импорт', () => {
    expect(scriptModules("export { helper } from './helper'\nexport * from 'pkg'")).toEqual(['pkg']);
  });

  it('require и динамический import', () => {
    const text = ["const fs = require('fs-extra')", "const x = await import('lodash')"].join('\n');
    expect(scriptModules(text)).toEqual(['fs-extra', 'lodash']);
  });

  it('подпуть пакета проверяется как сам пакет', () => {
    const refs = parseScriptImports("import { Command } from '@scope/pkg/lib/command'");
    expect(refs[0]).toMatchObject({ module: '@scope/pkg/lib/command', top: '@scope/pkg' });
  });

  it('импорт по нескольким строкам не теряется', () => {
    const text = ['import {', '  alpha,', '  beta,', "} from 'pkg-multi'"].join('\n');
    const refs = parseScriptImports(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ module: 'pkg-multi', line: 4, startColumn: 9, endColumn: 18 });
  });

  it('относительные и встроенные не проверяем', () => {
    const text = ["import a from './a'", "import b from '../b'", "import fs from 'node:fs'"].join('\n');
    expect(scriptModules(text)).toEqual([]);
  });

  it('импорт в комментарии не считается', () => {
    const text = ["// import x from 'ghost'", "/* import y from 'ghost2' */", "import z from 'real'"].join('\n');
    expect(scriptModules(text)).toEqual(['real']);
  });

  it('шаблонная строка с импортом не считается', () => {
    const text = ["const s = `import x from 'ghost'`", "import z from 'real'"].join('\n');
    expect(scriptModules(text)).toEqual(['real']);
  });

  it('type-импорт TypeScript разбирается как обычный', () => {
    expect(scriptModules("import type { Foo } from 'pkg-types'")).toEqual(['pkg-types']);
  });
});
