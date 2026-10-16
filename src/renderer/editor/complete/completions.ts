/**
 * Сборка списка подсказок по набранному префиксу.
 *
 * Подсказки приходят из трёх источников, и порядок между ними — главное решение здесь:
 *
 *   1. СЛОВА ЯЗЫКА (ключевые, типы, управляющие) — они есть всегда, и они короткие:
 *      набрав `for`, человек хочет `for`, а не `formatRow` из своего же файла.
 *   2. СЛОВА ДОКУМЕНТА (`WordIndex`) — имена из этого файла. Локальная переменная
 *      важнее ключевого слова, когда человек уже начал набирать её имя, но уступает
 *      языку, когда совпадение короткое и общее.
 *   3. СВОИ ДОПОЛНЕНИЯ — то, что передал вызывающий (позже здесь появятся подсказки
 *      от языкового сервера). Они идут первыми: кто дал их, знает больше нашего.
 *
 * Раньше друг друга источники ставит ОЦЕНКА совпадения, а не происхождение слова (см.
 * `fuzzy.ts`): по оценке совпадения. Набрано `f` — короткое `for` обгонит `formatRow` из
 * файла; набрано `gT` — найдётся `getTitle` по «горбам»; набрано `getT` — вперёд выйдет
 * имя из файла, дальше совпало. При равной оценке сохраняется порядок добавления: свои
 * дополнения, сниппеты, слова языка, затем частые слова файла.
 *
 * Модуль чистый: он не знает ни о DOM, ни о буфере — слова ему отдают. Поэтому список
 * проверяется в тестах без окна.
 */

import type { TextEdit } from '../../../shared/edits';
import { CODE_GRAMMARS } from '../highlight/languages/code';
import type { Snippet } from '../../../shared/snippets';
import { EXTERNAL_BONUS, matchScore } from './fuzzy';
import type { WordIndex } from './word-index';

/** Что за подсказка: по виду панель рисует значок, а не полагается на текст. */
export type CompletionKind = 'language' | 'word' | 'external' | 'snippet';

export interface CompletionItem {
  /** Что показываем в списке. */
  readonly label: string;
  readonly kind: CompletionKind;
  /** Пояснение справа от подписи: «ключевое слово», «в файле: 12» и подобное. */
  readonly detail: string;
  /** Индексы совпавших знаков подписи — по ним в списке подсвечивается совпадение. */
  readonly positions?: readonly number[];
  /**
   * Что вставится вместо набранного. Не задано — вставляется `label`. Сервер языка
   * может подставить не то, что написано в подписи (например, вызов с остальными
   * аргументами).
   */
  readonly insert?: string;
  /** Тело сниппета (разметка `${1:…}`, `$0`), если это сниппет. */
  readonly snippet?: string;
  /**
   * Правки, которые надо применить ВМЕСТЕ со вставкой (авто-импорт от сервера):
   * выбрав незнакомое имя, получаешь и строку `import`. Пусто — правок нет.
   */
  readonly additionalEdits?: readonly TextEdit[];
  /** По чему сопоставлять набранное (от сервера): у CamelCase оно не равно подписи. */
  readonly filterText?: string;
  /** Ключ сортировки сервера: по нему он ставит нужное выше. */
  readonly sortText?: string;
  /** Сервер советует выделить сразу. */
  readonly preselect?: boolean;
  /** Подсказка помечена как устаревшая. */
  readonly deprecated?: boolean;
  /** Описание символа (из `completionItem/resolve`): показывается под подписью. */
  readonly documentation?: string;
  /**
   * Исходный элемент сервера — его отправляем назад на `completionItem/resolve`,
   * когда список выделил эту строку. Есть только у подсказок сервера.
   */
  readonly resolve?: unknown;
}

export interface CompletionOptions {
  /** Предел списка: больше в попапе всё равно не видно. */
  readonly limit?: number;
  /** Свои дополнения от вызывающего (ответ языкового сервера, сниппеты). */
  readonly external?: readonly string[];
  /** Сниппеты, применимые к языку (см. `shared/snippets.ts`). Предлагаются по триггеру. */
  readonly snippets?: readonly Snippet[];
  /** Слово под курсором исключаем из подсказок — предлагать набранное бессмысленно. */
  readonly exclude?: ReadonlySet<string>;
}

/** Предел списка по умолчанию: столько строк попапа глаз охватывает без прокрутки. */
export const DEFAULT_LIMIT = 50;

/** Надбавка сниппетам: их задал человек, и триггер уже даёт точное совпадение. */
const SNIPPET_BONUS = 60;

/** Подсказка с оценкой — для сортировки списка по релевантности. */
interface RankedItem {
  readonly item: CompletionItem;
  readonly score: number;
  /** Порядок добавления: при равной оценке сохраняет прежний порядок (стабильность). */
  readonly order: number;
}

/**
 * Слова языка: ключевые, типы и управляющие конструкции его грамматики.
 *
 * Берём из словарей подсветки — они уже есть и уже верны. Заводить второй список слов
 * для подсказок значило бы держать две правды об одном языке и однажды их развести.
 * Язык без грамматики (или с грамматикой без словаря — Markdown, SQL) своих слов здесь
 * не даёт: подсказки будут только из документа, и это честно.
 */
