/**
 * Подсказка пути внутри импорта: `from './ut…'`, `require('./ut…')`, Python `from pkg.ut…`.
 *
 * В строках подсказок нет — там слова это текст, а не код, и попап закрывает ровно то,
 * что человек читает. Но спецификатор импорта — не текст: это путь, и человек его не
 * помнит, а узнаёт из списка файлов. Поэтому место внутри строки-импорта разбирается
 * отдельно и предлагает пути проекта — то, что в больших IDE идёт само собой.
 *
 * Разбор здесь, а не в ассистенте, потому что решений у него много и каждое легко
 * ошибиться незаметно: где кончается строка, что считать импортом (`from`, `import`,
 * `require(`), где в набранном кончается каталог и начинается имя. Модуль чистый: строка
 * строки и список файлов на входе, подсказки на выходе — поэтому проверяется тестами.
 */

import { matchScore } from './fuzzy';
import type { CompletionItem } from './completions';

/** Языки, у которых спецификатор пишется строкой в кавычках (`./путь`). */
const QUOTED_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript']);

/** Где стоит каретка: что человек печатает и с какого смещения начнётся замена. */
export interface ImportPathContext {
  /** Набранное после последнего разделителя — по нему отбираются пути. */
  readonly prefix: string;
  /**
   * Уже набранный каталог вместе с разделителем: `./src/`, `../lib/`, `pkg.`.
   * Пустая строка — каталог ещё не набирали.
   */
  readonly dir: string;
  /**
   * Как записывается спецификатор: `quoted` — путь в кавычках (JS/TS), `dotted` —
   * модуль точками (Python). От этого зависит вид подсказок.
   */
  readonly style: 'quoted' | 'dotted';
}

/** Расширения, которые в спецификаторе не пишутся: `./utils`, а не `./utils.ts`. */
const CODE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Имя файла индекса: `./dir/index.ts` в импорте пишется как `./dir`. */
const INDEX_STEM = 'index';

/**
 * Разобрать место под кареткой. `null` — это не импорт: подсказки путей тут ни при чём.
 *
 * Для JS/TS ищем строку, внутри которой стоит каретка, и смотрим, что перед строкой:
 * `from`, `import` или вызов `require(`. Для Python кавычек нет вовсе: там смотрим на
 * начало строки — `from` или `import` и набранный модуль после них.
 */
export function importPathAt(text: string, column: number, languageId: string): ImportPathContext | null {
  const at = Math.max(0, Math.min(column, text.length));
  if (QUOTED_LANGUAGES.has(languageId.toLowerCase())) return quotedImportAt(text, at);
  if (languageId.toLowerCase() === 'python') return dottedImportAt(text, at);
  return null;
}

/** Спецификатор в кавычках: `from './x'`, `import './x'`, `require('./x')`. */
function quotedImportAt(text: string, at: number): ImportPathContext | null {
  // Ближайшая кавычка слева — открывающая: кавычку внутри спецификатора не пишут.
  let open = -1;
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (char !== "'" && char !== '"' && char !== '`') continue;
    // Экранированная кавычка — часть текста, а не начало строки.
    if (text[index - 1] === '\\') continue;
    open = index;
    break;
  }
  if (open < 0) return null;

  const quote = text[open]!;
  const content = text.slice(open + 1, at);
  // Кавычка внутри набранного значит, что строка уже закрыта и каретка вне её.
  if (content.includes(quote) || content.includes('\n')) return null;
  if (!looksLikeSpecifier(content)) return null;
  if (!importKeywordBefore(text.slice(0, open))) return null;

  return contextFrom('quoted', content, '/');
}

/** Перед строкой стоит то, откуда путь берётся: `from`, `import`, `require(`, `import(`. */
function importKeywordBefore(before: string): boolean {
  // Комментарий — не код: в `// пример: from "./x"` импорта нет, там текст.
  if (before.includes('//')) return false;
  return /(?:^|[^\w$.])(?:from|import)\s*$/.test(before) || /(?:require|import)\s*\(\s*$/.test(before);
}

/** Набранное похоже на спецификатор: без пробелов и знаков, которых в путях не бывает. */
function looksLikeSpecifier(content: string): boolean {
  return !/[\s,;(){}[\]<>+=*&|!?]/.test(content);
}

/** Модуль Python: `from pkg.mod import x`, `import pkg.mod`. */
function dottedImportAt(text: string, at: number): ImportPathContext | null {
  const before = text.slice(0, at);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  // Каретка внутри набираемого модуля и нигде больше: `from pkg import |` — это уже
  // имена из модуля, а не он сам, и пути там не подсказывают.
  const match = /^\s*(?:from|import)\s+([\w.]*)$/.exec(line);
  if (!match) return null;
  return contextFrom('dotted', match[1] ?? '', '.');
}

/** Разделить набранное на каталог и имя: `./src/ut` → dir `./src/`, prefix `ut`. */
function contextFrom(style: 'quoted' | 'dotted', content: string, separator: string): ImportPathContext {
  const cut = content.lastIndexOf(separator);
  if (cut < 0) return { prefix: content, dir: '', style };
  return { prefix: content.slice(cut + 1), dir: content.slice(0, cut + 1), style };
}

/**
 * Спецификатор файла проекта относительно файла, в котором печатают.
 *
 * `null` — этот файл в подсказках не участвует: сам себя не импортируют.
 */
export function specifierFor(target: string, fromFile: string, languageId: string): string | null {
  const fromDir = dirnameOf(fromFile);
  const language = languageId.toLowerCase();
  if (language === 'python') return dottedModule(target);
  return quotedSpecifier(target, fromDir);
}

/** Каталог пути в POSIX-виде: пустая строка — файл в корне проекта. */
function dirnameOf(target: string): string {
  const cut = target.lastIndexOf('/');
  return cut < 0 ? '' : target.slice(0, cut);
}

/** `./`-путь без расширения кода и без `/index`: то, что пишут в импорте. */
function quotedSpecifier(target: string, fromDir: string): string | null {
  const stem = stripExtension(target);
  if (stem === null) return null;
  const path = relativePath(fromDir, stem);
  if (path === null) return null;
  return path.startsWith('.') ? path : `./${path}`;
}

/** Путь от каталога к файлу: `../lib/a`, `b/c`. `null` — файл не в проекте. */
function relativePath(fromDir: string, target: string): string | null {
  const fromParts = fromDir.length === 0 ? [] : fromDir.split('/');
  const toParts = target.split('/');
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length - 1 && fromParts[shared] === toParts[shared]) shared += 1;
  const up = fromParts.length - shared;
  const rest = toParts.slice(shared);
  if (rest.length === 0) return null;
  return [...Array.from({ length: up }, () => '..'), ...rest].join('/');
}

