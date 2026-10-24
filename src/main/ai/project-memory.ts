import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  addNote,
  parseMemory,
  removeNotes,
  serializeMemory,
  type MemoryNote,
  type MemoryScope,
  type RememberResult,
} from '../../shared/memory';

/**
 * Хранилище памяти ассистента: заметки агента в двух областях, по .md-файлу на область.
 *
 * Файлы — обычный markdown: их видно и можно править руками (разбор пропускает всё,
 * кроме строк-заметок, — см. `shared/memory.ts`). Проектная память — файл на рабочую
 * папку, глобальная (`global.md`) — одна на все проекты.
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
  /** Кеш по пути файла памяти: заметки области читаются на каждый запрос. */
  private readonly cache = new Map<string, MemoryNote[]>();

  constructor(private readonly dir?: string) {}

  /** Заметки области. Без корня проектная память недоступна, глобальная — всегда. */
  async list(root: string | null, scope: MemoryScope = 'workspace'): Promise<MemoryNote[]> {
    const file = this.fileFor(root, scope);
    if (!file) return [];
    const cached = this.cache.get(file);
    if (cached) return cached;
    const notes = await this.read(file);
    this.cache.set(file, notes);
    return notes;
  }

  /** Записать заметку. Итог несёт причина отказа, её читает агент. */
  async remember(root: string | null, text: string, scope: MemoryScope = 'workspace'): Promise<RememberResult> {
    const file = this.fileFor(root, scope);
    if (!file) return { ok: false, reason: 'empty' };
    const notes = await this.list(root, scope);
    const result = addNote(notes, text);
    if (result.ok && result.added) {
      await this.write(file, result.notes, scope);
      this.cache.set(file, result.notes);
    }
    return result;
  }

  /** Убрать заметки по подстроке. Возвращает, сколько убрано. */
  async forget(
    root: string | null,
    query: string,
    scope: MemoryScope = 'workspace',
  ): Promise<{ notes: MemoryNote[]; removed: number }> {
    const file = this.fileFor(root, scope);
    if (!file) return { notes: [], removed: 0 };
    const notes = await this.list(root, scope);
    const result = removeNotes(notes, query);
    if (result.removed > 0) {
      await this.write(file, result.notes, scope);
      this.cache.set(file, result.notes);
    }
    return result;
  }

  private async read(file: string): Promise<MemoryNote[]> {
    try {
      return parseMemory(await fs.readFile(file, 'utf8'));
    } catch {
      // Файла нет или он нечитаем — чистая память, а не ошибка: заметка, которую
      // нельзя прочитать, не должна ломать ответ модели.
      return [];
    }
  }

  private async write(file: string, notes: readonly MemoryNote[], scope: MemoryScope): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Через временный файл: падение посреди записи не оставит обрезанную память.
    const temporary = `${file}.tmp`;
    const title = scope === 'global' ? 'Память (глобальная, для всех проектов)' : 'Память проекта';
    await fs.writeFile(temporary, serializeMemory(notes, title), 'utf8');
    await fs.rename(temporary, file);
  }

  /**
   * Путь файла памяти. Проектный — имя папки плюс хеш пути (две одноимённые папки
   * не делят память); глобальный — один файл на все проекты.
   */
  private fileFor(root: string | null, scope: MemoryScope): string | null {
    const dir = this.dir ?? path.join(app.getPath('userData'), 'memory');
    if (scope === 'global') return path.join(dir, 'global.md');
    if (!root) return null;
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe =
      path
        .basename(resolved)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    return path.join(dir, `${safe}-${hash}.md`);
  }
}
