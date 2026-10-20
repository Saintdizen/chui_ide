import { parseToolArguments } from './tools';
import { booleanArg, integerArg } from './tool-args';

/**
 * Учёт уже прочитанных диапазонов файлов в агентном цикле.
 *
 * Агент часто просит один и тот же кусок дважды — то по забывчивости, то после
 * усечения истории. Такой повтор не исполняем: текст уже есть выше в ветке.
 * Логика чистая (только разбор аргументов), поэтому живёт в `shared` и
 * проверяется тестами без Electron (см. `tests/read-coverage.test.ts`).
 */

/** Покрыт ли запрошенный диапазон одним из уже прочитанных. */
export function isCovered(ranges: ReadonlyArray<{ from: number; to: number }>, from: number, to: number): boolean {
  return ranges.some((range) => range.from <= from && range.to >= to);
}

/**
 * Запрос read_file, целиком лежащий в уже прочитанном диапазоне: такой повтор не
 * исполняем — текст уже есть выше в ветке. Ловим только запросы с явным endLine:
 * без него верхняя граница (конец файла) нам неизвестна.
 */
export function coveredRequest(
  name: string,
  rawArguments: string,
  reads: ReadonlyMap<string, Array<{ from: number; to: number }>>,
): { path: string; from: number; to: number } | undefined {
  if (name !== 'read_file') return undefined;
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return undefined;
  // force: явный запрос перечитать — контент мог выпасть из контекста. Флаг бывает
  // и строкой «true»: не разобрав его, мы бы отдали «уже прочитано» вместо текста.
  if (booleanArg(parsed.value.force) === true) return undefined;
  const target = parsed.value.path;
  const endLine = integerArg(parsed.value.endLine);
  if (typeof target !== 'string' || endLine === undefined) return undefined;
  const from = Math.max(1, integerArg(parsed.value.startLine) ?? 1);
  // Перевёрнутый диапазон (конец раньше начала) — не наш случай: такому запросу
  // инструмент ответит своим отказом с объяснением, и подменять его вестью
  // «уже прочитано» значило бы прятать ошибку в аргументах.
  if (endLine < from) return undefined;
  const to = endLine;
  const ranges = reads.get(target);
  if (!ranges || !isCovered(ranges, from, to)) return undefined;
  return { path: target, from, to };
}

/** Запомнить прочитанный диапазон файла. */
export function rememberRead(
  reads: Map<string, Array<{ from: number; to: number }>>,
  read: { path: string; from: number; to: number },
): void {
  const ranges = reads.get(read.path) ?? [];
  ranges.push({ from: read.from, to: read.to });
  reads.set(read.path, ranges);
}

/* ── забыть прочитанное об изменившихся файлах ───────────────────────────────
 * Агентный цикл помнит, что уже прочитал: повтор того же вызова не исполняется, а
 * запрос диапазона внутри прочитанного заменяется ссылкой «текст выше». Пока файлы
 * не менялись, это чистая экономия. После правки память о затронутом файле — уже
 * неправда: текст в ветке беседы остался старым.
 *
 * Раньше после любого изменяющего вызова чистилось ВСЁ: одна правка в `src/a.ts`
 * заставляла модель заново читать любой другой файл, который она уже держала в
 * контексте, — лишние шаги и токены на ровном месте. Поэтому забываем прицельно:
 * только то, что правка действительно задела, а когда задетое назвать нельзя
 * (команда в терминале, массовая замена по маске) — по-прежнему всё.
 */

/** Ключ сравнения путей: разделители к одному виду. Регистр не трогаем — он важен. */
function pathKey(target: string): string {
  return target.replace(/\\/g, '/');
}

/** Аргумент-путь: строка — берём, иначе нет. */
function pathOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Пути из массива объектов по полю `path` — так устроены `edits` и `patches`. */
function pathsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const found: string[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const path = pathOf((item as { path?: unknown }).path);
    if (path) found.push(path);
  }
  return found;
}

/**
 * Какие файлы задел изменяющий вызов. `null` — назвать нельзя (команда, массовая
 * замена по маске, переименование символа): тогда забывать приходится всё.
 *
 * Пути берём из двух мест: из результата (`changes` — создание, удаление, перенос)
 * и из самих аргументов (`edits`, `patches`, `path`, `from`/`to`). Второе важнее для
 * правок: они идут через ревью в renderer и `changes` не заполняют.
 */
export function touchedPaths(
  name: string,
  rawArguments: string,
  changes?: readonly { path: string; from?: string }[],
): Set<string> | null {
  const paths = new Set<string>();
  for (const change of changes ?? []) {
    paths.add(pathKey(change.path));
    if (change.from) paths.add(pathKey(change.from));
  }

  const parsed = parseToolArguments(rawArguments);
  if (parsed.ok) {
    const args = parsed.value;
    if (name === 'edit') {
      // Форма зависит от действия: по позициям файлы в `edits[]`, по якорю — в
      // `patches[]`. Одиночный файл без обёртки в массив — тоже законная форма
      // (см. разбор в agent-tools): тогда `path` лежит прямо в аргументах.
      const own = pathOf(args.path);
      if (own) paths.add(pathKey(own));
      for (const path of pathsOf(args.edits)) paths.add(pathKey(path));
      for (const path of pathsOf(args.patches)) paths.add(pathKey(path));
    } else if (name === 'create_file' || name === 'delete_file') {
      const path = pathOf(args.path);
      if (path) paths.add(pathKey(path));
    } else if (name === 'move_file') {
      for (const key of ['from', 'to']) {
        const path = pathOf(args[key]);
        if (path) paths.add(pathKey(path));
      }
    }
  }

  return paths.size > 0 ? paths : null;
}

/** Диапазоны прочитанного по файлам: тот же вид, что ведёт агентный цикл. */
type ReadRanges = Map<string, Array<{ from: number; to: number }>>;

/**
 * Почистить кеши чтений после изменяющего вызова. Оба кеша — те, что ведёт
 * агентный цикл: что уже исполнялось (`executed`) и какие диапазоны прочитаны
 * (`coveredReads`). Всё, что касается затронутых файлов, забывается; остальное
 * остаётся — его правка не касалась.
 */
export function forgetChangedFiles<T>(
  caches: { executed: Map<string, T>; coveredReads: ReadRanges },
  name: string,
  rawArguments: string,
  changes?: readonly { path: string; from?: string }[],
): void {
  const touched = touchedPaths(name, rawArguments, changes);
  // Задетое назвать нельзя — что ж, тогда доверяем прежнему правилу: менялось всё.
  if (touched === null) {
    caches.executed.clear();
    caches.coveredReads.clear();
    return;
  }

  for (const key of caches.coveredReads.keys()) {
    if (touched.has(pathKey(key))) caches.coveredReads.delete(key);
  }

  // Ключ кеша — `имя:аргументы`. Имя двоеточий не содержит, поэтому режем по первому.
  for (const key of caches.executed.keys()) {
    const at = key.indexOf(':');
    if (at < 0) continue;
    const callArgs = parseToolArguments(key.slice(at + 1));
    if (!callArgs.ok) continue;
    const args = callArgs.value;
    const paths = [pathOf(args.path), pathOf(args.from), pathOf(args.to)].filter(
      (path): path is string => path !== null,
    );
    // Файлы из правок тоже: `executed` помнит и read_file, и сами правки.
    for (const inner of pathsOf(args.edits)) paths.push(inner);
    for (const inner of pathsOf(args.patches)) paths.push(inner);
    if (paths.some((path) => touched.has(pathKey(path)))) caches.executed.delete(key);
  }
}
