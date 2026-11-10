import { isInsidePath } from './paths';

/**
 * Заметки человека к файлу и к проекту.
 *
 * Зачем не в коде: «здесь гонка, переписать после релиза» — не комментарий для
 * будущих читателей (они её не увидят — она в чужом интерфейсе), а память для
 * себя. Поэтому отдельно от файла и от git: правка кода не должна стирать
 * заметку, а чужая ветка — приносить её с собой.
 *
 * Живёт в сессии проекта рядом с закреплёнными и метками: у каждого проекта
 * свои. Заметка к проекту — одна на всё дерево; к файлу — не больше одной
 * (вторая превратила бы «что тут важно» в дневник).
 */

/** Заметка к файлу: путь от корня проекта и текст. */
export interface FileNote {
  /** Путь от корня проекта, с `/` — как в дереве. */
  readonly path: string;
  readonly text: string;
  /** Когда написали: в списке видно, что старое, а что свежее. */
  readonly at: number;
}

/** Всё хранимое: заметки к файлам и одна к проекту. */
export interface NotesState {
  readonly files: readonly FileNote[];
  /** Заметка к проекту целиком; `null` — нет. */
  readonly project: string | null;
}

export const EMPTY_NOTES: NotesState = { files: [], project: null };

/** Предел текста: заметка — мысль, а не документ. */
export const MAX_NOTE_CHARS = 2000;

/**
 * Путь заметки в вид дерева: от корня проекта, без ведущего слеша, с `/`.
 * Заметка на файл вне проекта — не наша: после смены проекта такие пути
 * указывали бы в чужое место.
 */
export function normalizeNotePath(path: string, root: string | null): string | null {
  if (root === null) return null;
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (clean === root.replace(/\\/g, '/')) return '';
  if (!isInsidePath(root, clean)) return null;
  const rootClean = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return clean.slice(rootClean.length).replace(/^\/+/, '');
}

/**
 * Записи из сессии: мусор выбрасываем, дубли путей схлопываем.
 *
 * Молча: это файл сессии, а не документ. Одна испорченная запись не должна
 * стирать остальные заметки — их человек писал руками.
 */
export function sanitizeNotes(records: unknown, root: string | null): NotesState {
  if (typeof records !== 'object' || records === null) return EMPTY_NOTES;
  const raw = records as { files?: unknown; project?: unknown };

  const files: FileNote[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.files)) {
    for (const entry of raw.files) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { path, text, at } = entry as { path?: unknown; text?: unknown; at?: unknown };
      if (typeof path !== 'string' || typeof text !== 'string') continue;
      const normalized = normalizeNotePath(path, root);
      // Пустая заметка — то же, что нет: чип без текста нечего показать.
      const body = text.trim();
      if (normalized === null || normalized === '' || body.length === 0) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      files.push({
        path: normalized,
        text: body.slice(0, MAX_NOTE_CHARS),
        at: typeof at === 'number' && Number.isFinite(at) ? at : Date.now(),
      });
    }
  }

  // Порядок — по пути: список открывается целиком, и постоянный порядок
  // важнее «свежие сверху» (иначе прыгает, пока пишут).
  files.sort((left, right) => left.path.localeCompare(right.path));
  const project =
    typeof raw.project === 'string' && raw.project.trim().length > 0
      ? raw.project.trim().slice(0, MAX_NOTE_CHARS)
      : null;
  return { files, project };
}

/** Заметка к файлу или `null`. */
export function noteOf(notes: NotesState, path: string, root: string | null = null): FileNote | null {
  const stored = root === null ? path : (normalizeNotePath(path, root) ?? path);
  return notes.files.find((entry) => entry.path === stored) ?? null;
}

/**
 * Поставить или снять заметку к файлу. Пустой текст — снять: человек стёр
 * текст, значит заметки больше нет, а не «пустая заметка».
 */
export function setFileNote(
  notes: NotesState,
  path: string,
  text: string,
  at: number = Date.now(),
  root: string | null = null,
): NotesState {
  // Путь храним ОТ КОРНЯ проекта, как и при чтении из сессии: иначе запись и
  // разбор говорили бы на разных языках — поставленная заметка не находилась
  // бы после перезапуска, а абсолютный путь умирал бы при переносе папки.
  const stored = root === null ? path : (normalizeNotePath(path, root) ?? path);
  const body = text.trim().slice(0, MAX_NOTE_CHARS);
  const rest = notes.files.filter((entry) => entry.path !== stored);
  if (body.length === 0) return { ...notes, files: rest };
  const next = [...rest, { path: stored, text: body, at }].sort((left, right) => left.path.localeCompare(right.path));
  return { ...notes, files: next };
}

/** Поставить (или снять, пустой строкой) заметку к проекту. */
export function setProjectNote(notes: NotesState, text: string): NotesState {
  const body = text.trim().slice(0, MAX_NOTE_CHARS);
  return { ...notes, project: body.length === 0 ? null : body };
}

/**
 * Сколько заметок у файлов внутри папки — для подсказки на папке.
 *
 * Границей считаем `/`: заметка на `src/a` относится к папке `src`, а на
 * `srcx/a` — нет. Сравнение подстрокой нашло бы обе.
 */
export function notesInFolder(notes: NotesState, folder: string): number {
  const prefix = folder.replace(/\/+$/, '');
  if (prefix.length === 0) return notes.files.length;
  return notes.files.filter((entry) => entry.path.startsWith(`${prefix}/`)).length;
}
