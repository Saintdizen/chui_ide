import { applyTextEdits, type TextEdit } from '../../shared/edits';
import { Emitter, type Disposable } from './events';

/**
 * Откуда пришло изменение. Источник важен: правки с диска и от ассистента
 * применяются программно (и попадают в undo-стек Monaco), а ввод пользователя
 * приходит снизу, из модели Monaco.
 */
export type EditSource = 'user' | 'programmatic' | 'disk';

export interface DocumentChange {
  source: EditSource;
  version: number;
}

let documentSequence = 0;

/**
 * Документ — источник истины о тексте файла. Он не знает про Monaco:
 * редактор подключается сбоку (см. editor-service.ts), поэтому тем же
 * документом сможет пользоваться ассистент, даже если файл не открыт.
 */
export class TextDocument {
  readonly id = `doc-${(documentSequence += 1)}`;
  readonly uri: string;

  private readonly changes = new Emitter<DocumentChange>();
  private readonly _onDidChange: (listener: (change: DocumentChange) => void) => Disposable;

  private text: string;
  private currentVersion = 1;
  private savedVersion = 1;

  constructor(
    readonly path: string,
    initialText: string,
    public languageId: string,
  ) {
    this.uri = pathToUri(path);
    this.text = normalize(initialText);
    this._onDidChange = this.changes.event;
  }

  get onDidChange(): (listener: (change: DocumentChange) => void) => Disposable {
    return this._onDidChange;
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

  markSaved(): void {
    this.savedVersion = this.currentVersion;
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
