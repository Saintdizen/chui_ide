/**
 * Python: отступы, решётка-комментарий, строки с префиксами.
 *
 * Язык держим отдельной грамматикой, а не настройкой C-подобной, потому что
 * отличий больше, чем совпадений: комментарий начинается с решётки, строки бывают
 * тройными (и тогда тянутся через строки), а перед кавычкой может стоять префикс
 * (`f`, `r`, `b`, `rb`) — сам префикс тоже часть строки.
 *
 * Два штриха ради узнаваемости:
 *   • имя после `class` красится как тип, после `def` — как функция: в тексте
 *     объявление видно с первого взгляда, хотя скобки после имени класса и нет;
 *   • `True`, `False`, `None` — цветом ключевого слова, как в VS Code.
 *
 * Чего нет: выражений внутри f-строк (`f"{x}"` — вся строка одного цвета) и
 * подсветки отступов. Первое — работа для следующего шага, второе — оформление,
 * а не токены.
 */

import { ST_NORMAL, ST_TRIPLE_DOUBLE, ST_TRIPLE_SINGLE, type Grammar, type LineResult } from '../grammar';
import { isDigit, isIdentStart, push, scanIdentifier, scanNumber, scanQuoted, wordSet } from '../scanner';
import { COMMENT, CONTROL, FUNCTION, IDENTIFIER, KEYWORD, NUMBER, STRING, TYPE, type Token } from '../tokens';

const CONTROLS = wordSet([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'with',
  'return',
  'break',
  'continue',
  'pass',
  'raise',
  'yield',
  'await',
  'async',
  'del',
  'global',
  'nonlocal',
  'assert',
  'in',
  'is',
  'not',
  'and',
  'or',
  'lambda',
  'match',
  'case',
]);

const KEYWORDS = wordSet(['as', 'class', 'def', 'from', 'import', 'self', 'cls', 'True', 'False', 'None']);

/** Встроенные имена, которые в VS Code выглядят как типы. */
const TYPES = wordSet([
  'bool',
  'bytearray',
  'bytes',
  'complex',
  'dict',
  'float',
  'frozenset',
  'int',
  'list',
  'memoryview',
  'object',
  'set',
  'str',
  'tuple',
  'type',
  'BaseException',
  'Exception',
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'AttributeError',
  'RuntimeError',
  'NotImplementedError',
  'StopIteration',
]);

/** Буквы префикса строки: `f`, `r`, `b`, `u` в любом порядке и регистре. */
const PREFIX = new Set(['f', 'F', 'r', 'R', 'b', 'B', 'u', 'U']);

/**
 * Начало строкового литерала у позиции `index`: где открывающая кавычка и тройная
 * ли она. `null` — здесь строки нет. Префикс (до трёх букв) входит в строку целиком.
 */
function stringAt(text: string, index: number): { quote: string; at: number; triple: boolean } | null {
  let cursor = index;
  while (cursor < text.length && cursor - index < 3 && PREFIX.has(text[cursor]!)) cursor += 1;
  const quote = text[cursor];
  if (quote !== '"' && quote !== "'") return null;
  const triple = text.startsWith(quote.repeat(3), cursor);
  return { quote, at: cursor, triple };
}

export const pythonGrammar: Grammar = {
  id: 'python',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;

    // Продолжение тройной строки: ищем закрывающую тройку до конца строки.
    if (state === ST_TRIPLE_DOUBLE || state === ST_TRIPLE_SINGLE) {
      const quote = state === ST_TRIPLE_DOUBLE ? '"""' : "'''";
      const close = text.indexOf(quote);
      if (close < 0) {
        push(tokens, 0, text.length, STRING);
        return { tokens, state };
      }
      push(tokens, 0, close + 3, STRING);
      index = close + 3;
      state = ST_NORMAL;
    }

    // Последнее значимое слово строки: по нему узнаём, имя объявляют или используют.
    let previous = '';

    while (index < text.length) {
      const ch = text[index]!;
      if (ch === ' ' || ch === '\t') {
        index += 1;
        continue;
      }
      if (ch === '#') {
        push(tokens, index, text.length, COMMENT);
        break;
      }
      const literal = stringAt(text, index);
      if (literal) {
        if (literal.triple) {
          const close = text.indexOf(literal.quote.repeat(3), literal.at + 3);
          if (close < 0) {
            push(tokens, index, text.length, STRING);
            return { tokens, state: literal.quote === '"' ? ST_TRIPLE_DOUBLE : ST_TRIPLE_SINGLE };
          }
          push(tokens, index, close + 3, STRING);
          index = close + 3;
        } else {
          // Обычная строка не тянется на следующую строку: незакрытая просто кончается.
          const { end } = scanQuoted(text, literal.at, literal.quote);
          push(tokens, index, end, STRING);
          index = end;
        }
        previous = '';
        continue;
      }
      if (isDigit(ch)) {
        const end = scanNumber(text, index);
        push(tokens, index, end, NUMBER);
        index = end;
        previous = '';
        continue;
      }
      // Декоратор: `@staticmethod` — имя, а не оператор.
      if (ch === '@' && isIdentStart(text[index + 1])) {
        const end = scanIdentifier(text, index + 1);
        push(tokens, index, end, IDENTIFIER);
        index = end;
        previous = '';
        continue;
      }
      if (isIdentStart(ch)) {
        const end = scanIdentifier(text, index);
        const word = text.slice(index, end);
        let type: string;
        if (CONTROLS.has(word)) type = CONTROL;
        else if (KEYWORDS.has(word)) type = KEYWORD;
        else if (TYPES.has(word)) type = TYPE;
        else if (previous === 'class') type = TYPE;
        else if (previous === 'def') type = FUNCTION;
        else if (text[end] === '(') type = FUNCTION;
        else type = IDENTIFIER;
        push(tokens, index, end, type);
        previous = word;
        index = end;
        continue;
      }
      index += 1;
    }

    return { tokens, state };
  },
};
