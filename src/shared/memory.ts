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
export const MAX_NOTE_CHARS = 320;

/**
 * Сколько символов памяти уходит в промпт. Заметки лежат в файле все, но в
 * каждый запрос едет только этот кусок: при потолке в 40 заметок по 320 символов
 * память весила бы около 5 000 токенов на каждом шаге прогона — дороже схем
 * инструментов. Режем по границе заметки и с конца: свежее важнее.
 */
export const MEMORY_PROMPT_CHARS = 4_000;

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
    `# ${title}`,
    '',
    'Заметки ассистента. Строка, начинающаяся с дефиса и пробела, — отдельная заметка.',
    'Файл можно править вручную: правки подхватятся при следующем ответе.',
  ];
  const body = notes.map((note) => `- ${note.text}`);
  const lines = body.length > 0 ? head.concat([''], body) : head;
  return `${lines.join('\n')}\n`;
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

  // С конца: свежая заметка нужнее давней. Лишнее не теряется — оно остаётся в
  // файле памяти, а в промпте остаётся видимая пометка, что память показана не вся:
  // иначе агент записал бы уже записанное, приняв умолчание за чистый лист.
  const shown: string[] = [];
  let size = 0;
  for (let at = notes.length - 1; at >= 0; at -= 1) {
    const line = `- ${notes[at]!.text}`;
    if (shown.length > 0 && size + line.length > MEMORY_PROMPT_CHARS) break;
    shown.push(line);
    size += line.length + 1;
  }
  shown.reverse();

  const hidden = notes.length - shown.length;
  // У скрытой части обязан быть адрес: без него память полна, а что в ней — не
  // видно, и `forget` бьёт по догадке. Ссылку называем только когда есть что скрывать.
  const tail =
    hidden > 0
      ? [`(ещё ${hidden}: не показаны — не вместились в бюджет промпта; весь список — mind (action: notes))`]
      : [];
  return [
    `Память ${SCOPE_LABEL[scope]} (заметки, которые ты оставил ранее; они переживают беседу):`,
    ...shown,
    ...tail,
  ].join('\n');
}

/**
 * Вся память области одним куском — ответ на `mind (action: notes)`. В промпт
 * едет только хвост (см. `formatMemory`), поэтому при переполнении агент видит
 * 12 заметок из 40: без полного списка `forget` работает наугад, а отказ
 * `remember` по «память заполнена» не даёт даже посмотреть, что там лежит.
 * Нумеруем для чтения глазами; `forget` по-прежнему ищет подстроку.
 */
export function formatAllNotes(notes: readonly MemoryNote[], scope: MemoryScope = 'workspace'): string {
  if (notes.length === 0) return `Память ${SCOPE_LABEL[scope]} пуста.`;
  const head = `Память ${SCOPE_LABEL[scope]} — все заметки (${notes.length} из ${MAX_NOTES}):`;
  return [head, ...notes.map((note, at) => `${at + 1}. ${note.text}`)].join('\n');
}
