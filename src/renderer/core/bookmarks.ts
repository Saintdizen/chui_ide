import {
  bookmarkFiles,
  bookmarkLines,
  clearBookmarksIn,
  isBookmarked,
  nextBookmark,
  removeBookmark,
  sanitizeBookmarks,
  toggleBookmark,
  type BookmarkRecord,
} from '../../shared/bookmarks';
import { Emitter } from './events';

/**
 * Закладки проекта: строки файлов, к которым хочется вернуться.
 *
 * Список правится чистыми функциями (`shared/bookmarks.ts`), а живёт здесь — чтобы
 * у него был один владелец и одно событие на изменение. Редактор значки только
 * рисует (`setBookmarks`), сессия проекта сохраняет список целиком; сама модель
 * ни про то, ни про другое не знает.
 */
export class BookmarkModel {
  private items: BookmarkRecord[] = [];

  private readonly emitter = new Emitter<readonly BookmarkRecord[]>();
  readonly onDidChange = this.emitter.event;

  /** Все закладки в каноническом порядке (файл, строка). */
  get all(): readonly BookmarkRecord[] {
    return this.items;
  }

  count(): number {
    return this.items.length;
  }

  /** Строки закладок файла — их отдаём редактору для значков. */
  linesOf(path: string): number[] {
    return bookmarkLines(this.items, path);
  }

  /** Файлы с закладками: по ним редактору и нужно перерисовать значки. */
  files(): string[] {
    return bookmarkFiles(this.items);
  }

  isBookmarked(path: string, line: number): boolean {
    return isBookmarked(this.items, path, line);
  }

  /** Поставить или снять закладку. `true` — закладка теперь стоит. */
  toggle(path: string, line: number): boolean {
    const had = this.isBookmarked(path, line);
    this.apply(toggleBookmark(this.items, path, line));
    return !had;
  }

  remove(path: string, line: number): void {
    this.apply(removeBookmark(this.items, path, line));
  }

  /** Убрать все закладки файла. */
  clearFile(path: string): void {
    this.apply(clearBookmarksIn(this.items, path));
  }

  /** Следующая или предыдущая закладка от позиции. `null` — закладок нет. */
  next(from: BookmarkRecord, direction: 1 | -1): BookmarkRecord | null {
    return nextBookmark(this.items, from, direction);
  }

  /** Закладки в виде записей сессии. */
  records(): BookmarkRecord[] {
    return [...this.items];
  }

  /** Восстановить список из сессии проекта (записи проверяются). */
  restore(records: unknown): void {
    this.items = sanitizeBookmarks(records);
    this.emitter.fire(this.items);
  }

  private apply(next: readonly BookmarkRecord[]): void {
    // Правка может ничего не изменить (снятие несуществующей закладки) — тогда и
    // события нет: лишняя перерисовка значков никому не нужна.
    if (
      next.length === this.items.length &&
      next.every((item, index) => item.path === this.items[index]!.path && item.line === this.items[index]!.line)
    ) {
      return;
    }
    this.items = [...next];
    this.emitter.fire(this.items);
  }
}
