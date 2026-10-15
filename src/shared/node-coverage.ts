/**
 * Разбор отчёта покрытия Node в формате istanbul (`coverage-final.json`).
 *
 * Такой отчёт пишут и vitest (`--coverage.reporter=json`), и jest
 * (`--coverageReporters=json`). Формат другой, чем у coverage.py: нет готовых
 * `missing_lines`, зато есть `statementMap`/`s` (операторы и число их исполнений)
 * и `branchMap`/`b` (ветви и число проходов по каждой дуге). Из этого собираем то же,
 * что нужно IDE: непокрытые строки, частично пройденные ветви и процент.
 *
 * Строка считается покрытой, если на ней исполнен ХОТЯ БЫ один оператор — так же
 * считает istanbul. Ветвь «пройдена наполовину», если часть её дуг исполнена, а
 * часть нет: только такие строки и подсвечиваем иначе, чем полностью непокрытые.
 *
 * Разбор терпимый: незнакомые поля игнорируются, битый JSON даёт пустой отчёт —
 * это файл, который мог остаться от чужого прогона, а не данные, на которых стоит
 * падать.
 */

/** Покрытие одного файла: то, что нужно строке панели и подсветке редактора. */
export interface NodeCoverageFile {
  /** Путь, как его назвал отчёт (обычно абсолютный — от `process.cwd()` раннера). */
  path: string;
  /** Процент покрытых строк. */
  percent: number;
  /** Всего строк с операторами. */
  statements: number;
  /** Непокрытых строк. */
  missing: number;
  /** Номера непокрытых строк. */
  missingLines: number[];
  /** Всего ветвей (по числу дуг). */
  branches: number;
  /** Частично пройденных ветвей (часть дуг исполнена). */
  branchPartial: number;
  /** Номера строк с частично пройденными ветвями. */
  partialLines: number[];
}

/** Что даёт отчёт Node: файлы и общий процент. */
export interface NodeCoverageReport {
  files: NodeCoverageFile[];
  /** Процент по всему прогону; null — считать было нечего. */
  total: number | null;
}

/** Число из значения неизвестного типа (строку тоже принимаем). */
function toNumber(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) ? num : null;
}

/** Номер строки из `{ start: { line } }`; null — поля нет или оно не число. */
function startLine(location: unknown): number | null {
  if (typeof location !== 'object' || location === null) return null;
  const start = (location as { start?: unknown }).start;
  if (typeof start !== 'object' || start === null) return null;
  const line = toNumber((start as { line?: unknown }).line);
  return line !== null && line >= 1 ? Math.floor(line) : null;
}

/**
 * Покрытие строк одного файла: строка → исполнен ли на ней хоть один оператор.
 * Отсюда берётся и список непокрытых строк, и их общее число.
 */
function lineCoverage(statementMap: unknown, hits: unknown): Map<number, boolean> {
  const lines = new Map<number, boolean>();
  if (typeof statementMap !== 'object' || statementMap === null) return lines;
  const counts = typeof hits === 'object' && hits !== null ? (hits as Record<string, unknown>) : {};

  for (const [key, statement] of Object.entries(statementMap as Record<string, unknown>)) {
    const line = startLine(statement);
    if (line === null) continue;
    const executed = (toNumber(counts[key]) ?? 0) > 0;
    lines.set(line, (lines.get(line) ?? false) || executed);
  }
  return lines;
}

/** Итог по ветвям файла: сколько всего дуг и сколько ветвей пройдено наполовину. */
function branchCoverage(branchMap: unknown, counts: unknown): { branches: number; partialLines: number[] } {
  if (typeof branchMap !== 'object' || branchMap === null) return { branches: 0, partialLines: [] };
  const executed = typeof counts === 'object' && counts !== null ? (counts as Record<string, unknown>) : {};
  const partial = new Set<number>();
  let branches = 0;

  for (const [key, branch] of Object.entries(branchMap as Record<string, unknown>)) {
    const arms = executed[key];
    if (!Array.isArray(arms)) continue;
    branches += arms.length;
    const taken = arms.filter((arm) => (toNumber(arm) ?? 0) > 0).length;
    // Наполовину — часть дуг исполнена, часть нет. Все или ни одной — не оно.
    if (taken === 0 || taken === arms.length) continue;
    const line =
      typeof branch === 'object' && branch !== null
        ? (toNumber((branch as { line?: unknown }).line) ?? startLine((branch as { loc?: unknown }).loc))
        : null;
    if (line !== null && line >= 1) partial.add(Math.floor(line));
  }
  return { branches, partialLines: [...partial].sort((a, b) => a - b) };
}

/**
 * Разобрать `coverage-final.json` (istanbul). Файлы без операторов пропускаем:
 * считать в них нечего, и в списке они были бы шумом.
 */
export function parseNodeCoverage(text: string): NodeCoverageReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { files: [], total: null };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { files: [], total: null };

  const files: NodeCoverageFile[] = [];
  let covered = 0;
  let total = 0;

  for (const [path, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const file = entry as Record<string, unknown>;
    const lines = lineCoverage(file.statementMap, file.s);
    if (lines.size === 0) continue;

    const missingLines = [...lines]
      .filter(([, hit]) => !hit)
      .map(([line]) => line)
      .sort((a, b) => a - b);
    const { branches, partialLines } = branchCoverage(file.branchMap, file.b);
    const statements = lines.size;
    const missing = missingLines.length;
    covered += statements - missing;
    total += statements;

    files.push({
      path,
      percent: Math.round(((statements - missing) / statements) * 100),
      statements,
      missing,
      missingLines,
      branches,
      branchPartial: partialLines.length,
      partialLines,
    });
  }

  // Сначала самое проблемное: по числу непокрытых строк, затем по проценту.
  files.sort((a, b) => b.missing - a.missing || a.percent - b.percent || a.path.localeCompare(b.path));
  return { files, total: total > 0 ? Math.round((covered / total) * 100) : null };
}
