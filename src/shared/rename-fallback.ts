import type { SearchHit } from './api/fs';
import { nameOf } from './paths';

/** Одно место, где заменить слово. */
export interface RenameEdit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly from: string;
  readonly to: string;
}

/** Все правки для одного файла. */
export interface RenameFile {
  readonly path: string;
  readonly edits: readonly RenameEdit[];
}

/**
 * Что даст переименование без языкового сервера.
 *
 * Правило — совпадение целого слова: `count` не трогает `counter` и `recount`.
 * Это не языковой анализ, и для локальных имён он и не нужен: если слово
 * вокруг точки — обращение к чужому полю, его не трогаем.
 */
export interface RenameFallbackPlan {
  readonly files: readonly RenameFile[];
  /** Сколько вхождений за рамками имён файлов: для сообщения. */
  readonly total: number;
  /** Почему слово не годится для переименования. `null` — годится. */
  readonly refused: string | null;
}

const WORD = /^[A-Za-z_$][\w$]*$/;

/** Предел совпадений: больше — переименование не ручное действие, а замена по проекту. */
export const RENAME_MAX_HITS = 200;

/** Годится ли слово: идентификатор, а не `count++` и не пустота. */
export function renameRefusal(word: string): string | null {
  if (word === '') return 'Нечего переименовывать: слово не выделено.';
  if (!WORD.test(word)) return `«${word}» — не имя: переименовать можно только идентификатор.`;
  return null;
}

/**
 * Границы совпадения целым словом. Подсвеченное слово уже знаем, ищем его же
 * в тексте строки — позиции берём из поиска, а не считаем заново.
 */
function wholeWordAt(line: string, column: number, word: string): boolean {
  // `column` у поиска считается с единицы, индекс строки — с нуля.
  const at = column - 1;
  if (line.slice(at, at + word.length) !== word) return false;
  const before = line[at - 1] ?? '';
  const after = line[at + word.length] ?? '';
  return !/[\w$]/.test(before) && !/[\w$]/.test(after);
}

/**
 * План переименования по совпадениям поиска. `hits` — то, что вернул
 * `workspace.search` по слову; результат — правки и сколько вхождений не взято.
 *
 * Файлы, чьё ИМЯ содержит слово, меняются отдельно: такой файл переименовывается
 * целиком, а не строка в нём. Об этом говорит `renameFiles`.
 */
export function planRename(word: string, to: string, hits: readonly SearchHit[]): RenameFallbackPlan {
  const refused = renameRefusal(word);
  if (refused !== null) return { files: [], total: 0, refused };
  if (renameRefusal(to) !== null) return { files: [], total: 0, refused: 'Новое имя не годится: нужен идентификатор.' };

    if (hits.length > RENAME_MAX_HITS) {
    return { files: [], total: 0, refused: `Слово встречается больше ${RENAME_MAX_HITS} раз — это уже замена по проекту, а не переименование.` };
  }

  const byFile = new Map<string, RenameEdit[]>();
  let total = 0;
  for (const hit of hits) {
    // Совпадение внутри слова — не вхождение: `count` в `counter` не переименовываем.
    if (!wholeWordAt(hit.text, hit.column, word)) continue;
    const list = byFile.get(hit.path) ?? [];
    list.push({ path: hit.path, line: hit.line, column: hit.column, from: word, to });
    byFile.set(hit.path, list);
    total += 1;
  }

  const files = [...byFile].map(([path, list]) => ({ path, edits: list }));
  return { files, total, refused: null };
}

/** Файлы, которые надо переименовать на диске: в их имени есть слово. */
export function renameFiles(paths: readonly string[], word: string, to: string): { from: string; to: string }[] {
  const result: { from: string; to: string }[] = [];
  for (const path of paths) {
    const name = nameOf(path);
    if (!name.includes(word)) continue;
    // Меняем только в имени, хвост пути остаётся: папки не трогаем.
    const renamed = name.split(word).join(to);
    if (renamed !== name) result.push({ from: path, to: path.slice(0, path.length - name.length) + renamed });
  }
  return result;
}