export function languageWords(languageId: string): string[] {
  const config = CODE_GRAMMARS[languageId.toLowerCase()];
  if (!config) return [];
  return [...(config.controls ?? []), ...(config.keywords ?? []), ...(config.types ?? []), ...(config.constants ?? [])];
}

/**
 * Собрать подсказки по префиксу.
 *
 * `prefix` — то, что человек уже набрал перед курсором. Пустой префикс даёт пустой
 * список: подсказки «все слова файла» при нажатии Ctrl+Space тоже нужны, но это
 * отдельный вызов (`allCompletions`), а не поведение по умолчанию — иначе попап
 * вылезал бы на каждом слове.
 */
export function buildCompletions(
  index: WordIndex,
  languageId: string,
  prefix: string,
  options: CompletionOptions = {},
): CompletionItem[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (prefix.length === 0) return [];

  const excluded = options.exclude ?? new Set<string>();
  const emitted = new Set<string>();
  const ranked: RankedItem[] = [];
  let order = 0;

  const blocked = (label: string): boolean => excluded.has(label) || emitted.has(label);

  // 1. Свои дополнения — с надбавкой: их знает языковой сервер, а он точнее словаря.
  for (const label of options.external ?? []) {
    if (blocked(label)) continue;
    const match = matchScore(label, prefix);
    if (!match) continue;
    emitted.add(label);
    ranked.push({
      item: { label, kind: 'external', detail: 'предложено', positions: match.positions },
      score: match.score + EXTERNAL_BONUS,
      order: order++,
    });
  }

  // 2. Сниппеты — по триггеру. Набранное сниппету не помеха: триггер и есть набранное,
  //    поэтому `exclude` (слова строки) к ним не применяем — иначе они бы не нашлись.
  for (const snippet of options.snippets ?? []) {
    if (emitted.has(snippet.prefix)) continue;
    const match = matchScore(snippet.prefix, prefix);
    if (!match) continue;
    emitted.add(snippet.prefix);
    ranked.push({
      item: {
        label: snippet.prefix,
        kind: 'snippet',
        detail: snippet.description ?? 'сниппет',
        snippet: snippet.body,
        positions: match.positions,
      },
      score: match.score + SNIPPET_BONUS,
      order: order++,
    });
  }

  // 3. Слова языка и слова документа. Раньше друг друга их ставит оценка совпадения, а
  //    не источник (см. `fuzzy.ts`) — то же правило.
  for (const word of languageWords(languageId)) {
    if (blocked(word)) continue;
    const match = matchScore(word, prefix);
    if (!match) continue;
    emitted.add(word);
    ranked.push({
      item: { label: word, kind: 'language', detail: 'язык', positions: match.positions },
      score: match.score,
      order: order++,
    });
  }

  const words = index.candidates(prefix, limit * 2, new Set([...excluded, ...emitted]));
  for (const word of words) {
    if (emitted.has(word)) continue;
    const match = matchScore(word, prefix);
    if (!match) continue;
    emitted.add(word);
    ranked.push({
      item: { label: word, kind: 'word', detail: `в файле: ${index.count(word)}`, positions: match.positions },
      score: match.score,
      order: order++,
    });
  }

  ranked.sort((left, right) => right.score - left.score || left.order - right.order);
  return ranked.slice(0, limit).map((entry) => entry.item);
}

/**
 * Все подсказки без префикса — для Ctrl+Space. Списки языка и файла ЧЕРЕДУЮТСЯ
 * половинами, и это не украшение: слов языка набирается сотни (в одном TypeScript
 * больше сотни ключевых слов и типов), и если пустить их подряд, до имён из файла
 * список никогда не дойдёт. А имена из файла человеку нужнее: ключевые слова он и так
 * знает.
 */
export function allCompletions(
  index: WordIndex,
  languageId: string,
  options: CompletionOptions = {},
): CompletionItem[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const exclude = options.exclude ?? new Set<string>();
  const items: CompletionItem[] = [];
  const taken = new Set<string>(exclude);

  const push = (label: string, kind: CompletionKind, detail: string, cap = limit): void => {
    if (taken.has(label) || items.length >= cap) return;
    items.push({ label, kind, detail });
    taken.add(label);
  };

  for (const word of options.external ?? []) push(word, 'external', 'предложено');

  // Сниппеты — по триггеру целиком: их немного, и они осмысленны сами по себе.
  for (const snippet of options.snippets ?? []) {
    if (taken.has(snippet.prefix)) continue;
    items.push({
      label: snippet.prefix,
      kind: 'snippet',
      detail: snippet.description ?? 'сниппет',
      snippet: snippet.body,
    });
    taken.add(snippet.prefix);
  }

  // Первая половина — язык, потом файл, потом остаток языка: так в списке всегда
  // видны оба, и видно, что в файле есть своё.
  const half = Math.max(1, Math.floor(limit / 2));
  for (const word of languageWords(languageId)) push(word, 'language', 'язык', half);
  for (const word of index.allWords(limit, taken)) push(word, 'word', `в файле: ${index.count(word)}`);
  // Добираем языковые слова, не попавшие в первую половину.
  for (const word of languageWords(languageId)) push(word, 'language', 'язык');

  return items.slice(0, limit);
}
