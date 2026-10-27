/**
 * Переезд путей в импортах: переписать спецификаторы, ссылающиеся на
 * переименованный или перенесённый файл (или папку).
 *
 * Переименовать `utils/foo.ts` в `utils/bar.ts` мало: половина проекта ссылается
 * на него по старому пути, и код перестаёт собираться. Здесь это исправляется:
 * для каждого файла проекта считается, как он писал бы путь к цели, — и те
 * спецификаторы, что указывают на прежнюю цель, переводятся на новую.
 *
 * Модуль чистый: он работает со строками и относительными `/`-путями от корня
 * проекта, ничего не знает ни о файловой системе, ни о `node:path` (в renderer его
 * нет). Поэтому проверяется тестами без диска; чтение и запись файлов — в main.
 *
 * Понимаем два вида импортов:
 *   • как в JS/TS: `from './x'`, `import './x'`, `import('./x')`, `require('./x')`,
 *     `@import './x'` — спецификатор здесь строка в кавычках;
 *   • как в Python: `from .utils.foo import x`, `import pkg.utils.foo` — модуль
 *     записывается точками, а относительный путь — ведущими точками.
 *
 * Правило осторожности: трогаем только относительные спецификаторы (начинающиеся
 * с точки). Абсолютные в Python — отдельный случай: `import pkg.utils` в проекте,
 * где корень лежит на `sys.path`, тоже правим, но сравнение идёт по полному пути
 * модуля, а не по имени пакета-соседа. Имя пакета из `node_modules` совпасть с
 * нашей целью не может: оно не начинается с точки.
 */

/** Расширения, которые снимаем при сверке: `./foo.js` и `./foo.ts` — один модуль. */
const MODULE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'json',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
]);

/** Вид импортов — по расширению файла. `null` — язык нам неизвестен, файл пропускаем. */
export type ImportStyle = 'js' | 'python';

/** Расширения с импортами «как в JS» (в том числе `@import` в CSS). */
const JS_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
]);

/** Стиль импортов по имени файла (достаточно расширения). `null` — править нечего. */
export function importStyleOf(name: string): ImportStyle | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (JS_EXTENSIONS.has(ext)) return 'js';
  if (ext === 'py') return 'python';
  return null;
}

export interface ImportRewrite {
  /** Текст после правки; совпадает с исходным, если менять было нечего. */
  text: string;
  /** Сколько спецификаторов поправлено — по числу видно, был ли эффект. */
  count: number;
}

export interface ImportRewriteOptions {
  /** Файл, в котором правим импорты: путь от корня проекта с `/`. */
  file: string;
  /** Прежний путь цели (файл или папка) от корня проекта с `/`. */
  oldTarget: string;
  /** Новый путь цели от корня проекта с `/`. */
  newTarget: string;
  style: ImportStyle;
}

/** Точка входа: переписать импорты файла под переезд цели. */
export function rewriteImports(text: string, options: ImportRewriteOptions): ImportRewrite {
  if (!text || !options.oldTarget || !options.newTarget || options.oldTarget === options.newTarget) {
    return { text, count: 0 };
  }
  return options.style === 'python' ? rewritePython(text, options) : rewriteJs(text, options);
}

/* ── общая арифметика путей ─────────────────────────────────────────────── */

/** Каталог пути: всё до последнего `/`. Файл в корне — пустой каталог. */
function dirOf(target: string): string {
  const slash = target.lastIndexOf('/');
  return slash < 0 ? '' : target.slice(0, slash);
}

/**
 * Как из каталога `fromDir` записать путь к `target` — так, как это пишут руками:
 * `./foo`, `../utils`, `..`. Оба пути — от корня проекта с `/`.
 */
function relativeSpecifier(fromDir: string, target: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/');
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;

  const up = from.length - common;
  const down = to.slice(common);
  if (down.length === 0) return up === 0 ? './' : '../'.repeat(up).replace(/\/$/, '');
  return (up === 0 ? './' : '../'.repeat(up)) + down.join('/');
}

/** Разделить спецификатор на основу и расширение модуля (`./foo.js` → `./foo` + `.js`). */
function splitExtension(specifier: string): { base: string; ext: string } {
  const slash = specifier.lastIndexOf('/');
  const dot = specifier.lastIndexOf('.');
  // Точка в имени каталога (`../foo.bar/baz`) расширением не является: она раньше «/».
  if (dot <= slash + 1) return { base: specifier, ext: '' };
  const ext = specifier.slice(dot + 1).toLowerCase();
  if (!MODULE_EXTENSIONS.has(ext)) return { base: specifier, ext: '' };
  return { base: specifier.slice(0, dot), ext: specifier.slice(dot) };
}

/* ── импорты как в JS/TS ────────────────────────────────────────────────── */

