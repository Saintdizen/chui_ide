import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionState } from '../shared/api';
import { emptySession, sanitizeSession } from '../shared/session';

/**
 * Сессия рабочей папки: открытые вкладки, раскрытые папки, видимость панелей.
 * По одному JSON-файлу на проект — как у бесед (`chat-store.ts`), рядом с ними.
 *
 * Renderer остаётся источником истины: он собирает состояние и присылает сюда,
 * а при следующем открытии проекта забирает обратно. Проверка и границы —
 * в `shared/session.ts`, здесь только чтение и запись.
 */
export class SessionStore {
  private readonly dir?: string;

  /** Каталог можно задать явно (проверки), иначе — userData/sessions. */
  constructor(dir?: string) {
    this.dir = dir;
  }

  load(root: string): SessionState {
    if (!root) return emptySession();
    try {
      const raw: unknown = JSON.parse(readFileSync(this.fileFor(root), 'utf8'));
      return sanitizeSession(raw);
    } catch {
      // Файла нет или он повреждён — просто пустая сессия, а не ошибка запуска.
      return emptySession();
    }
  }

  save(root: string, state: SessionState): void {
    if (!root) return;
    const clean = sanitizeSession(state);
    const file = this.fileFor(root);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(clean)}\n`, 'utf8');
    renameSync(temporary, file);
  }

  private fileFor(root: string): string {
    const resolved = path.resolve(root);
    const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    const safe = path.basename(resolved).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'workspace';
    const dir = this.dir ?? path.join(app.getPath('userData'), 'sessions');
    return path.join(dir, `${safe}-${hash}.json`);
  }
}
