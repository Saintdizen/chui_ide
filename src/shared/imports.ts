/**
 * Импорты Python: что файл подключает и по каким модулям это видно.
 *
 * Здесь только разбор текста — никакой файловой системы: «какой модуль импортируют»
 * это правило языка, а не I/O. Установлен ли модуль, решает main (ему доступен
 * интерпретатор проекта), а подчёркивание рисует renderer.
 *
 * Зачем отдельно от LSP: сервер подсказок знает про импорты только когда он есть
 * и настроен, а «модуль не установлен» — самый заметный промах при первом запуске
 * чужого проекта. Такую проверку IDE может сделать сама.
 */

/**
 * Откуда берётся модуль: из установленных пакетов или из самого проекта.
 *
 * Проверки у них разные, поэтому и вид разный: пакет сверяется с окружением
 * (интерпретатор Python, каталоги `node_modules`), а локальный — с диском: есть ли
 * такой файл рядом с импортирующим. Смешивать их нельзя — `./util` не пакет, и
 * искать его в `node_modules` бессмысленно. Алиас (`@/core`, см. `paths` в tsconfig)
 * — третий вид: пакетом он не считается, но и без конфига проекта про него не
 * скажешь, поэтому ищется по диску только если проект объявил его в `paths`.
 */
export type ImportKind = 'module' | 'local' | 'alias';

/** Одно место в тексте, где подключают модуль. */
export interface ImportRef {
  /** Имя модуля, как написано: `os.path`, `requests`, `./util`, `.mod`. */
  module: string;
  /**
   * Верхнеуровневое имя для проверки установки: `os.path` → `os`, `pkg/sub` → `pkg`.
   * У локального импорта — сам спецификатор: сверять его с пакетами незачем.
   */
  top: string;
  /** Пакет или свой модуль проекта (см. `ImportKind`). */
  kind: ImportKind;
  /** Строка (1-based). */
  line: number;
  /** Столбец начала имени (1-based). */
  startColumn: number;
  /** Столбец сразу после имени (1-based, конец не входит). */
  endColumn: number;
}

type Quote = '"""' | "'''";

/**
 * Затереть в строке всё, что не код: строковые литералы и комментарии.
 *
 * Затираем пробелами, а не выбрасываем, — тогда столбцы кода не сдвигаются и
 * позиции пометок остаются верными. Многострочные строки переносятся между
 * строками через `state`, иначе `import` внутри докстринга дал бы ложную пометку.
 */
