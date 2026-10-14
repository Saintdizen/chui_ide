/**
 * Профилировщик строк: разбор отчёта нашей обёртки и правила «жара» строки.
 *
 * Отчёт даёт обёртка на stdlib (`main/python/line-profile.ts`): по каждой исполненной
 * строке — сколько раз она исполнилась и сколько времени на ней прошло. Здесь только
 * разбор этого отчёта и правила, по которым строка считается «горячей»: их видно
 * юнит-тестами, а окно только красит строки по готовому уровню.
 *
 * Проценты считаются от ОБЩЕГО времени профиля (сумма по всем строкам), а не от
 * времени программы: строка, съевшая половину профиля, — и есть то, что ищут, и её
 * доля не должна зависеть от того, сколько времени ушло на запуск интерпретатора.
 *
 * Модуль чистый: ни диска, ни DOM, ни процессов.
 */

/** Строка профиля: номер, сколько раз исполнилась, время и доля от общего. */
export interface ProfileLine {
  /** Номер строки (1-based). */
  line: number;
  /** Сколько раз строка исполнилась. */
  hits: number;
  /** Время на строке в наносекундах. */
  timeNs: number;
  /** Доля от общего времени профиля, в процентах. */
  percent: number;
}

/** Профиль одного файла. */
export interface ProfileFile {
  path: string;
  lines: ProfileLine[];
  /** Суммарное время файла — по нему файлы и сортируются. */
  timeNs: number;
}

/** Разобранный профиль: строки по файлам и сводка прогона. */
export interface LineProfile {
  files: ProfileFile[];
  /** Общее время профиля (сумма по строкам) — база для процентов. */
  timeNs: number;
  /** Сколько занял сам прогон (включая запуск) — для подписи. */
  elapsedNs: number;
  /** Код выхода программы; не ноль — программа упала. */
  exitCode: number;
  /** Текст ошибки программы, если она упала. */
  error: string | null;
}

/** Пороги «жара» строки в процентах: строка горячее — уровень выше. */
export const HEAT_THRESHOLDS = { hot: 20, warm: 5, cool: 1 } as const;

/**
 * Уровень подсветки строки: 0 — не подсвечиваем (вклад в шум), 1..3 — от «тёплой» к
 * «горячей». Строку, съевшую доли процента, красить незачем: подсветка на всё —
 * это отсутствие подсветки.
 */
export function heatLevel(percent: number): 0 | 1 | 2 | 3 {
  if (percent >= HEAT_THRESHOLDS.hot) return 3;
  if (percent >= HEAT_THRESHOLDS.warm) return 2;
  if (percent >= HEAT_THRESHOLDS.cool) return 1;
  return 0;
}

/** Пустой профиль: отчёт не пришёл или разобрать не удалось. */
export function emptyProfile(message: string | null = null): LineProfile {
  return { files: [], timeNs: 0, elapsedNs: 0, exitCode: 0, error: message };
}

/** Число из значения неизвестного типа (строку тоже принимаем). */
function toNumber(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(num) ? num : null;
}

/**
 * Разобрать отчёт обёртки. Битый JSON, чужой формат и пустой отчёт дают пустой профиль:
 * это файл, который мог остаться от другого прогона, а не данные, на которых стоит падать.
 */
export function parseLineProfile(text: string): LineProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyProfile('Отчёт профилировщика не читается: это не JSON.');
  }
  if (typeof raw !== 'object' || raw === null) return emptyProfile('Отчёт профилировщика пуст.');
  const value = raw as { files?: unknown; elapsedNs?: unknown; exitCode?: unknown; error?: unknown };
  const source = value.files;
  if (typeof source !== 'object' || source === null) return emptyProfile('В отчёте нет строк профиля.');

  // Сначала собираем «сырые» строки, чтобы посчитать их суммарное время: без него
  // проценты не с чем сравнивать.
  const rawFiles: { path: string; rows: [number, number, number][] }[] = [];
  let total = 0;
  for (const [path, rows] of Object.entries(source as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const parsed: [number, number, number][] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const line = toNumber(row[0]);
      const hits = toNumber(row[1]);
      const timeNs = toNumber(row[2]);
      if (line === null || hits === null || timeNs === null || line < 1) continue;
      parsed.push([Math.floor(line), Math.max(0, Math.floor(hits)), Math.max(0, Math.round(timeNs))]);
      total += Math.max(0, timeNs);
    }
    if (parsed.length > 0) rawFiles.push({ path, rows: parsed });
  }

  const elapsedNs = toNumber(value.elapsedNs) ?? 0;
  const exitCode = toNumber(value.exitCode) ?? 0;

  if (rawFiles.length === 0) {
    return {
      files: [],
      timeNs: 0,
      elapsedNs: Math.max(0, Math.round(elapsedNs)),
      exitCode: Math.max(0, Math.floor(exitCode)),
      error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
    };
  }

  const files: ProfileFile[] = rawFiles.map((file) => {
    const lines: ProfileLine[] = file.rows
      .map(([line, hits, timeNs]) => ({
        line,
        hits,
        timeNs,
        percent: total > 0 ? (timeNs / total) * 100 : 0,
      }))
      .sort((a, b) => a.line - b.line);
    return {
      path: file.path,
      lines,
      timeNs: lines.reduce((sum, item) => sum + item.timeNs, 0),
    };
  });
  // Файлы — от «съевших больше всех» к остальным: так видно главное без прокрутки.
  files.sort((a, b) => b.timeNs - a.timeNs);

  return {
    files,
    timeNs: total,
    elapsedNs: Math.max(0, Math.round(elapsedNs)),
    exitCode: Math.max(0, Math.floor(exitCode)),
    error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
  };
}

/** Горячая строка с файлом — для сводки и списка. */
export interface HottestLine {
  path: string;
  line: ProfileLine;
}

/** Самые «дорогие» строки профиля, по убыванию времени. */
export function hottestLines(profile: LineProfile, limit: number): HottestLine[] {
  const all: HottestLine[] = [];
  for (const file of profile.files) for (const line of file.lines) all.push({ path: file.path, line });
  all.sort((a, b) => b.line.timeNs - a.line.timeNs);
  return all.slice(0, Math.max(0, limit));
}

/** Строки файла, которые стоит подсветить: уровень больше нуля. */
export function highlightedLines(file: ProfileFile): { line: number; level: 1 | 2 | 3 }[] {
  const result: { line: number; level: 1 | 2 | 3 }[] = [];
  for (const item of file.lines) {
    const level = heatLevel(item.percent);
    // Явная проверка вместо `> 0`: так тип сужается до 1|2|3 без приведения.
    if (level === 1 || level === 2 || level === 3) result.push({ line: item.line, level });
  }
  return result;
}

/** Длительность человека: «1.2 с», «287 мс», «1.4 мкс». */
export function formatDuration(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} с`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(1)} мс`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(1)} мкс`;
  return `${Math.round(ns)} нс`;
}

/** Короткая подпись прогона: «Профиль: 12.4 мс, горячих строк: 3». */
export function profileSummary(profile: LineProfile): string {
  if (profile.files.length === 0) return 'Профиль пуст: строки не исполнялись.';
  let hot = 0;
  for (const file of profile.files) for (const line of file.lines) if (heatLevel(line.percent) > 0) hot += 1;
  const files = profile.files.length;
  return `Профиль: ${formatDuration(profile.timeNs)} · файлов: ${files} · горячих строк: ${hot}`;
}
