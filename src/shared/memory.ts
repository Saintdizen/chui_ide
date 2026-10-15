/**
 * Память проекта: заметки агента, которые переживают беседу.
 *
 * Зачем отдельно от истории чата: при сжатии беседы её середина затирается
 * резюме, а часть решений и предпочтений исчезает вовсе. Память лежит рядом с
 * проектом, а не внутри диалога, поэтому «мы договорились использовать pytest»
 * остаётся правдой и в новой беседе.
 *
 * Хранение — обычные .md-файлы: их видно и можно править руками, как заметки в
 * блокноте. Заметка — строка, начинающаяся с «- »; всё прочее (заголовок,
 * пояснение) при разборе пропускается, поэтому файл можно дописывать от руки,
 * не ломая чтение.
 *
 * Областей две: `workspace` — заметки проекта, `global` — общие для всех
 * проектов (личные предпочтения). Каждая область — свой файл.
 *
 * Здесь только правило и текст: чтение с диска — дело main. Поэтому модуль чистый
 * и проверяется без Electron.
 */

/** Одна заметка — одна мысль. */
export interface MemoryNote {
  text: string;
}

/** Область памяти: заметки проекта или общие для всех проектов. */
export type MemoryScope = 'workspace' | 'global';

/** Сколько заметок держим: память — выжимка, а не дневник. За полем — отказ, не молчание. */
export const MAX_NOTES = 40;
/** Потолок одной заметки: длинная заметка — это уже не заметка, а простыня в промпте. */
export const MAX_NOTE_CHARS = 500;

/**
 * Разобрать файл памяти (.md). Заметки — строки, начинающиеся с дефиса и пробела;
 * заголовки, пояснения и пустые строки пропускаем: файл правят руками, и лишняя
 * строка не должна сбивать чтение. Число заметок и длину каждой подрезаем.
 */
export function parseMemory(text: string): MemoryNote[] {
  const notes: MemoryNote[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const value = line.slice(2).trim();
    if (!value) continue;
    notes.push({ text: value.slice(0, MAX_NOTE_CHARS) });
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

/** Собрать файл памяти (.md) вместе с шапкой-пояснением, как его править руками. */
export function serializeMemory(notes: readonly MemoryNote[], title: string): string {
  const head = [
    '# ' + title,
    '',
    'Заметки ассистента. Строка, начинающаяся с дефиса и пробела, — отдельная заметка.',
    'Файл можно править вручную: правки подхватятся при следующем ответе.',
  ];
  const body = notes.map((note) => '- ' + note.text);
  const lines = body.length > 0 ? head.concat([''], body) : head;
  return lines.join('\n') + '\n';
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
export function addNote(notes: readonly MemoryNote[], text: string): RememberResult {
  const clean = text.trim().slice(0, MAX_NOTE_CHARS);
  if (!clean) return { ok: false, reason: 'empty' };

  const existing = notes.find((note) => note.text === clean);
  if (existing) return { ok: true, notes: [...notes], added: false };
  if (notes.length >= MAX_NOTES) return { ok: false, reason: 'full' };

  return { ok: true, notes: [...notes, { text: clean }], added: true };
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

/** Подпись области в промпте — по ней видно, откуда заметка. */
const SCOPE_LABEL: Record<MemoryScope, string> = {
  workspace: 'проекта',
  global: 'общая (для всех проектов)',
};

/**
 * Блок памяти для системного промпта; пустая память — `null`, чтобы не слать
 * заголовок впустую. Область называем прямо: глобальная заметка — не про этот
 * проект, и агент не должен принимать её за него.
 */
export function formatMemory(notes: readonly MemoryNote[], scope: MemoryScope = 'workspace'): string | null {
  if (notes.length === 0) return null;
  const lines = notes.map((note) => '- ' + note.text);
  return [
    'Память ' + SCOPE_LABEL[scope] + ' (заметки, которые ты оставил ранее; они переживают беседу):',
    ...lines,
  ].join('\n');
}