/**
 * Убрать из пути расширение и имя файла индекса.
 *
 * Расширения кода в импорте не пишутся (`./utils`), а `index` в конце означает сам
 * каталог (`./widgets`, а не `./widgets/index`). Прочие файлы (`data.json`, `style.css`)
 * остаются как есть: их расширение как раз и пишут.
 */
function stripExtension(target: string): string | null {
  const cut = target.lastIndexOf('/');
  const name = cut < 0 ? target : target.slice(cut + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot).toLowerCase();
  const stem = dot < 0 ? name : name.slice(0, dot);
  if (stem.length === 0) return null;
  if (CODE_EXTENSIONS.includes(extension)) {
    const dir = cut < 0 ? '' : target.slice(0, cut);
    if (stem === INDEX_STEM) return dir.length === 0 ? null : dir;
    return dir.length === 0 ? stem : `${dir}/${stem}`;
  }
  return target;
}

/** Модуль Python: путь без `.py`, разделители — точки, `__init__` — сам пакет. */
function dottedModule(target: string): string | null {
  if (!target.toLowerCase().endsWith('.py')) return null;
  const parts = target.slice(0, -3).split('/');
  if (parts[parts.length - 1] === '__init__') parts.pop();
  if (parts.length === 0) return null;
  // Корень проекта в модуль не входит: `app.auth`, а не `src.app.auth`, если файл
  // лежит в `src/app/auth.py` — но какой каталог корневой, отсюда не видно. Поэтому
  // берём путь от корня и оставляем его честным: подсказка показывает то, что есть.
  return parts.join('.');
}

/**
 * Подсказки путей для места под кареткой: файлы и каталоги проекта.
 *
 * Отбор — теми же правилами, что и слова (`fuzzy.ts`): набранное совпадает с началом
 * или с «горбами». Подпись — полный спецификатор (видно, откуда файл), а вставляется
 * только хвост: набранный каталог в строке уже есть, дублировать его нельзя.
 */
export function importPathItems(
  files: readonly string[],
  fromFile: string,
  languageId: string,
  context: ImportPathContext,
  limit = 50,
): CompletionItem[] {
  const found = new Map<string, { item: CompletionItem; score: number }>();
  const language = languageId.toLowerCase();

  // Каталоги тоже годятся в импорт: `from './widgets'` — это файл `widgets/index.ts`.
  // Идём по каталогам первыми: у каталога и его файла индекса спецификатор один и тот
  // же, и правдивее сказать «каталог» — именно его и импортируют.
  const dirs = new Set<string>();
  if (language !== 'python') {
    for (const file of files) {
      const cut = file.lastIndexOf('/');
      if (cut > 0) dirs.add(file.slice(0, cut));
    }
  }
  const targets = [...dirs, ...files];

  for (const target of targets) {
    if (target === fromFile) continue;
    const specifier = specifierFor(target, fromFile, languageId);
    if (specifier === null || specifier === '') continue;
    // Набранный каталог должен совпасть: список — про это место, а не про весь проект.
    if (!specifier.startsWith(context.dir)) continue;
    if (context.dir.length === 0 && specifier.startsWith('..')) continue;

    const tail = specifier.slice(context.dir.length);
    if (tail.length === 0) continue;
    const match = context.prefix.length === 0 ? { score: 0, positions: [] } : matchScore(tail, context.prefix);
    if (!match) continue;

    const isDir = dirs.has(target);
    if (found.has(specifier)) continue;
    // Порядок: совпадение с начала важнее, короткий путь ближе.
    found.set(specifier, {
      item: {
        label: specifier,
        kind: 'word',
        detail: isDir ? 'каталог' : 'файл',
        insert: tail,
        positions: match.positions,
      },
      score: match.score - specifier.length,
    });
  }

  return [...found.values()]
    .sort((left, right) => right.score - left.score || left.item.label.length - right.item.label.length)
    .slice(0, limit)
    .map((entry) => entry.item);
}
