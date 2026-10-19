import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { INDEX_FORMAT, sanitizeIndexPayload, type IndexedFile } from '../../shared/symbol-index';

/**
 * Карта символов на диске: переживает и перезапуск IDE, и перезапуск языкового сервера.
 *
 * Смысл ровно тот же, что у кэша стубов в больших IDE: разбор проекта — самая дорогая
 * часть работы, и повторять его на каждом старте незачем. Файл один на проект (корень
 * — ключ), внутри — объявления по файлам вместе с отпечатком содержимого (размер и
 * время изменения). Свежесть решает не эта запись, а сборщик: он сверяет отпечаток
 * с диском и разбирает только изменившееся.
 *
 * Каталог приходит снаружи (в приложении — `userData`), поэтому проверки обходятся
 * временной папкой, без Electron.
 */

/** Имя файла кэша для корня: читаемое имя проекта плюс хеш пути — пути бывают одинаковые. */
export function indexFilePath(dir: string, root: string): string {
  const resolved = path.resolve(root);
  const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 16);
  const name =
    path
      .basename(resolved)
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 40) || 'project';
  return path.join(dir, `${name}-${hash}.json`);
}

export class SymbolStore {
  constructor(private readonly dir: string) {}

  /** Файл кэша этого проекта. */
  fileFor(root: string): string {
    return indexFilePath(this.dir, root);
  }

  /**
   * Прочитать карту проекта. Чего нет, что обрезано и что записано прежней версией —
   * всё это пустая карта: пересобрать дешевле, чем починить наполовину прочитанное.
   */
  async load(root: string): Promise<IndexedFile[]> {
    const text = await fs.readFile(this.fileFor(root), 'utf8').catch(() => null);
    if (text === null) return [];
    try {
      return sanitizeIndexPayload(JSON.parse(text));
    } catch {
      return [];
    }
  }

  /**
   * Записать карту. Неудача записи не должна ломать сборку: карта — ускорение, а не
   * источник правды, и без неё всё работает, только медленнее.
   */
  async save(root: string, files: readonly IndexedFile[]): Promise<void> {
    const file = this.fileFor(root);
    const payload = JSON.stringify({ version: INDEX_FORMAT, root: path.resolve(root), files });
    await fs.mkdir(this.dir, { recursive: true }).catch(() => undefined);
    await fs.writeFile(file, payload, 'utf8').catch(() => undefined);
  }
}
