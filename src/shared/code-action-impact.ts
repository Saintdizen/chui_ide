import type { FileEdit } from './edits';
import { plural } from './run-log';

/**
 * Что действие сделает с файлами — словами и числом, до того как его выбрали.
 *
 * Человек видит «Вынести в переменную» и не видит главного: сколько файлов
 * и строк это тронет. После применения узнавать поздно (отмена есть, но
 * прыжок в другой файл уже внимание сбил), а список правок в подсказке
 * сервера — это позиции с офсетами, читать их глазами бессмысленно.
 */
export interface ActionImpact {
  /** Сколько файлов правка трогает. */
  files: number;
  /** Сколько мест в них меняется. */
  edits: number;
  /** Человеческие имена файлов: минимум — тех, что за пределами текущего. */
  paths: string[];
  /** Сколько мест меняется в том файле, где действие вызвано. */
  inThisFile: number;
  /** Трогает ли правка другие файлы — то, что человек не ждёт от быстрого исправления. */
  elsewhere: boolean;
  /** Готовая строка для пункта меню. Пусто — сказать нечего (правок нет). */
  label: string;
}

/**
 * Разбор правок действия в сводку.
 *
 * `current` — файл, в котором действие вызвано: про него говорим «в этом файле»,
 * а не именем. Прочие всегда называем: именно они — неожиданная часть.
 * Действие без правок (только команда сервера) ничего не знает о своих
 * последствиях — там сводка пустая, а не «0 файлов»: ноль читался бы как «ничего
 * не произойдёт», а произойдёт что угодно.
 */
export function actionImpact(edits: readonly FileEdit[] | null, current?: string): ActionImpact {
  const empty: ActionImpact = { files: 0, edits: 0, paths: [], inThisFile: 0, elsewhere: false, label: '' };
  if (!edits || edits.length === 0) return empty;

  let count = 0;
  let inThisFile = 0;
  const paths: string[] = [];
  for (const file of edits) {
    if (file.edits.length === 0) continue;
    count += file.edits.length;
    if (current !== undefined && file.path === current) {
      inThisFile += file.edits.length;
      continue;
    }
    paths.push(file.path);
  }
  if (count === 0) return empty;

  const files = paths.length + (inThisFile > 0 ? 1 : 0);
  return {
    files,
    edits: count,
    paths,
    inThisFile,
    elsewhere: paths.length > 0,
    label: impactLabel(files, count, paths, inThisFile > 0),
  };
}

/**
 * Строка сводки: «в этом файле, 1 место» / «3 файла, 12 мест: a.ts, b.ts, c.ts».
 *
 * Имена вперёд чисел для чужого: по имени человек сразу решает, трогать ли.
 * Хвост списка срезается — в подсказке меню больше двух-трёх имён не читается.
 */
function impactLabel(files: number, edits: number, paths: string[], touchesCurrent: boolean): string {
  const places = `${edits} ${plural(edits, 'место', 'места', 'мест')}`;
  if (files === 1 && touchesCurrent) return `в этом файле, ${places}`;

  const name = `${files} ${plural(files, 'файл', 'файла', 'файлов')}`;
  const shown = paths.slice(0, 3).map(baseName);
  const more = paths.length - shown.length;
  const tail = more > 0 ? `, ещё ${more}` : '';
  const names = shown.length > 0 ? `: ${shown.join(', ')}${tail}` : '';
  return `${name}, ${places}${names}`;
}

/** Имя файла без папок: путь целиком не влезает в пункт меню. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}
