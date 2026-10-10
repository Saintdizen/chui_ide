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
      const raw: unknown = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8'));
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
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, 'utf8');
    await fs.rename(temporary, file);
  }

  /**
   * Имя файла повторяет имя проекта (чтобы каталог читался глазами) плюс
   * короткий хеш пути: две одинаково названные папки не затирают друг друга.
   */
  private fileFor(root: string): string {
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe =
      path
        .basename(resolved)
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 40) || 'workspace';
    const dir = this.dir ?? path.join(app.getPath('userData'), 'chats');
    return path.join(dir, `${safe}-${hash}.json`);
  }
}