function blankLine(line: string, state: { triple: Quote | null }): string {
  const out = line.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < line.length; index += 1) out[index] = ' ';
  };

  let index = 0;
  while (index < line.length) {
    if (state.triple) {
      const close = line.indexOf(state.triple, index);
      if (close < 0) {
        blank(index, line.length);
        index = line.length;
      } else {
        blank(index, close + 3);
        index = close + 3;
        state.triple = null;
      }
      continue;
    }

    const char = line[index];
    if (char === '#') {
      blank(index, line.length);
      break;
    }
    if (char === '"' || char === "'") {
      const triple = line.slice(index, index + 3);
      if (triple === '"""' || triple === "'''") {
        const close = line.indexOf(triple, index + 3);
        if (close < 0) {
          blank(index, line.length);
          state.triple = triple as Quote;
          index = line.length;
        } else {
          blank(index, close + 3);
          index = close + 3;
        }
        continue;
      }
      // Обычная строка в одну строку: до закрывающей кавычки, с учётом экранирования.
      let cursor = index + 1;
      while (cursor < line.length) {
        if (line[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (line[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      blank(index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }

  return out.join('');
}

/** Ссылка на импорт из позиции имени в строке (столбцы 1-based). */
function makeRef(module: string, line: number, column: number, kind: ImportKind = 'module'): ImportRef {
  return {
    module,
    // У локального импорта верхнеуровневым именем считаем его самого: дробление по
    // точке дало бы пустую строку (`.mod`), а сверять его с пакетами не с чем.
    top: kind === 'local' ? module : module.split('.')[0]!,
    kind,
    line,
    startColumn: column + 1,
    endColumn: column + module.length + 1,
  };
}

/**
 * Разбор одного оператора (уже без строк и комментариев).
 * `offset` — с какого столбца строки этот оператор начинается: нужно, чтобы
 * пометка встала точно, когда в строке несколько операторов через `;`.
 */
function parseStatement(statement: string, line: number, offset: number): ImportRef[] {
  const refs: ImportRef[] = [];
  const lead = statement.match(/^\s*/)?.[0].length ?? 0;
  const start = offset + lead;
  const body = statement.slice(lead);

  // `from a.b import c, d` — модуль между `from` и `import`.
  const from = /^from\s+([A-Za-z_.][\w.]*)\s+import\b/.exec(body);
  if (from) {
    const module = from[1]!;
    const at = start + body.indexOf(module);
    if (module.startsWith('.')) {
      // Относительный импорт — свой модуль проекта, проверяется по диску. Берём
      // только названный путь (`.mod`, `..pkg.mod`): у `from . import name` имя
      // может быть определено в `__init__.py`, и файла с таким именем просто нет —
      // пометка была бы ложной.
      if (/^\.+\w/.test(module)) refs.push(makeRef(module, line, at, 'local'));
      return refs;
    }
    refs.push(makeRef(module, line, at));
    return refs;
  }

  // `import a.b as c, d` — имена разделены запятыми, `as` относится к соседнему.
  const plain = /^import\s+/.exec(body);
  if (!plain) return refs;

  const rest = body.slice(plain[0].length);
  const cursor = start + plain[0].length;
  for (const match of rest.matchAll(/(?:^|,)\s*([A-Za-z_][\w.]*)/g)) {
    const module = match[1]!;
    const at = (match.index ?? 0) + match[0].length - module.length;
    refs.push(makeRef(module, line, cursor + at));
  }
  return refs;
}

/** Все импорты в тексте файла: `import …` и `from … import …`. */
export function parsePythonImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const state: { triple: Quote | null } = { triple: null };
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const code = blankLine(lines[index]!, state);
    if (!/\b(?:import|from)\b/.test(code)) continue;

    // Операторы в строке разделены `;` — разбираем каждый на своём месте.
    let offset = 0;
    for (const statement of code.split(';')) {
      refs.push(...parseStatement(statement, index + 1, offset));
      offset += statement.length + 1;
    }
  }

  return refs;
}

/** Уникальные верхнеуровневые имена — то, что имеет смысл проверять на установку. */
export function topLevelModules(imports: readonly ImportRef[]): string[] {
  return [...new Set(imports.filter((item) => item.kind === 'module').map((item) => item.top))];
}

/**
 * Ключ сверки с ответом main: у пакета — верхнеуровневое имя, у своего модуля —
 * спецификатор. Ответ приходит одним списком, и по ключу видно, какая ссылка мимо.
 */
export function importKey(item: ImportRef): string {
  return isLocalKind(item.kind) ? item.module : item.top;
}

/**
 * Что спрашивать у main. Пакеты и локальные пути — разные проверки (окружение
 * против диска), поэтому и уезжают они разными списками, а не одним.
 */
export function checkTargets(imports: readonly ImportRef[]): { modules: string[]; locals: string[] } {
  const modules = new Set<string>();
  const locals = new Set<string>();
  for (const item of imports) {
    if (isLocalKind(item.kind)) locals.add(item.module);
    else modules.add(item.top);
  }
  return { modules: [...modules], locals: [...locals] };
}

/** Импорты, чей модуль отсутствует: их и подчёркиваем. */
export function missingImports(imports: readonly ImportRef[], missing: ReadonlySet<string>): ImportRef[] {
  return imports.filter((item) => missing.has(importKey(item)));
}

/* ── JavaScript и TypeScript ────────────────────────────────────────────── */

/**
 * Имя пакета по подпути: `pkg/sub` → `pkg`, `@scope/pkg/sub` → `@scope/pkg`.
 * Именно пакет проверяется на установку — подпуть это его же содержимое.
 */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0]!;
}

/**
 * Стоит ли вообще проверять этот модуль.
 *
 * Не проверяем: относительные и абсолютные пути (это файлы проекта), ссылки с
 * протоколом (`node:fs`, `data:…`), импорты-подпути пакета (`#internal`) и
 * чужие адреса (`http://…`) — за них отвечает не node_modules.
 */
export function isExternalSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('#')) return false;
  if (specifier.includes(':')) return false;
  return true;
}

/**
 * Что это за спецификатор: установленный пакет, свой модуль проекта или не наша
 * забота.
 *
 * `null` — проверять нечего. Абсолютные пути и адреса с протоколом (`node:fs`,
 * `https://…`) за `node_modules` не отвечают; путь-алиас вида `@/components`
 * (привычка Vite и `paths` в tsconfig) разрешается конфигом, которого мы не
 * читаем, — объявить его недостающим пакетом значило бы врать. Поэтому алиас —
 * свой вид (`alias`): пакетом он не считается, а ищется по диску, как локальный,
 * если проект объявил его в `paths` (см. `aliasesFromTsconfig`).
 */
export function classifySpecifier(specifier: string): ImportKind | null {
  if (!specifier) return null;
  if (specifier === '.' || specifier === '..') return 'local';
  if (specifier.startsWith('./') || specifier.startsWith('../')) return 'local';
  if (specifier.startsWith('@/')) return 'alias';
  return isExternalSpecifier(specifier) ? 'module' : null;
}

/**
 * Стоит ли считать этот вид импорта файлом проекта, а не пакетом.
 *
 * Алиас (`@/core`) — `alias`: на диске он может быть, а может значить что-то
 * другое (алиасы сборщика); разбирает его main, и только по `paths` проекта.
 */
export function isLocalKind(kind: ImportKind): boolean {
  return kind === 'local' || kind === 'alias';
}

/** Алиас импорта из `paths` в tsconfig: `@/*` → `src/*`. */
export interface ImportAlias {
  /** Левая часть как её пишут (`@/*`); `*` означает «здесь хвост». */
  pattern: string;
  /** Куда разворачивается (`src/*`), тоже с `*`. */
  target: string;
  /** Каталог, от которого считается `target` (у `paths` — `baseUrl`). */
  baseDir: string;
}

