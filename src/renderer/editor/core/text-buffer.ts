/**
 * Документ редактора: текст плюс индекс строк.
 *
 * Модель текста — таблица кусков (`piece-table.ts`), она берёт на себя быстрые
 * правки. Индекс строк — то, что редактору нужно каждый кадр: по смещению курсора
 * получить «строка и столбец», по строке — её текст, по числу строк — высоту
 * полотна. Пересчитывать такое делением текста на строки на каждое движение курсора
 * нельзя: это O(размера файла) на кадр.
 *
 * Поэтому начала строк живут отдельным массивом смещений, и правка правит его
 * точечно: меняются только строки, которых коснулась правка. Строки до правки и
 * после неё лишь сдвигаются на разницу длин — их пересчитывать не нужно.
 *
 * Строка тут — то же, что в любом редакторе: разрыв строки одна (`\n`, `\r` или
 * `\r\n`), а текст, кончающийся разрывом, имеет ещё одну пустую строку после него.
 * Поэтому у файла `"a\n"` две строки, а у пустого файла — одна.
 *
 * Версия (`version`) растёт на каждую правку: по ней представление отбрасывает свои
 * кэши (разбивку на токены, ширины строк), не сравнивая текст построчно.
 */

import { PieceTable } from './piece-table';

/** Позиция в документе. И строка, и столбец считаются с единицы — как их видит человек. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Начала строк: `starts[i]` — смещение начала строки с номером `i` (нумерация с 0 внутри). */
function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) starts.push(index + 1);
    else if (code === 13) {
      // `\r\n` — один разрыв: границу даст следующий `\n`, здесь пропускаем.
      if (text.charCodeAt(index + 1) === 10) continue;
      starts.push(index + 1);
    }
  }
  return starts;
}

export class TextBuffer {
  private readonly table: PieceTable;
  private starts: number[];
  private revision = 1;

  constructor(text = '') {
    this.table = new PieceTable(text);
    this.starts = computeLineStarts(text);
  }

  /** Длина в единицах UTF-16. */
  get length(): number {
    return this.table.length;
  }

  /** Растёт на каждую правку: по этому числу кэши представления понимают, что устарели. */
  get version(): number {
    return this.revision;
  }

  /** Число строк. У пустого документа — одна (пустая). */
  get lineCount(): number {
    return this.starts.length;
  }

  /** Начала всех строк. Отдаём как есть, только для чтения: их читает представление. */
  get lineStarts(): readonly number[] {
    return this.starts;
  }

  /** Весь текст. Нужен для сохранения и передачи по сети, не для отрисовки. */
  get text(): string {
    return this.table.toString();
  }

  /** Участок текста `[start, end)`. */
  getText(start = 0, end: number = this.table.length): string {
    return this.table.getText(start, end);
  }

  /** Текст строки по её номеру (с единицы), без разрыва строки на конце. */
  lineText(line: number): string {
    const index = this.clampLine(line) - 1;
    return this.table.getText(this.starts[index], this.lineEndOffset(index));
  }

  /** Смещение начала строки (номер с единицы). */
  lineStart(line: number): number {
    return this.starts[this.clampLine(line) - 1];
  }

  /** Номер строки (с единицы) для смещения. */
  lineAt(offset: number): number {
    return this.lineIndexAt(Math.max(0, Math.min(offset, this.table.length))) + 1;
  }

  /** Позиция (строка и столбец, оба с единицы) для смещения. */
  positionAt(offset: number): Position {
    const at = Math.max(0, Math.min(offset, this.table.length));
    const index = this.lineIndexAt(at);
    return { line: index + 1, column: at - this.starts[index] + 1 };
  }

  /** Смещение для позиции. Столбец за концом строки прижимается к её концу — так же, как при клике мимо текста. */
  offsetAt(position: Position): number {
    const index = this.clampLine(position.line) - 1;
    const start = this.starts[index];
    const end = this.lineEndOffset(index);
    const offset = start + Math.max(0, position.column - 1);
    return Math.max(start, Math.min(offset, end));
  }

  /** Вставить текст в смещение; возвращает длину вставки (она же сдвиг всего после правки). */
  insert(offset: number, text: string): number {
    if (text.length === 0) return 0;
    const at = this.clampOffset(offset);
    this.table.insert(at, text);
    this.refreshLines(at, '', text);
    this.revision += 1;
    return text.length;
  }

  /** Удалить участок. Возвращает удалённый текст — он нужен истории правок. */
  delete(offset: number, length: number): string {
    if (length <= 0) return '';
    const at = this.clampOffset(offset);
    const removed = this.table.delete(at, length);
    if (removed.length > 0) {
      this.refreshLines(at, removed, '');
      this.revision += 1;
    }
    return removed;
  }

  /** Заменить участок текстом. Возвращает то, что было на его месте. */
  replace(offset: number, length: number, text: string): string {
    const at = this.clampOffset(offset);
    const removed = this.table.delete(at, length);
    if (text.length > 0) this.table.insert(at, text);
    if (removed.length > 0 || text.length > 0) {
      this.refreshLines(at, removed, text);
      this.revision += 1;
    }
    return removed;
  }

  /**
   * Пересчитать начала строк после правки: участок `[start, start + removed.length)`
   * заменён на `inserted`. Строки до правки не трогаем, строки после неё сдвигаем
   * на разницу длин — пересборка индекса целиком тут не нужна.
   */
  private refreshLines(start: number, removed: string, inserted: string): void {
    const firstLine = this.lineIndexAt(start);
    const lastLine = this.lineIndexAt(start + removed.length);

    // Новые начала: каждая граница строки внутри вставленного текста.
    const insertedStarts: number[] = [];
    for (let index = 0; index < inserted.length; index += 1) {
      const code = inserted.charCodeAt(index);
      if (code === 10) insertedStarts.push(start + index + 1);
      else if (code === 13) {
        if (inserted.charCodeAt(index + 1) === 10) continue;
        insertedStarts.push(start + index + 1);
      }
    }

    const delta = inserted.length - removed.length;
    const next = this.starts.slice(0, firstLine + 1);
    for (const value of insertedStarts) next.push(value);
    for (let index = lastLine + 1; index < this.starts.length; index += 1) {
      next.push(this.starts[index] + delta);
    }
    this.starts = next;
  }

  /** Смещение конца строки без разрыва строки на конце (перевод строки в текст не входит). */
  private lineEndOffset(index: number): number {
    const next = index + 1 < this.starts.length ? this.starts[index + 1] : this.table.length;
    if (next <= 0) return 0;
    // Разрыв строки — один символ, кроме `\r\n`, где их два.
    const end = this.table.getText(Math.max(0, next - 2), next);
    if (end.endsWith('\r\n')) return next - 2;
    if (end.endsWith('\n') || end.endsWith('\r')) return next - 1;
    return next;
  }

  /** Номер строки (с нуля внутри) для смещения. */
  private lineIndexAt(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle] <= offset) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  private clampLine(line: number): number {
    if (line < 1) return 1;
    if (line > this.starts.length) return this.starts.length;
    return Math.floor(line);
  }

  private clampOffset(offset: number): number {
    if (offset < 0) return 0;
    if (offset > this.table.length) return this.table.length;
    return Math.floor(offset);
  }
}
