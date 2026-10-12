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
 * Разумное правило отбора: если префикс целиком укладывается в языковое слово, языковое
 * идёт первым — набрано `f`, и предложить `for` честнее, чем `foo`. Но как только
 * совпадение по префиксу длинное (совпало больше двух знаков), вперёд идут слова
 * документа: человек явно набирает что-то из файла.
 *
 * Модуль чистый: он не знает ни о DOM, ни о буфере — слова ему отдают. Поэтому список
 * проверяется в тестах без окна.
 */

import type { TextEdit } from '../../../shared/edits';
import { CODE_GRAMMARS } from '../highlight/languages/code';
import type { Snippet } from '../../../shared/snippets';
import type { WordIndex } from './word-index';

/** Что за подсказка: по виду панель рисует значок, а не полагается на текст. */
export type CompletionKind = 'language' | 'word' | 'external' | 'snippet';

export interface CompletionItem {
  /** Что показываем в списке. */
  readonly label: string;
  readonly kind: CompletionKind;
  /** Пояснение справа от подписи: «ключевое слово», «в файле: 12» и подобное. */
  readonly detail: string;
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

  const exclude = options.exclude ?? new Set<string>();
  const lowered = prefix.toLowerCase();
  const items: CompletionItem[] = [];
  const taken = new Set<string>(exclude);

  // 1. Свои дополнения — первыми: они знают то, чего не знаем мы.
  for (const label of options.external ?? []) {
    if (!label.toLowerCase().startsWith(lowered) || taken.has(label)) continue;
    items.push({ label, kind: 'external', detail: 'предложено' });
    taken.add(label);
  }

  // Сниппеты — сразу за своими дополнениями: их задал человек, и они важнее слов
  // языка. Именно так и ждёт тот, кто набрал триггер заготовки. Набранное слово
  // сниппету НЕ помеха (в отличие от слов файла): триггер и есть набранное слово,
  // поэтому исключение `exclude` сюда не применяем — иначе сниппет не нашёлся бы.
  const snippetLabels = new Set<string>();
  for (const snippet of options.snippets ?? []) {
    if (items.length >= limit) break;
    if (!snippet.prefix.toLowerCase().startsWith(lowered) || snippetLabels.has(snippet.prefix)) continue;
    snippetLabels.add(snippet.prefix);
    items.push({
      label: snippet.prefix,
      kind: 'snippet',
      detail: snippet.description ?? 'сниппет',
      snippet: snippet.body,
    });
    taken.add(snippet.prefix);
  }

  // 2. Слова языка и слова документа. Что из них раньше — решает длина совпадения.
  const language = languageWords(languageId).filter((word) => word.toLowerCase().startsWith(lowered));
  const words = index.candidates(prefix, limit * 2, taken);
  const languageFirst = lowered.length <= 2;

  const push = (label: string, kind: CompletionKind, detail: string): void => {
    if (taken.has(label) || items.length >= limit) return;
    items.push({ label, kind, detail });
    taken.add(label);
  };

  const languagePass = (): void => {
    for (const word of language) push(word, 'language', 'язык');
  };
  const wordPass = (): void => {
    for (const word of words) push(word, 'word', `в файле: ${index.count(word)}`);
  };

  if (languageFirst) {
    languagePass();
    wordPass();
  } else {
    wordPass();
    languagePass();
  }

  return items.slice(0, limit);
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