/**
 * Алиасы импорта из `tsconfig.json` проекта: `compilerOptions.paths` и `baseUrl`.
 *
 * Комментарии в tsconfig разрешены (это JSONC), поэтому срезаем их и висячие запятые
 * перед разбором: иначе `JSON.parse` падает на первом же комментарии, а файл у людей
 * почти всегда с комментариями. Нет `paths` — пусто: алиасов нет.
 */
export function aliasesFromTsconfig(text: string): ImportAlias[] {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const options = (parsed as { compilerOptions?: unknown }).compilerOptions;
  if (!options || typeof options !== 'object') return [];
  const { baseUrl, paths } = options as { baseUrl?: unknown; paths?: unknown };
  if (!paths || typeof paths !== 'object') return [];
  // `baseUrl` в tsconfig обычно `./src` или `.`: храним без ведущего `./`, как пути файлов.
  const baseDir = typeof baseUrl === 'string' ? baseUrl.replace(/^\.\//, '').replace(/\/$/, '') : '';
  const aliases: ImportAlias[] = [];
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== 'string' || target.length === 0) continue;
      aliases.push({ pattern, target: target.replace(/^\.\//, ''), baseDir });
    }
  }
  return aliases;
}

/** Виды лексем: слова (ключевые и имена), строки и одиночная пунктуация. */
interface ScriptToken {
  kind: 'word' | 'string' | 'punct';
  value: string;
  /** Смещение 0-based от начала текста. */
  start: number;
  end: number;
}

/**
 * Лексемы JS/TS без комментариев и шаблонных строк.
 *
 * Строки в JS — это КОД импорта (`import 'pkg'`), поэтому, в отличие от Python,
 * их не затираем, а отдаём отдельными лексемами: только так их видно, и только
 * по контексту (`from`, `require(`) понятно, что это имя модуля. Шаблонные
 * строки пропускаем целиком — внутри них импортов не бывает.
 */
function scriptTokens(text: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (char === '`') {
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '`') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const start = index + 1;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === char) break;
        index += 1;
      }
      tokens.push({ kind: 'string', value: text.slice(start, index), start, end: index });
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < text.length && /[\w$]/.test(text[index]!)) index += 1;
      tokens.push({ kind: 'word', value: text.slice(start, index), start, end: index });
      continue;
    }
    if (!/\s/.test(char)) tokens.push({ kind: 'punct', value: char, start: index, end: index + 1 });
    index += 1;
  }

  return tokens;
}

/**
 * Импорты JS/TS: `import … from`, побочный `import 'x'`, `export … from`,
 * `require('x')` и динамический `import('x')`.
 *
 * Смотрим на лексемы, а не на строки: импорт переносится на несколько строк
 * (`import {\n a,\n b\n} from 'pkg'`), и разбор по строкам его потеряет.
 */
export function parseScriptImports(text: string): ImportRef[] {
  const tokens = scriptTokens(text);

  // Смещение → строка/столбец: позицию считаем один раз на весь файл.
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1);
  }
  const at = (offset: number): { line: number; startColumn: number } => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line += 1;
    return { line: line + 1, startColumn: offset - lineStarts[line]! + 1 };
  };

  const refs: ImportRef[] = [];
  const push = (token: ScriptToken): void => {
    const kind = classifySpecifier(token.value);
    if (!kind) return;
    const { line, startColumn } = at(token.start);
    refs.push({
      module: token.value,
      top: isLocalKind(kind) ? token.value : packageNameOf(token.value),
      kind,
      line,
      startColumn,
      endColumn: startColumn + token.value.length,
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'word') continue;

    // `import('pkg')` — динамический импорт: имя сразу за скобкой.
    if (token.value === 'import' && tokens[index + 1]?.value === '(') {
      const target = tokens[index + 2];
      if (target?.kind === 'string') push(target);
      continue;
    }

    // `import 'pkg'` — побочный импорт: подключают ради эффекта.
    if (token.value === 'import' && tokens[index + 1]?.kind === 'string') {
      push(tokens[index + 1]!);
      continue;
    }

    // `import … from 'pkg'` и `export … from 'pkg'`: имя после `from`.
    if (token.value === 'import' || token.value === 'export') {
      for (let cursor = index + 1; cursor < tokens.length && cursor < index + 60; cursor += 1) {
        const next = tokens[cursor]!;
        if (next.kind === 'punct' && next.value === ';') break;
        if (next.kind === 'word' && next.value === 'from') {
          const target = tokens[cursor + 1];
          if (target?.kind === 'string') push(target);
          break;
        }
      }
      continue;
    }

    // `require('pkg')` — импорт по-старому; в TS так же выглядит `import x = require(…)`.
    if (token.value === 'require' && tokens[index + 1]?.value === '(') {
      const target = tokens[index + 2];
      if (target?.kind === 'string') push(target);
    }
  }

  return refs;
}
