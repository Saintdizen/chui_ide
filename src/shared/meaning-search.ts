/**
 * Поиск по смыслу: запрос не обязан совпадать со строкой буквально.
 *
 * Запрос режется на слова (`read file` → `read`, `file`), и строка набирает баллы
 * за каждое найденное слово: слово, встретившееся целиком, весит больше вхождения
 * внутри другого слова, а строка со **всеми** словами запроса получает надбавку.
 * Поэтому «read file» находит и `readFile`, и «читает файл» — а обычный текстовый
 * поиск требовал бы точной подстроки.
 *
 * Своих совпадений модуль не ищет: имена символов приходят от языкового сервера
 * (`workspace/symbol`), строки — от текстового поиска. Здесь только чистые правила
 * отбора и ранжирования: их и проверяет тест, без файловой системы и Electron.
 */

import { rankSymbolName, splitWords } from './code-search';

/** Символ-совпадение идёт впереди текста: «где объявлено» — главный ответ. */
const SYMBOL_BASE = 1000;
/** Вес слова, найденного целиком. */
const WORD_WEIGHT = 2;
/** Вес вхождения внутри другого слова (`read` в `reading`). */
const SUB_WEIGHT = 1;
/** Надбавка за строку, где нашлись все слова запроса. */
const ALL_WEIGHT = 3;

/** Символ в форме, нужной этому модулю. Совпадает с `ProjectSymbol`. */
export interface MeaningSymbol {
  name: string;
  kind: string;
  container?: string | null;
  path: string;
  line: number;
  column?: number;
}

/** Текстовая строка проекта — то, что вернул обычный поиск. */
export interface MeaningLine {
  path: string;
  line: number;
  text: string;
}

/** Один результат поиска по смыслу. */
export interface MeaningHit {
  kind: 'symbol' | 'text';
  path: string;
  line: number;
  /** Столбец (1-based) — чтобы сразу встать на нужное место. */
  column: number;
  /** Что показать: имя символа или начало строки. */
  label: string;
  /** Пояснение: вид и контейнер символа либо пометка «строка». */
  hint: string;
  /** Больше — релевантнее. Символы всегда впереди текста. */
  score: number;
}

/**
 * Слова запроса: по пробелам и границам CamelCase, в нижнем регистре. `readFile`
 * превращается в `read` и `file` — люди и модели пишут имя словами, а не как в коде.
 */
export function meaningTerms(query: string): string[] {
  return splitWords(query);
}

/**
 * Сколько баллов набирает строка под запрос. `0` — ни одно слово не нашлось.
 *
 * Слово ищется двумя способами: как целое слово строки (`word`) и как подстрока
 * (вхождение внутри другого слова). Разделение важно: иначе `read` в `reading`
 * весило бы столько же, сколько отдельное `read`, и точные строки терялись бы.
 */
export function scoreText(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;

  const lower = text.toLowerCase();
  const words = splitWords(text);
  let score = 0;
  let found = 0;

  for (const term of terms) {
    if (words.includes(term)) {
      score += WORD_WEIGHT;
      found += 1;
    } else if (lower.includes(term)) {
      score += SUB_WEIGHT;
      found += 1;
    }
  }

  if (found === 0) return 0;
  if (found === terms.length) score += ALL_WEIGHT;
  return score;
}

/**
 * Свести символы и текстовые строки в один упорядоченный список.
 *
 * Совпадения символов ранжирует `rankSymbolName` — тот же разбор, что у поиска
 * агента: точное имя, начало имени, слова, вхождение. Строка, попавшая на ту же
 * позицию, что и символ, отбрасывается: имя символа говорит о месте больше, чем
 * строка кода. Повторы (один и тот же файл и строка) убираются.
 */
export function combineMeaning(
  symbols: readonly MeaningSymbol[],
  lines: readonly MeaningLine[],
  query: string,
  limit: number,
): MeaningHit[] {
  const hits: MeaningHit[] = [];
  const taken = new Set<string>();

  for (const symbol of symbols) {
    const rank = rankSymbolName(symbol.name, query);
    if (rank === null) continue;
    const key = spot(symbol.path, symbol.line);
    if (taken.has(key)) continue;
    taken.add(key);
    hits.push({
      kind: 'symbol',
      path: symbol.path,
      line: symbol.line,
      column: symbol.column ?? 1,
      label: symbol.name,
      hint: symbol.container ? `${symbol.kind} · ${symbol.container}` : symbol.kind,
      score: SYMBOL_BASE - rank,
    });
  }

  const terms = meaningTerms(query);
  for (const line of lines) {
    const key = spot(line.path, line.line);
    if (taken.has(key)) continue;
    const score = scoreText(line.text, terms);
    if (score === 0) continue;
    taken.add(key);
    hits.push({
      kind: 'text',
      path: line.path,
      line: line.line,
      column: 1,
      label: line.text.trim(),
      hint: 'строка',
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, Math.max(0, limit));
}

/** Ключ позиции: файл и строка. По нему схлопываются дубли и совпадения с символом. */
function spot(path: string, line: number): string {
  return `${path}:${line}`;
}

/** Регулярка для чернового поиска: слова запроса через `|` — «любое из». */
export function meaningRegex(query: string): string {
  const terms = meaningTerms(query);
  if (terms.length === 0) return escapeRegex(query.trim());
  return terms.map(escapeRegex).join('|');
}

/** Экранировать спецсимволы регулярки: слово запроса — литерал, а не шаблон. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
