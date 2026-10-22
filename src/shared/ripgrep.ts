/**
 * Поиск по проекту через ripgrep: аргументы и разбор его вывода.
 *
 * ripgrep обходит проект и матчит строки на порядок быстрее, чем обход на `fs`
 * с регулярками в JS: он читает файлы потоком, не поднимая их в строки, и умеет
 * `--json`, где указаны путь, строка, столбец и подстроки совпадения.
 *
 * Модуль чистый: он собирает аргументы команды и разбирает её вывод, а запуск
 * процесса — дело main (там `child_process`). Так обе половины проверяются
 * юнит-тестами: без ripgrep и без файловой системы.
 *
 * Запуск ripgrep — не единственный путь: если его нет в системе, main ищет тем
 * же способом, что и раньше (обход `fs`). Результат у обоих путей один и тот же,
 * поэтому выбор пути не виден ни панели поиска, ни агенту.
 */

import type { SearchHit, SearchOptions, SearchResult } from './api';

/** Потолок длины строки в выводе — тот же, что у собственного обхода. */
const MAX_HIT_LINE_CHARS = 400;

/** Столбец и текст строки по байтовому смещению совпадения. */
function lineOf(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * Столбец совпадения (1-based) по байтовому смещению.
 *
 * ripgrep считает смещение в байтах UTF-8, а наша панель — в символах:
 * без пересчёта в строке с кириллицей столбец уезжал бы вправо.
 */
function columnAt(line: string, byteOffset: number): number {
  if (byteOffset <= 0) return 1;
  // Идём по символам и считаем, сколько байт UTF-8 они занимают: так модуль
  // остаётся чистым — без `Buffer`, которого в renderer нет.
  let bytes = 0;
  let chars = 0;
  for (const char of line) {
    if (bytes >= byteOffset) break;
    bytes += utf8Bytes(char.codePointAt(0) ?? 0);
    chars += 1;
  }
  return chars + 1;
}

/** Длина символа в байтах UTF-8: 1–4, в зависимости от кодовой точки. */
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Соседняя строка: отступы значимы, но длину ограничиваем. */
function clip(text: string): string {
  return text.length > MAX_HIT_LINE_CHARS ? text.slice(0, MAX_HIT_LINE_CHARS) : text;
}

/**
 * Аргументы ripgrep для нашего запроса.
 *
 * `--no-config` обязателен: иначе чужой `RIPGREP_CONFIG_PATH` менял бы выдачу
 * поиска в приложении, и поведение зависело бы от машины. Служебные каталоги
 * исключаем явно (`node_modules`, `.git`, …) — в проекте их и так пропускает
 * свой обход, и набор исключений должен совпадать.
 */
export function ripgrepArgs(
  options: SearchOptions,
  ignoredDirs: readonly string[],
  limit: number,
  context: number,
): string[] {
  const args = ['--json', '--no-config', '--no-messages', '--color', 'never'];
  // Итог со счётчиками ripgrep кладёт отдельной записью `summary` — она нужна
  // ради одного честного числа: сколько файлов он просмотрел.
  args.push('--stats');

  // Регулярку отдаём как есть; обычную строку просим искать буквально.
  if (!options.isRegex) args.push('-F');
  // Умолчание ripgrep — smart-case: он сам решает по запросу. Нам нужен явный выбор.
  args.push(options.caseSensitive ? '-s' : '-i');

  if (options.glob) args.push('-g', globForRipgrep(options.glob));
  for (const dir of ignoredDirs) args.push('-g', `!${dir}`);
  if (context > 0) args.push('-A', String(context), '-B', String(context));
  // Ограничение берём с запасом: в `--json` в поток попадают ещё и строки
  // контекста, а совпадений нам нужно ровно `limit` — остановимся сами.
  args.push('--max-count', String(Math.max(limit, 1)));

  args.push('-e', options.query);
  // `--` отделяет пути: запрос, начинающийся с дефиса, не станет флагом.
  args.push('--', options.path ?? '.');
  return args;
}

/**
 * Маска для ripgrep в том же смысле, что и наша (shared/glob).
 *
 * У ripgrep маска без слэша понимается как имя файла на ЛЮБОЙ глубине
 * (gitignore-семантика), а у нас `*.py` — файлы прямо в области поиска.
 * Ведущий слэш у gitignore означает «от корня», и смыслы сходятся. Маски со
 * слэшем и так привязаны к корню, их не трогаем.
 */
function globForRipgrep(glob: string): string {
  return glob.includes('/') ? glob : `/${glob}`;
}

/** Одна запись `--json`: нас интересуют совпадения и строки контекста. */
interface RipgrepRecord {
  type?: unknown;
  data?: {
    path?: { text?: unknown };
    lines?: { text?: unknown };
    line_number?: unknown;
    submatches?: Array<{ start?: unknown }>;
  };
}

/**
 * Сколько файлов ripgrep просмотрел — из итоговой записи `summary`.
 *
 * Считать по самим совпадениям нельзя (просмотренных файлов больше), а по
 * записям `begin` — тоже: ripgrep печатает `begin` только для файлов, где
 * совпадение ЕСТЬ (проверено на 15.0: 2 записи на 9 просмотренных файлов).
 *
 * Итог всегда последняя строка вывода, поэтому читаем хвост отдельно: разбор
 * обрывается на пределе совпадений и до неё не доходит, а число нужно и тогда.
 */
function searchedCount(output: string): number {
  let end = output.length;
  while (end > 0 && (output[end - 1] === '\n' || output[end - 1] === '\r')) end -= 1;
  const start = output.lastIndexOf('\n', end - 1) + 1;
  if (end <= start) return 0;
  try {
    const record = JSON.parse(output.slice(start, end)) as {
      type?: unknown;
      data?: { stats?: { searches?: unknown } };
    };
    if (record.type !== 'summary') return 0;
    const searches = record.data?.stats?.searches;
    return typeof searches === 'number' ? searches : 0;
  } catch {
    return 0; // строка обрезана — итога нет
  }
}

/**
 * Разбор вывода `rg --json` в нашу форму результата поиска.
 *
 * Строки контекста ripgrep отдаёт отдельными записями вокруг совпадения: те, что
 * шли до него, становятся `before`, следующие за ним — `after`. Порядок записей
 * внутри файла гарантирован, поэтому привязка по номеру строки надёжна.
 */
export function parseRipgrepJson(output: string, options: SearchOptions, limit: number): SearchResult {
  const context = options.filesOnly ? 0 : Math.max(options.context ?? 0, 0);
  const hits: SearchHit[] = [];
  let truncated = false;
  /** Строки, что ждут совпадения: следующая запись `match` возьмёт их как `before`. */
  let before: string[] = [];
  /** Последнее совпадение файла: к нему пристраиваются строки контекста после него. */
  let last: SearchHit | null = null;
  /** Файл, для которого уже есть совпадение: в режиме «только имена» больше не нужно. */
  let filesOnlyPath: string | null = null;

  for (const line of output.split('\n')) {
    if (!line) continue;
    let record: RipgrepRecord;
    try {
      record = JSON.parse(line) as RipgrepRecord;
    } catch {
      continue; // обрывок строки: ripgrep пишет целыми строками, но не доверяем
    }

    const path = typeof record.data?.path?.text === 'string' ? record.data.path.text : null;
    const text = typeof record.data?.lines?.text === 'string' ? record.data.lines.text : null;
    const lineNumber = record.data?.line_number;
    if (!path || text === null || typeof lineNumber !== 'number') continue;

    if (record.type === 'context') {
      const clipLine = clip(lineOf(text));
      // Контекст до совпадения — копим; после — сразу отдаём последнему совпадению.
      if (!last || last.path !== path) {
        before.push(clipLine);
        if (before.length > context) before.shift();
      } else {
        const after = last.after ?? (last.after = []);
        if (after.length < context && lineNumber === last.line + after.length + 1) after.push(clipLine);
        else {
          before = [clipLine].slice(-Math.max(context, 1));
          last = null;
        }
      }
      continue;
    }

    if (record.type !== 'match') continue;

    if (options.filesOnly && filesOnlyPath === path) {
      before = [];
      last = null;
      continue;
    }
    if (hits.length >= limit) {
      truncated = true;
      break;
    }

    const source = lineOf(text);
    const rawLine = source.trim();
    const first = record.data?.submatches?.[0]?.start;
    const hit: SearchHit = {
      path,
      line: lineNumber,
      column: columnAt(rawLine, typeof first === 'number' ? first : 0),
      text: rawLine.slice(0, MAX_HIT_LINE_CHARS),
    };
    if (context > 0) {
      // `before` — ближняя строка последняя, как в собственном обходе.
      if (before.length > 0) hit.before = before.slice(-context);
      // `after` заполнят следующие записи контекста; массив уже заведён.
      hit.after = [];
    }

    hits.push(hit);
    filesOnlyPath = path;
    before = [];
    last = options.filesOnly ? null : hit;
  }

  // Пустые `after` убираем: поле означает «есть строки после», а не «их ноль».
  for (const hit of hits) {
    if (hit.after?.length === 0) delete hit.after;
  }

  hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return { hits, truncated, scanned: scannedCount(output, hits) };
}

/** Просмотренные файлы: итог ripgrep, а без итога — хотя бы те, где есть совпадения. */
function scannedCount(output: string, hits: readonly SearchHit[]): number {
  const searched = searchedCount(output);
  if (searched > 0) return searched;
  // Итога нет (вывод обрезан буфером): отдаём нижнюю границу — файлы, которые
  // мы точно видели. Ноль здесь означал бы «ничего не смотрели», а это ложь.
  return new Set(hits.map((hit) => hit.path)).size;
}
