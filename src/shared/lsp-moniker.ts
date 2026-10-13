/**
 * Разбор ответа `textDocument/moniker`: устойчивое имя символа.
 *
 * Моникер — это идентификатор символа, единый для всех инструментов: `scheme` называет
 * систему имён (`tsc`, `pyright`, `lsif`), `identifier` — сам путь (`tsc:/proj/a.ts:util:fn`),
 * `unique` говорит, различает ли он одноимённые символы. Он нужен, чтобы связать символ
 * здесь с тем же символом в другом инструменте — по индексу кода, документации или графу
 * вызовов: обычной ссылки на файл и строку для этого мало.
 *
 * Модуль чистый: ни сети, ни DOM. Записей бывает несколько (разные схемы), порядок сервера
 * сохраняем как есть — своей правды о том, какая важнее, у нас нет.
 */

/** Моникер символа: система имён и идентификатор в ней. */
export interface MonikerEntry {
  /** Система имён: `tsc`, `pyright`, `lsif`. Пусто — запись бесполезна, пропускаем. */
  readonly scheme: string;
  readonly identifier: string;
  /**
   * Идентификатор различает символы шире одного файла. Сервер называет уровень
   * (`document`, `project`, `group`, `scheme`, `global`); `document` — ненадёжно
   * (в другом файле может стоять такой же), поэтому `true` только для остальных.
   */
  readonly unique: boolean;
}

/** Моникеры из ответа сервера. Битые записи пропускаем: без схемы и пути имени нет. */
export function toMonikers(raw: unknown): MonikerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MonikerEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { scheme?: unknown; identifier?: unknown; unique?: unknown };
    if (typeof value.scheme !== 'string' || value.scheme.length === 0) continue;
    if (typeof value.identifier !== 'string' || value.identifier.length === 0) continue;
    out.push({ scheme: value.scheme, identifier: value.identifier, unique: uniqueAcross(value.unique) });
  }
  return out;
}

/** Различает ли моникер символы шире одного файла: уровень выше `document`. */
function uniqueAcross(level: unknown): boolean {
  return level === 'project' || level === 'group' || level === 'scheme' || level === 'global';
}