/** Строковый литерал — им и является спецификатор в JS-подобных импортах. */
const JS_SPECIFIER = /(['"])([^'"\n]*)\1/g;

/** Ключевые слова, после которых строка — это путь к модулю. */
function precededByImportKeyword(text: string, at: number): boolean {
  // Хвост перед кавычкой без пробелов и скобок: `require(` и `import(` дают то же слово.
  const head = text.slice(Math.max(0, at - 32), at).replace(/[(\s]+$/, '');
  return /(?:^|[^\w$])(?:from|import|require)$/.test(head);
}

function rewriteJs(text: string, options: ImportRewriteOptions): ImportRewrite {
  const fromDir = dirOf(options.file);
  // Расширение цели снимаем: в импортах его обычно не пишут (`./foo`, не `./foo.ts`),
  // и наша основа должна совпадать с тем, что человек написал руками.
  const oldBase = relativeSpecifier(fromDir, splitExtension(options.oldTarget).base);
  const newBase = relativeSpecifier(fromDir, splitExtension(options.newTarget).base);

  let out = '';
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(JS_SPECIFIER)) {
    const specifier = match[2]!;
    const at = match.index ?? 0;
    if (!precededByImportKeyword(text, at)) continue;
    const replaced = rewriteJsSpecifier(specifier, oldBase, newBase);
    if (replaced === null) continue;
    // Кавычки оставляем как были (одинарные или двойные) — меняем только путь.
    out += text.slice(last, at + 1) + replaced;
    last = at + 1 + specifier.length;
    count += 1;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(last), count };
}

/** Спецификатор, указывающий на прежнюю цель (саму или внутри неё), → новый путь. */
function rewriteJsSpecifier(specifier: string, oldBase: string, newBase: string): string | null {
  // Абсолютные пути (`react`, `@app/…`) не наши: у них нет общего с целью начала.
  if (!specifier.startsWith('.')) return null;
  const { base, ext } = splitExtension(specifier);
  // Совпадение по границе сегмента: `./utils` — наша цель, `./utilsx` — чужая.
  if (base !== oldBase && !base.startsWith(`${oldBase}/`)) return null;
  return newBase + base.slice(oldBase.length) + ext;
}

/* ── импорты как в Python ───────────────────────────────────────────────── */

/** `from <модуль> import …`: берём сам модуль, не список имён. */
const PY_FROM = /(\bfrom\s+)([.\w]+)(\s+import\b)/g;
/** `import <модуль>[, <модуль>]`: имён может быть несколько в одной строке. */
const PY_IMPORT = /^([ \t]*import[ \t]+)([^\n#]+)/gm;

/** Путь файла-цели в виде модуля: `pkg/utils/foo.py` → `pkg.utils.foo`. */
function pythonModule(target: string): string[] {
  const parts = target.split('/');
  const last = parts[parts.length - 1]!;
  if (last.endsWith('.py')) parts[parts.length - 1] = last.slice(0, -3);
  // `__init__.py` — это сам пакет, а не модуль внутри него.
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts;
}

/** Относительный импорт от пакета файла: `from .utils`, `from ..pkg.utils`. */
function pythonRelative(packageParts: readonly string[], moduleParts: readonly string[]): string {
  let common = 0;
  while (common < packageParts.length && common < moduleParts.length && packageParts[common] === moduleParts[common]) {
    common += 1;
  }
  // Первая точка — текущий пакет, дальше по одной на подъём.
  return `${'.'.repeat(packageParts.length - common + 1)}${moduleParts.slice(common).join('.')}`;
}

function rewritePython(text: string, options: ImportRewriteOptions): ImportRewrite {
  const packageParts = dirOf(options.file) === '' ? [] : dirOf(options.file).split('/');
  const oldModule = pythonModule(options.oldTarget);
  const newModule = pythonModule(options.newTarget);
  if (oldModule.length === 0 || newModule.length === 0) return { text, count: 0 };

  const oldRelative = pythonRelative(packageParts, oldModule);
  const newRelative = pythonRelative(packageParts, newModule);
  const oldAbsolute = oldModule.join('.');
  const newAbsolute = newModule.join('.');

  const from = rewriteFromLines(text, { oldRelative, newRelative, oldAbsolute, newAbsolute });
  const imported = rewriteImportLines(from.text, { oldAbsolute, newAbsolute });
  return { text: imported.text, count: from.count + imported.count };
}

/** Переписать модуль в строках `from X import …`. */
function rewriteFromLines(
  text: string,
  names: { oldRelative: string; newRelative: string; oldAbsolute: string; newAbsolute: string },
): ImportRewrite {
  let out = '';
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(PY_FROM)) {
    const module = match[2]!;
    const replaced = module.startsWith('.')
      ? prefixReplace(module, names.oldRelative, names.newRelative)
      : prefixReplace(module, names.oldAbsolute, names.newAbsolute);
    if (replaced === null) continue;
    const at = (match.index ?? 0) + match[1]!.length;
    out += text.slice(last, at) + replaced;
    last = at + module.length;
    count += 1;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(last), count };
}

/** Переписать модули в строках `import X[, Y]` — только абсолютные (относительных тут не бывает). */
function rewriteImportLines(text: string, names: { oldAbsolute: string; newAbsolute: string }): ImportRewrite {
  let out = '';
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(PY_IMPORT)) {
    const list = match[2]!;
    const parts = list.split(',');
    let changed = false;
    const next = parts.map((item) => {
      const token = /^(\s*)([\w.]+)([\s\S]*)$/.exec(item);
      if (!token) return item;
      const replaced = prefixReplace(token[2]!, names.oldAbsolute, names.newAbsolute);
      if (replaced === null) return item;
      changed = true;
      count += 1;
      // `as псевдоним` и пробелы вокруг имени сохраняем как были.
      return token[1]! + replaced + token[3]!;
    });
    if (!changed) continue;
    const at = (match.index ?? 0) + match[1]!.length;
    out += text.slice(last, at) + next.join(',');
    last = at + list.length;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(last), count };
}

/** Модуль, равный прежнему или вложенный в него, → тот же хвост под новым именем. */
function prefixReplace(module: string, oldModule: string, newModule: string): string | null {
  if (!oldModule) return null;
  if (module !== oldModule && !module.startsWith(`${oldModule}.`)) return null;
  return newModule + module.slice(oldModule.length);
}
