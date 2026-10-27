import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatHistory } from '../../shared/api';
import { sanitizeConversations, sanitizeHistory } from '../../shared/chat-sanitize';

/**
 * Хранилище бесед: по одному JSON-файлу на рабочую папку.
 *
 * Renderer остаётся источником истины (он собирает ленту и историю), а main
 * только пишет и читает. Файлы лежат рядом с настройками и намеренно отдельно
 * от `settings.json`: беседа растёт в размерах и незачем держать её в одном
 * файле с ключами и параметрами редактора.
 *
 * Проверка прочитанного — что доверять файлу нельзя — живёт в
 * `shared/chat-sanitize.ts`: она чистая и покрыта тестами.
 */

export class ChatStore {
  private readonly dir?: string;

  /** Каталог можно задать явно (проверки), иначе — userData/chats. */
  constructor(dir?: string) {
    this.dir = dir;
  }

  async load(root: string): Promise<ChatHistory> {
    if (!root) return { conversations: [] };
    try {
      const raw: unknown = JSON.parse(await fs.readFile(await this.existingFile(root), 'utf8'));
      return sanitizeHistory(raw);
    } catch {
      // Файла нет или он повреждён — начинаем с чистой истории, а не с ошибки:
      // потеря беседы неприятна, но отказ панели хуже.
      return { conversations: [] };
    }
  }

  /**
   * Запись асинхронная: файл может быть в мегабайты, и синхронная запись
   * на каждый debounce подвешивала бы main-процесс. Пишем через временный файл,
   * чтобы падение посреди записи не оставило обрезанную историю.
   */
  async save(root: string, history: ChatHistory): Promise<void> {
    if (!root) return;

    const conversations = sanitizeConversations(history.conversations ?? []);
    const payload: ChatHistory = {
      conversations,
      ...(typeof history.activeUid === 'string' && history.activeUid ? { activeUid: history.activeUid } : {}),
    };

    const file = this.fileFor(root);
    const legacy = this.legacyFileFor(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    await fs.rename(temporary, file);
    // Файл под прежним именем больше не нужен: история уже в новом.
    if (legacy !== file) await fs.rm(legacy, { force: true });
  }

  /**
   * Где лежит файл беседы этого проекта. Нужен не для чтения, а чтобы индекс
   * прошлых бесед клал копию рядом: правила именования живут в одном месте, и
   * разойтись им негде.
   */
  fileForRoot(root: string): string {
    return this.fileFor(root);
  }

  /**
   * Имя файла повторяет имя проекта (чтобы каталог читался глазами) плюс
   * короткий хеш пути: две одинаково названные папки не затирают друг друга.
   */
  private fileFor(root: string): string {
    return path.join(this.dirOf(), `${this.stem(root)}-${this.hash(root)}.json`);
  }

  /**
   * Файл беседы этого проекта, а если его нет — файл под прежним именем.
   * Старое имя вырезало кириллицу: `\w` в JS знает только латиницу, и у всех
   * русских папок читаемая часть схлопывалась в `_`. Кто обновился — у того
   * история лежит под `_-<хеш>.json`. Читаем её и при первой же записи
   * переезжаем на читаемое имя: молча потерять беседу хуже, чем подержать
   * в каталоге лишний файл до следующего сохранения.
   */
  private async existingFile(root: string): Promise<string> {
    const file = this.fileFor(root);
    const legacy = this.legacyFileFor(root);
    if (legacy === file) return file;
    try {
      await fs.access(file);
      return file;
    } catch {
      return legacy;
    }
  }

  private dirOf(): string {
    return this.dir ?? path.join(app.getPath('userData'), 'chats');
  }

  private hash(root: string): string {
    return createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  }

  /** Читаемая часть имени: буквы любого алфавита, цифры, точка, тире, подчёркивание. */
  private stem(root: string): string {
    const stem = path
      .basename(path.resolve(root))
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(0, 40);
    return stem || 'workspace';
  }

  /** Прежнее имя: удаляется при записи, чтобы в каталоге не копился мусор. */
  private legacyFileFor(root: string): string {
    const safe =
      path
        .basename(path.resolve(root))
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    return path.join(this.dirOf(), `${safe}-${this.hash(root)}.json`);
  }
}
