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
