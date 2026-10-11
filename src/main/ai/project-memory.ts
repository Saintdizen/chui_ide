import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addNote, removeNotes, sanitizeNotes, type MemoryNote, type RememberResult } from '../../shared/memory';

/**
 * Хранилище памяти проекта: заметки агента, по файлу на рабочую папку.
 *
 * Лежат рядом с беседами (`userData/memory`), а не в проекте: это заметки агента,
 * а не файлы проекта — им нечего делать в чужих репозиториях и в `git status`.
 * Имя файла повторяет имя проекта плюс хеш пути, как у бесед: две одинаково
 * названные папки не затирают память друг друга.
 *
 * Читается память на каждый запрос (её кладём в промпт), поэтому держим кеш на
 * текущий корень: заметок немного, но читать файл из-за одной правки незачем.
 */

export class ProjectMemory {
  private cache: { root: string; notes: MemoryNote[] } | null = null;

  constructor(private readonly dir?: string) {}

  /** Заметки проекта: свежие первыми. Кеш — по текущему корню. */
  async list(root: string | null): Promise<MemoryNote[]> {
    if (!root) return [];
    if (this.cache?.root === root) return this.cache.notes;
    const notes = await this.read(root);
    this.cache = { root, notes };
    return notes;
  }

  /** Записать заметку. Итог несёт причина отказа, её читает агент. */
  async remember(root: string | null, text: string): Promise<RememberResult> {
    if (!root) return { ok: false, reason: 'empty' };
    const notes = await this.list(root);
    const result = addNote(notes, text, Date.now());
    if (result.ok && result.added) await this.write(root, result.notes);
    if (result.ok) this.cache = { root, notes: result.notes };
    return result;
  }

  /** Убрать заметки по подстроке. Возвращает, сколько убрано. */
  async forget(root: string | null, query: string): Promise<{ notes: MemoryNote[]; removed: number }> {
    if (!root) return { notes: [], removed: 0 };
    const notes = await this.list(root);
    const result = removeNotes(notes, query);
    if (result.removed > 0) await this.write(root, result.notes);
    this.cache = { root, notes: result.notes };
    return result;
  }

  private async read(root: string): Promise<MemoryNote[]> {
    try {
      return sanitizeNotes(JSON.parse(await fs.readFile(this.fileFor(root), 'utf8')));
    } catch {
      // Файла нет или он повреждён — чистая память, а не ошибка: заметка, которую
      // нельзя прочитать, не должна ломать ответ модели.
      return [];
    }
  }

  private async write(root: string, notes: readonly MemoryNote[]): Promise<void> {
    const file = this.fileFor(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Через временный файл: падение посреди записи не оставит обрезанную память.
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  }

  private fileFor(root: string): string {
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe =
      path
        .basename(resolved)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    const dir = this.dir ?? path.join(app.getPath('userData'), 'memory');
    return path.join(dir, `${safe}-${hash}.json`);
  }
}
