/**
 * Словарь орфографии в main-процессе.
 *
 * Свой словарь английских слов в поставку не влезает (это мегабайты), а renderer в
 * песочнице файлы читать не умеет. Поэтому словарь ищем в привычных местах системы —
 * там, где его кладут aspell, hunspell и LibreOffice, — и отдаём слова в renderer по
 * RPC. Файловый доступ остаётся в main, а проверка слов живёт в renderer (там текст).
 *
 * Формат узнаём по содержимому, а не по имени: `hunspell` пишет первой строкой число
 * слов, у простых списков такой строки нет. У hunspell слово идёт с флагами через косую
 * черту (`word/flags`) — флаги отбрасываем, а формы слова добираем простыми окончаниями
 * (см. `shared/spellcheck.ts`): разбирать правила словоизменения целиком было бы
 * отдельной задачей, а выгода невелика.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeDictionaryWord } from '../../shared/spellcheck';

/** Словарь и путь к файлу, из которого он взят (`null` — словаря в системе нет). */
export interface SpellDictionaryData {
  readonly words: string[];
  readonly source: string | null;
}

/**
 * Где искать словарь, в порядке предпочтения. Первым — явный путь из окружения
 * (`CHUI_DICTIONARY`): человек вправе указать свой словарь. Дальше — обычные места
 * Debian/Ubuntu, за ними macOS. Простой список слов (`dict/words` и его варианты) идёт
 * раньше hunspell: в нём уже есть словоформы, а не только основы.
 */
export function dictionaryCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const explicit = env.CHUI_DICTIONARY?.trim();
  if (explicit) candidates.push(explicit);

  // Windows своих словарей в известном месте не держит: остаётся явный путь.
  if (platform === 'win32') return candidates;

  // Пути всегда Unix-стиля, поэтому склеиваем posix-джойнером: на Windows-раннере
  // (там тоже вызывают с platform='linux') обычный path.join дал бы обратные слэши.
  for (const share of ['/usr/share', '/usr/local/share']) {
    candidates.push(path.posix.join(share, 'dict', 'words'));
    candidates.push(path.posix.join(share, 'dict', 'american-english'));
    candidates.push(path.posix.join(share, 'dict', 'british-english'));
    candidates.push(path.posix.join(share, 'hunspell', 'en_US.dic'));
    candidates.push(path.posix.join(share, 'hunspell', 'en_GB.dic'));
    candidates.push(path.posix.join(share, 'myspell', 'dicts', 'en_US.dic'));
    candidates.push(path.posix.join(share, 'myspell', 'en_US.dic'));
  }
  return candidates;
}

/** Разобрать содержимое словаря в список слов. Форму узнаём по первой строке. */
export function parseDictionary(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // hunspell пишет первой строкой число слов — по ней и отличаем его от простого списка.
  const hunspell = lines.length > 0 && /^\d+$/.test(lines[0]?.trim() ?? '');
  const words = new Set<string>();
  for (let index = hunspell ? 1 : 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw || raw.startsWith('#')) continue;
    // Поле слова — до первого пробела или табуляции (у простых списков бывает пометка).
    let field = raw.split(/[ \t]/, 1)[0] ?? '';
    // hunspell: `word/flags` — флаги словоизменения отбрасываем.
    const slash = field.indexOf('/');
    if (slash >= 0) field = field.slice(0, slash);
    const normalized = normalizeDictionaryWord(field);
    if (normalized) words.add(normalized);
  }
  return [...words];
}

let cached: SpellDictionaryData | null = null;

/**
 * Загрузить словарь: первый существующий файл из списка. Результат запоминаем на
 * процесс — словарь не меняется, а файл бывает крупным (сотни тысяч строк). Явный
 * список кандидатов (в тестах) кэш не трогает.
 */
export function loadSpellDictionary(candidates?: readonly string[]): SpellDictionaryData {
  if (!candidates && cached) return cached;

  const list = candidates ?? dictionaryCandidates(process.platform, process.env);
  for (const file of list) {
    try {
      if (!existsSync(file)) continue;
      const words = parseDictionary(readFileSync(file, 'utf8'));
      if (words.length === 0) continue;
      const data: SpellDictionaryData = { words, source: file };
      if (!candidates) cached = data;
      return data;
    } catch {
      // Побитый или недоступный файл — это не ошибка запуска, пробуем следующий.
    }
  }

  const empty: SpellDictionaryData = { words: [], source: null };
  if (!candidates) cached = empty;
  return empty;
}
