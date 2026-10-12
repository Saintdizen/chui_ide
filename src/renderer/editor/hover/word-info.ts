/**
 * Что редактор знает о слове под курсором.
 *
 * У нашего редактора нет языкового сервера, и делать вид, что есть, — худшее из
 * возможного: подсказка с пустотой хуже её отсутствия. Поэтому наведение рассказывает
 * ровно то, что видно в самом файле, и не выдумывает:
 *
 *   • что это за слово и какого оно рода — роль берётся из подсветки, то есть из той же
 *     грамматики, которой нарисован текст (ключевое слово, тип, имя функции);
 *   • сколько раз оно встречается в файле и где впервые — это реально помогает, когда
 *     имя `config` объявлено на 12-й строке, а используется на 400-й;
 *   • объявлено ли оно выше — ищем `const`/`let`/`function`/`def`/`класс` перед словом.
 *
 * Числа считаются по документу, а не по словарю подсказок: словарь наполняется только
 * просмотренными строками (см. `complete/word-index.ts`), и «встречается 3 раза» на
 * самом деле значило бы «три раза в том, что вы успели пролистать». Здесь же — честный
 * подсчёт по всему файлу, и он дешёвый: это один проход по строкам на показ подсказки,
 * а показ случается по наведению, то есть редко.
 *
 * Модуль чистый: он не знает ни о DOM, ни о том, куда показать подсказку.
 */

import { wordAt } from '../core/graphemes';
import type { TextBuffer } from '../core/text-buffer';

/** Что удалось выяснить о слове. */
export interface WordInfo {
  /** Само слово. */
  readonly word: string;
  /** Смещения его начала и конца в документе. */
  readonly start: number;
  readonly end: number;
  /** Номер строки с единицы. */
  readonly line: number;
  /** Сколько раз слово встречается в файле целиком. */
  readonly occurrences: number;
  /** Строка первого вхождения с единицы. */
  readonly firstLine: number;
  /**
   * Строка объявления, если слово где-то объявлено (`const name`, `def name`, `class Name`).
   * `null` — объявления не нашли (имя из чужого файла, поле, свойство).
   */
  readonly declaredAt: number | null;
  /** Как слово объявлено: `const`, `function`, `def`, `class` — для показа. */
  readonly declarationKind: string | null;
}

/**
 * Объявления по языкам. Список не «весь синтаксис», а те слова, после которых человек
 * пишет имя: объявление переменной, функции, класса. Хватает, чтобы сказать «объявлено
 * как функция на строке 12», и не требует разбора — только поиска слова перед именем.
 */
const DECLARATIONS: readonly { keyword: string; label: string }[] = [
  { keyword: 'function', label: 'функция' },
  { keyword: 'def', label: 'функция' },
  { keyword: 'func', label: 'функция' },
  { keyword: 'fn', label: 'функция' },
  { keyword: 'class', label: 'класс' },
  { keyword: 'struct', label: 'структура' },
  { keyword: 'interface', label: 'интерфейс' },
  { keyword: 'trait', label: 'трейт' },
  { keyword: 'enum', label: 'перечисление' },
  { keyword: 'type', label: 'тип' },
  { keyword: 'const', label: 'константа' },
  { keyword: 'let', label: 'переменная' },
  { keyword: 'var', label: 'переменная' },
  { keyword: 'val', label: 'значение' },
  { keyword: 'interface', label: 'интерфейс' },
];

/** Что известно о слове под смещением. `null` — под ним не слово. */
export function wordInfoAt(buffer: TextBuffer, offset: number): WordInfo | null {
  const line = buffer.lineAt(offset);
  const lineStart = buffer.lineStart(line);
  const text = buffer.lineText(line);
  const local = Math.max(0, Math.min(offset - lineStart, Math.max(0, text.length - 1)));
  const word = wordAt(text, local);
  if (!word) return null;

  const value = text.slice(word.start, word.end);
  const start = lineStart + word.start;
  const end = lineStart + word.end;

  let occurrences = 0;
  let firstLine = line;
  let declaredAt: number | null = null;
  let declarationKind: string | null = null;

  for (let current = 1; current <= buffer.lineCount; current += 1) {
    const currentText = buffer.lineText(current);
    if (currentText.length === 0) continue;
    // Ищем слово целиком: вхождение внутри другого имени (`config` в `configPath`) не считаем.
    for (const found of wordOccurrences(currentText, value)) {
      occurrences += 1;
      if (occurrences === 1) firstLine = current;
      if (declaredAt === null) {
        const kind = declarationBefore(currentText, found);
        if (kind) {
          declaredAt = current;
          declarationKind = kind;
        }
      }
    }
  }

  return { word: value, start, end, line, occurrences, firstLine, declaredAt, declarationKind };
}

/** Смещения вхождений слова в строке — по границам слов, без регулярки на весь текст. */
function* wordOccurrences(text: string, word: string): Generator<number> {
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at < 0) return;
    const before = text[at - 1];
    const after = text[at + word.length];
    if (!isWordChar(before) && !isWordChar(after)) yield at;
    from = at + word.length;
  }
}

const WORD_CHAR = /[\p{L}\p{Nl}\p{Nd}\p{Pc}_$]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && WORD_CHAR.test(ch);
}

/** Как объявлено слово на этой позиции: слово-объявление стоит слева от имени. */
function declarationBefore(text: string, at: number): string | null {
  const before = text.slice(0, at).trimEnd();
  for (const { keyword, label } of DECLARATIONS) {
    if (before === keyword || before.endsWith(` ${keyword}`)) return label;
  }
  return null;
}

/**
 * Текст подсказки для показа. Отдельной функцией, а не сборкой в виджете: тому, кто
 * показывает, не должно быть дела до того, из чего складывается описание.
 */
export function describeWord(info: WordInfo): { title: string; lines: string[] } {
  const lines = [`Встречается в файле: ${info.occurrences} ${plural(info.occurrences, 'раз', 'раза', 'раз')}`];
  if (info.declaredAt !== null && info.declarationKind !== null) {
    // «Объявление: функция, строка 12» — без согласования по роду: сам термин его не требует.
    const where = info.declaredAt === info.line ? 'эта строка' : `строка ${info.declaredAt}`;
    lines.push(`Объявление: ${info.declarationKind}, ${where}`);
  } else if (info.firstLine !== info.line) {
    lines.push(`Впервые на строке ${info.firstLine}`);
  }
  return { title: info.word, lines };
}

/** Русское склонение по числу: 1 раз, 2 раза, 5 раз. */
function plural(value: number, one: string, few: string, many: string): string {
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
