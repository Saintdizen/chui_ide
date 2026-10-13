import { isInsidePath, nameOf, pathAfter } from './paths';

/**
 * Локальная история файла: снимки содержимого, снятые при сохранении.
 *
 * Git помнит только закоммиченное, а черновики, эксперименты и правки, которых в
 * репозиторий не будет, — нет. Локальная история закрывает именно этот случай:
 * перед каждой перезаписью файла мы откладываем его прежнее содержимое, чтобы
 * к нему можно было вернуться.
 *
 * Снимки лежат в userData (`main/project/history-store.ts`), а не в проекте: это
 * рабочий мусор, ему не место в репозитории и в коммитах коллег.
 *
 * Здесь — только форма записи и чистые подписи; чтение и запись диска живут в main,
 * поэтому вся логика разбора проверяется тестами без файловой системы.
 */

/** Почему снимок попал в историю. */
export type HistoryReason = 'save' | 'delete';

/**
 * Один снимок: само содержимое лежит отдельным файлом, здесь — только метаданные,
 * которых хватает для списка и подписи.
 */
export interface HistoryEntry {
  /** Идентификатор снимка: его принимают `history.read` и возврат к версии. */
  id: string;
  /** Абсолютный путь файла на момент снимка. */
  path: string;
  /** Имя файла на момент снимка (файл могли переименовать позже). */
  name: string;
  /** Когда снято, миллисекунды эпохи. */
  mtimeMs: number;
  /** Размер содержимого в байтах. */
  size: number;
  /** Число строк в снимке — как их считает редактор. */
  lines: number;
  /** Отпечаток содержимого: по нему мы не сохраняем повтор того же текста. */
  hash: string;
  reason: HistoryReason;
}

/** Сколько снимков держим на файл: старые вытесняются. */
export const MAX_HISTORY_ENTRIES = 50;

/** Снимки больше этого не берём: копия большого файла съест память и диск. */
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** Подпись причины — она видна в списке. */
export function reasonLabel(reason: HistoryReason): string {
  return reason === 'delete' ? 'перед удалением' : 'сохранение';
}

/** Число строк: так же, как в редакторе, — по `\n` плюс одна. */
export function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** Время снимка в формате ЧЧ:ММ:СС — по нему различаются и снимки одной минуты. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Возраст снимка словами: «только что», «5 мин назад», «2 ч назад», «3 дн назад». */
export function describeAge(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 45) return 'только что';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} дн назад`;
  const months = Math.round(days / 30);
  return `${months} мес назад`;
}

/** Одна строка списка: время, возраст, размер в строках и причина. */
export function historyEntryLabel(entry: HistoryEntry, nowMs: number): string {
  return [
    formatClock(entry.mtimeMs),
    describeAge(entry.mtimeMs, nowMs),
    `${entry.lines} стр.`,
    reasonLabel(entry.reason),
  ].join(' · ');
}

/**
 * Ключ файла внутри хранилища рабочей области: путь от корня, а для пути вне
 * корня — абсолютный. Так раскладка повторяет дерево проекта и остаётся читаемой.
 */
export function historyKey(root: string, filePath: string): string {
  if (!root) return filePath;
  if (!isInsidePath(root, filePath)) return filePath;
  return pathAfter(root, filePath) || nameOf(filePath);
}

function isReason(value: unknown): value is HistoryReason {
  return value === 'save' || value === 'delete';
}

/** Разбор одной записи из индекса: битая или неполная отбрасывается. */
export function sanitizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.path !== 'string' || record.path === '') return null;
  return {
    id: record.id,
    path: record.path,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : nameOf(record.path),
    mtimeMs: typeof record.mtimeMs === 'number' && Number.isFinite(record.mtimeMs) ? record.mtimeMs : 0,
    size: typeof record.size === 'number' && record.size >= 0 ? record.size : 0,
    lines: typeof record.lines === 'number' && record.lines > 0 ? record.lines : 1,
    hash: typeof record.hash === 'string' ? record.hash : '',
    reason: isReason(record.reason) ? record.reason : 'save',
  };
}

/** Разбор списка снимков файла: незнакомые записи пропускаются, порядок сохраняется. */
export function sanitizeHistoryEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    const entry = sanitizeHistoryEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}
