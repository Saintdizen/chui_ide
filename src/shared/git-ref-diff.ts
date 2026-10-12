/**
 * Разбор вывода git при сравнении двух ссылок (веток, коммитов, тегов).
 *
 * `git diff --name-status` говорит, ЧТО изменилось, `--numstat` — насколько
 * (сколько добавлено и удалено строк). Обе команды печатают по записи на файл,
 * и вместе они дают список изменённых файлов со сводкой — то, что показывает
 * экран «сравнить ветки». Разбор тут, а не в main: это чистая работа с текстом,
 * её видно в тестах без git.
 *
 * Обе команды запускаются с `-z`: имена файлов тогда разделяются нулевым байтом,
 * а не переводом строки, и пути со спецсимволами (пробел, кириллица, перевод строки
 * в имени) не ломают разбор. С `core.quotepath=false` git печатает их как есть.
 */

import type { GitChange } from './api';

/** Один изменённый файл в сравнении ссылок. */
export interface GitRefDiffFile {
  /** Путь от корня репозитория. */
  path: string;
  change: GitChange;
  /** Добавлено строк (у двоичного файла — null: git не считает строки). */
  additions: number | null;
  /** Удалено строк. */
  deletions: number | null;
}

/** Итог сравнения двух ссылок: список изменённых файлов. */
export interface GitRefDiff {
  /** С чем сравниваем (левая сторона). */
  base: string;
  /** Что сравниваем (правая сторона). */
  head: string;
  files: GitRefDiffFile[];
}

/** Буква статуса git → наше слово. `C` (копия) и `R` (переименование) — оба «renamed». */
function changeOf(code: string): GitChange {
  const letter = code.charAt(0).toUpperCase();
  if (letter === 'A') return 'added';
  if (letter === 'D') return 'deleted';
  if (letter === 'R' || letter === 'C') return 'renamed';
  return 'modified';
}

/**
 * Разбор `git diff --name-status -z`. Записи разделены NUL: сначала код статуса,
 * затем путь. У переименования (R) и копии (C) путей ДВА — старый и новый;
 * нам нужен новый: именно он существует в правой стороне.
 */
export function parseNameStatus(stdout: string): Map<string, GitChange> {
  const tokens = stdout.split('\u0000');
  const result = new Map<string, GitChange>();
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index];
    if (!code) continue;
    const change = changeOf(code);
    const twoPaths = /^[RC]/i.test(code);
    const path = tokens[index + (twoPaths ? 2 : 1)];
    if (path === undefined) break;
    index += twoPaths ? 2 : 1;
    if (path) result.set(path, change);
  }
  return result;
}

/**
 * Разбор `git diff --numstat -z`: `добавлено\tудалено\tпуть` (у двоичного файла
 * вместо чисел стоят дефисы). С `-z` у переименования поле пути ПУСТО, а старый и
 * новый пути идут следом двумя отдельными токенами — берём новый (он есть в правой
 * стороне). Поэтому идём по токенам, а не по строкам: запись может занять 2-3 токена.
 */
export function parseNumstat(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
  const tokens = stdout.split('\u0000');
  const result = new Map<string, { additions: number | null; deletions: number | null }>();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) continue;
    const parts = token.split('\t');
    if (parts.length < 3) continue;
    const stats = { additions: numOrNull(parts[0]), deletions: numOrNull(parts[1]) };
    const last = parts[parts.length - 1];
    if (last) {
      result.set(last, stats);
      continue;
    }
    // Поле пути пустое — переименование: старый путь следующим токеном, новый за ним.
    const older = tokens[index];
    const newer = tokens[index + 1];
    index += 2;
    if (newer) result.set(newer, stats);
    else if (older) result.set(older, stats);
  }
  return result;
}

/** Число из поля numstat; дефис (двоичный файл) и мусор — `null`. */
function numOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Свести имя-статус и numstat в один список. Порядок — как у `--name-status`:
 * git печатает файлы отсортированными по пути, и это ожидаемый порядок в списке.
 */
export function mergeRefDiff(stdoutNameStatus: string, stdoutNumstat: string): GitRefDiffFile[] {
  const changes = parseNameStatus(stdoutNameStatus);
  const stats = parseNumstat(stdoutNumstat);
  return [...changes.entries()].map(([path, change]) => ({
    path,
    change,
    additions: stats.get(path)?.additions ?? null,
    deletions: stats.get(path)?.deletions ?? null,
  }));
}
