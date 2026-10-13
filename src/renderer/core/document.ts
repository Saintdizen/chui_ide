import { applyTextEdits, type TextEdit } from '../../shared/edits';
import { Emitter, type Disposable } from './events';

/**
 * Откуда пришло изменение. Источник важен: правки с диска и от ассистента
 * применяются программно (и попадают в общий undo редактора), а ввод пользователя
 * приходит снизу, из буфера редактора.
 */
export type EditSource = 'user' | 'programmatic' | 'disk';

export interface DocumentChange {
  source: EditSource;
  version: number;
}

let documentSequence = 0;

/**
 * Документ — источник истины о тексте файла. Он не знает про редактор:
 * тот подключается сбоку (см. editor-api.ts), поэтому тем же
 * документом сможет пользоваться ассистент, даже если файл не открыт.
 */
export class TextDocument {
  readonly id = `doc-${(documentSequence += 1)}`;
  readonly uri: string;

  private readonly changes = new Emitter<DocumentChange>();
  /**
   * Смена «грязности» без смены текста: файл записан или возвращён к версии с
   * диска. Отдельное событие потому, что текст при этом не меняется, а UI о
   * пометке «не сохранён» знает именно по ней.
   */
  private readonly saved = new Emitter<DocumentChange>();
  private readonly _onDidChange: (listener: (change: DocumentChange) => void) => Disposable;
  private readonly _onDidChangeSaved: (listener: () => void) => Disposable;

  private text: string;
  private currentVersion = 1;
  private savedVersion = 1;
  private diskMtimeMs = 0;

  constructor(
    readonly path: string,
    initialText: string,
    public languageId: string,
    /** Файл открыт только для чтения: он слишком большой, чтобы его править. */
    readonly readOnly: boolean = false,
  ) {
    this.uri = pathToUri(path);
    this.text = normalize(initialText);
    this._onDidChange = this.changes.event;
    this._onDidChangeSaved = this.saved.event;
  }

  get onDidChange(): (listener: (change: DocumentChange) => void) => Disposable {
    return this._onDidChange;
  }

  /**
   * Буфер снова совпал с диском: «не сохранён» снят. Слушают те, кто эту пометку
   * рисует (полоса вкладок, дерево) — без подписки она гасла бы только на слух
   * наблюдателя за файлом, а на сети или ФС без событий не гасла бы вовсе.
   */
  get onDidChangeSaved(): (listener: () => void) => Disposable {
    return this._onDidChangeSaved;
  }

  get value(): string {
    return this.text;
  }

  get version(): number {
    return this.currentVersion;
  }

  get dirty(): boolean {
    return this.currentVersion !== this.savedVersion;
  }

  /**
   * Время файла на диске, каким мы его видели в последний раз (READ/WRITE).
   * `0` — ещё не знаем: документ открыт до появления этой отметки или файла нет.
   * По нему при сохранении видно, изменил ли файл кто-то снаружи.
   */
  get diskMtime(): number {
    return this.diskMtimeMs;
  }

  get lineCount(): number {
    let count = 1;
    for (let i = 0; i < this.text.length; i += 1) {
      if (this.text.charCodeAt(i) === 10) count += 1;
    }
    return count;
  }

  lineAt(line: number): string {
    const lines = this.text.split('\n');
    return lines[line - 1] ?? '';
  }

  setText(next: string, source: EditSource): boolean {
    const normalized = normalize(next);
    if (normalized === this.text) return false;
    this.text = normalized;
    this.bump(source);
    return true;
  }

  /** Применяет правки и возвращает их количество. */
  applyEdits(edits: readonly TextEdit[], source: EditSource): number {
    if (edits.length === 0) return 0;
    const next = applyTextEdits(this.text, edits);
    if (next === this.text) return 0;
    this.text = next;
    this.bump(source);
    return edits.length;
  }

  /** Отмечает, что содержимое совпадает с диском. `mtimeMs` — время той записи. */
  markSaved(mtimeMs: number = this.diskMtimeMs): void {
    const wasDirty = this.dirty;
    this.savedVersion = this.currentVersion;
    this.diskMtimeMs = mtimeMs;
    // Событие — только когда пометка действительно снята: `markSaved` зовут и на
    // каждом перечитывании чистого документа, дёргать интерфейс там незачем.
    if (wasDirty) this.saved.fire({ source: 'disk', version: this.currentVersion });
  }

  /** Запомнить состояние диска без сброса «грязности» — при чтении файла. */
  markDisk(mtimeMs: number): void {
    this.diskMtimeMs = mtimeMs;
  }

  private bump(source: EditSource): void {
    this.currentVersion += 1;
    this.changes.fire({ source, version: this.currentVersion });
  }
}

/** Одна модель документа — один формат переводов строк. */
export function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Разошёлся ли файл на диске с тем, что мы читали или писали.
 *
 * `knownMtime` — время нашей последней записи/чтения (`0` — ещё не знаем, тогда
 * не мешаем: ругаться на всякое сохранение хуже, чем пропустить редкий случай).
 * `diskMtime` — фактическое время файла сейчас (`null` — файла нет или stat не
 * удался). Признак нужен, чтобы не записать буфер поверх чужой правки молча.
 */
export function diskConflict(knownMtime: number, diskMtime: number | null): boolean {
  return knownMtime > 0 && diskMtime !== null && diskMtime !== knownMtime;
}

export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/**
 * Путь файла из `file://`-ссылки — в той же форме, что `TextDocument.path`.
 *
 * На Windows Monaco отдаёт `/C:/…`, а документы ключуются как `C:\…`: без снятия
 * ведущего слэша и возврата родных разделителей LSP и быстрые правки не находят
 * открытый документ — сравнение идёт по строке (`document.path`).
 */
export function uriToPath(uri: string): string {
  let path = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return /^[A-Za-z]:/.test(path) ? path.replace(/\//g, '\\') : path;
}
