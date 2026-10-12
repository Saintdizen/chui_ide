/**
 * Разбор отчёта покрытия в формате JSON (coverage.py).
 *
 * Терминальный отчёт (`term-missing`) даёт только НОМЕРА непокрытых строк — по нему
 * нельзя сказать, что ветвь условия пройдена наполовину. Формат JSON богаче: у
 * каждого файла есть `executed_lines`, `missing_lines` и пары ветвей —
 * `executed_branches`/`missing_branches` (каждая пара — это [откуда, куда]).
 *
 * «Частично пройденная ветвь» — строка, с которой ушли не все ветви: часть дуг
 * исполнена, часть нет. Считаем так: берём строки, у которых ЕСТЬ исполненные дуги,
 * и оставляем те, у которых есть и неисполненные. Именно эти строки и подсвечиваем
 * иначе, чем полностью непокрытые.
 *
 * Разбор терпимый: незнакомые поля игнорируются, битый JSON даёт пустой отчёт — это
 * файл, который мог остаться от чужого прогона, а не данные, на которых стоит падать.
 */

/** Покрытие одного файла: что не исполнено и где ветви пройдены наполовину. */
export interface CoverageFileEntry {
  /** Путь, как его назвал отчёт (обычно относительный к корню проекта). */
  path: string;
  /** Номера строк, не исполненных тестами. */
  missingLines: number[];
  /** Номера строк, где ветвь пройдена лишь частично (часть дуг исполнена). */
  partialLines: number[];
}

/** Что даёт JSON-отчёт: файлы и общий процент, если он там есть. */
export interface CoverageJsonReport {
  files: CoverageFileEntry[];
  /** Процент из `totals.percent_covered`, если его удалось прочитать. */
  total: number | null;
}

/** Число из значения неизвестного типа (строку тоже принимаем). */
function toNumber(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) ? num : null;
}

/** Список номеров строк из массива значений. */
function lineNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const lines: number[] = [];
  for (const item of value) {
    const line = toNumber(item);
    if (line !== null && line >= 1) lines.push(Math.floor(line));
  }
  return lines;
}

/**
 * Строки, у которых часть дуг исполнена, а часть — нет. Пары ветвей бывают и в
 * виде `[строка, строка]`, и в виде `[строка, строка, ...]`; нам нужен первый
 * элемент — откуда дуга выходит.
 */
function partialLines(executed: unknown, missing: unknown): number[] {
  const takenFrom = new Set<number>();
  const missedFrom = new Set<number>();
  const collect = (source: unknown, into: Set<number>): void => {
    if (!Array.isArray(source)) return;
    for (const pair of source) {
      if (!Array.isArray(pair) || pair.length === 0) continue;
      const from = toNumber(pair[0]);
      if (from !== null && from >= 1) into.add(Math.floor(from));
    }
  };
  collect(executed, takenFrom);
  collect(missing, missedFrom);
  const result: number[] = [];
  for (const line of missedFrom) if (takenFrom.has(line)) result.push(line);
  return result.sort((a, b) => a - b);
}

/**
 * Разобрать `coverage.json` (отчёт `coverage json` / `--cov-report=json`). Файлы без
 * непокрытых строк и без частичных ветвей пропускаем: подсвечивать в них нечего.
 */
export function parseCoverageJson(text: string): CoverageJsonReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { files: [], total: null };
  }
  if (typeof raw !== 'object' || raw === null) return { files: [], total: null };
  const value = raw as { files?: unknown; totals?: unknown };
  const source = value.files;
  if (typeof source !== 'object' || source === null) return { files: [], total: null };

  const files: CoverageFileEntry[] = [];
  for (const [path, entry] of Object.entries(source as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const file = entry as Record<string, unknown>;
    const missingLines = lineNumbers(file.missing_lines).sort((a, b) => a - b);
    const partial = partialLines(file.executed_branches, file.missing_branches);
    if (missingLines.length === 0 && partial.length === 0) continue;
    files.push({ path, missingLines, partialLines: partial });
  }

  let total: number | null = null;
  if (typeof value.totals === 'object' && value.totals !== null) {
    total = toNumber((value.totals as { percent_covered?: unknown }).percent_covered);
  }
  return { files, total };
}
