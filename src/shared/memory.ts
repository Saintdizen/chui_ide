/**
 * Память проекта: заметки агента, которые переживают беседу.
 *
 * Зачем отдельно от истории чата: при сжатии беседы её середина затирается
 * резюме, а часть решений и предпочтений исчезает вовсе. Память лежит рядом с
 * проектом, а не внутри диалога, поэтому «мы договорились использовать pytest»
 * остаётся правдой и в новой беседе.
 *
 * Здесь только правило и текст: чтение с диска — дело main. Поэтому модуль чистый
 * и проверяется без Electron.
 */

/** Одна заметка. `at` — когда записана, чтобы можно было показать свежие первыми. */
export interface MemoryNote {
  text: string;
  /** Unix-время записи (мс). */
  at: number;
}

/** Сколько заметок держим: память — выжимка, а не дневник. За полем — отказ, не молчание. */
export const MAX_NOTES = 40;
/** Потолок одной заметки: длинная заметка — это уже не заметка, а простыня в промпте. */
export const MAX_NOTE_CHARS = 500;

/** Проверить прочитанное с диска: файл мог быть правлен руками. */
export function sanitizeNotes(raw: unknown): MemoryNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: MemoryNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { text?: unknown; at?: unknown };
    if (typeof value.text !== 'string') continue;
    const text = value.text.trim();
    if (!text) continue;
    notes.push({ text: text.slice(0, MAX_NOTE_CHARS), at: typeof value.at === 'number' ? value.at : 0 });
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

/** Итог добавления: либо новая память, либо причина отказа (её видит агент). */
export type RememberResult =
  | { ok: true; notes: MemoryNote[]; added: boolean }
  | { ok: false; reason: 'empty' | 'full' | 'duplicate' };

/**
 * Добавить заметку. Точный повтор не плодим: одна и та же мысль, записанная
 * дважды, только засоряет промпт. Потолок достигнут — честный отказ: агент
 * должен сначала убрать лишнее, а не потерять новое молча.
 */
export function addNote(notes: readonly MemoryNote[], text: string, at: number): RememberResult {
  const clean = text.trim().slice(0, MAX_NOTE_CHARS);
  if (!clean) return { ok: false, reason: 'empty' };

  const existing = notes.find((note) => note.text === clean);
  if (existing) return { ok: true, notes: [...notes], added: false };
  if (notes.length >= MAX_NOTES) return { ok: false, reason: 'full' };

  return { ok: true, notes: [...notes, { text: clean, at }], added: true };
}

/**
 * Убрать заметки, в которых встречается подстрока. Возвращает новую память и
 * сколько убрано — по числу видно, попал ли запрос хоть во что-то.
 */
export function removeNotes(notes: readonly MemoryNote[], query: string): { notes: MemoryNote[]; removed: number } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { notes: [...notes], removed: 0 };
  const kept = notes.filter((note) => !note.text.toLowerCase().includes(needle));
  return { notes: kept, removed: notes.length - kept.length };
}

/** Блок памяти для системного промпта; пустая память — `null`, чтобы не слать заголовок впустую. */
export function formatMemory(notes: readonly MemoryNote[]): string | null {
  if (notes.length === 0) return null;
  const lines = notes.map((note) => `- ${note.text}`);
  return ['Память проекта (заметки, которые ты оставил ранее; они переживают беседу):', ...lines].join('\n');
}
