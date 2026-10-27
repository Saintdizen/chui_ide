import type { WorkspaceRoot } from '../workspace-roots';

/* ── Файловая система ───────────────────────────────────────────────────── */

export type EntryKind = 'file' | 'directory' | 'symlink';

/** Вид, на который указывает символическая ссылка: файл это или папка. */
export type SymlinkTarget = 'file' | 'directory';

/** Куда ведёт символическая ссылка и что там лежит. Есть только при `kind === 'symlink'`. */
export interface SymlinkInfo {
  /** Цель ссылки: путь, куда она ведёт (у битой — сам текст ссылки). */
  target: string;
  /** Что лежит по цели: папка или файл. */
  kind: SymlinkTarget;
  /** Цель не найдена — ссылка «битая». */
  broken: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  /** Время последней правки, мс. Нужно сортировке «по времени изменения». */
  mtimeMs: number;
  /**
   * Куда ведёт символическая ссылка и что там лежит. Задано только при
   * `kind === 'symlink'`: по этому видно, раскрывать запись как папку, открывать как
   * файл или не трогать вовсе (битая ссылка). Смысл полей — в `shared/entry-kind.ts`.
   */
  symlink?: SymlinkInfo;
}

export interface FileStat {
  path: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

export interface FileContent {
  text: string;
  mtimeMs: number;
  /** Размер файла в байтах: по нему редактор решает, открывать ли только для чтения. */
  size: number;
  /** Файл большой и открывается только для чтения (см. `shared/large-file.ts`). */
  readOnly: boolean;
}

export interface WorkspaceInfo {
  /** Активный корень области: им отвечают операции без явного пути. */
  root: string;
  name: string;
  /** Записи активного корня. */
  entries: DirEntry[];
  /** Все корни рабочей области: их может быть несколько (см. `shared/workspace-roots.ts`). */
  roots: WorkspaceRoot[];
}

export interface SearchOptions {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  glob?: string;
  /** Искать только внутри этой папки (или файла). Без неё — по всему проекту. */
  path?: string;
  /** Только имена файлов с совпадением, без строк — обзор «где это встречается». */
  filesOnly?: boolean;
  /**
   * Строк контекста вокруг совпадения — как `-A`/`-B` у grep. 0 или не задано —
   * только строка совпадения. С контекстом навигация не требует отдельного
   * `read_file` и экономит шаг агента.
   */
  context?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  /** Строки до совпадения (только при `context` в запросе), ближняя — последняя. */
  before?: string[];
  /** Строки после совпадения (только при `context`), ближняя — первая. */
  after?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  scanned: number;
}

export interface ReplaceFilesOptions {
  query: string;
  replacement: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  /** Маска пути: замена только в подходящих файлах (`**` — любая глубина). */
  glob?: string;
}

export interface ReplaceFilesResult {
  /** Абсолютные пути файлов, в которых что-то заменилось. */
  files: string[];
  /** Сколько вхождений заменено всего. */
  replaced: number;
}
