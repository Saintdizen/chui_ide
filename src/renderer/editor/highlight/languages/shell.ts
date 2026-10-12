/**
 * Shell: команды, комментарии решёткой и переменные.
 *
 * Главное, что делает оболочку узнаваемой, — цвет имени КОМАНДЫ. Оно и красится как
 * функция: первый знак строки и первое слово после разделителя (`;`, `|`, `&&`, `(`)
 * считаются командой, остальные слова — её аргументами. Это не разбор оболочки, а
 * ровно то, что видно в тексте, и этого хватает: `grep`, `-r`, `pattern` читаются
 * правильно без всякого знания о том, что такое `grep`.
 *
 * Переменные (`$HOME`, `${PATH}`, `$1`, `$?`) — своим типом, потому что в палитре у
 * `variable` тот же цвет, что у идентификатора, но правило есть, и значение
 * переменной в тексте выделено ожидаемо.
 *
 * Чего нет: подстановок внутри двойных кавычек (строка целиком одного цвета) и
 * здесь-документов (`<<EOF`) — им нужен свой режим через строки, это следующий шаг.
 */

import type { Grammar, LineResult } from '../grammar';
import { isIdentStart, push, scanIdentifier, wordSet } from '../scanner';
import { COMMENT, CONTROL, FUNCTION, IDENTIFIER, KEYWORD, STRING, VARIABLE, type Token } from '../tokens';

const CONTROLS = wordSet([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'select',
  'function',
  'return',
  'exit',
  'break',
  'continue',
]);

const KEYWORDS = wordSet([
  'local',
  'export',
  'readonly',
  'declare',
  'typeset',
  'source',
  'alias',
  'unalias',
  'unset',
  'set',
  'shift',
  'trap',
  'eval',
  'exec',
  'wait',
  'time',
  'coproc',
  'true',
  'false',
  'test',
  'let',
]);

/** Знаки, после которых начинается новая команда. */
const SEPARATORS = new Set([';', '|', '&', '(', ')', '{', '}', '\n']);

/** Переменная у позиции `index` (начинается с `$`). Возвращает конец или `null`. */
function scanVariable(text: string, index: number): number | null {
  const next = text[index + 1];
  if (next === undefined) return null;
  // `$(...)` и `$((...))` — подстановка команды, не имя переменной.
  if (next === '(') return null;
  // Односимвольные особые: `$?`, `$!`, `$@`, `$*`, `$#`, `$-`, `$$`.
  if ('?!@*#$-'.includes(next)) return index + 2;
  // Позиционные: `$1`, `$2` …
  if (next >= '0' && next <= '9') return index + 2;
  // Именованные: `$HOME`, `${PATH}`.
  if (next === '{') {
    const close = text.indexOf('}', index + 2);
    return close < 0 ? text.length : close + 1;
  }
  if (isIdentStart(next)) return scanIdentifier(text, index + 1);
  return null;
}

export const shellGrammar: Grammar = {
  id: 'shell',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;
    // Стоим ли там, где начинается команда: начало строки — да, после разделителя — да.
    let commandStart = true;

    while (index < text.length) {
      const ch = text[index]!;

      // Решётка — комментарий только в начале слова: `a#b` — часть слова.
      if (ch === '#' && (index === 0 || /\s/.test(text[index - 1]!))) {
        push(tokens, index, text.length, COMMENT);
        break;
      }
      if (ch === ' ' || ch === '\t') {
        index += 1;
        continue;
      }
      if (SEPARATORS.has(ch)) {
        commandStart = true;
        index += 1;
        continue;
      }
      // Одинарные кавычки — буквально до закрывающей, двойные — с обратной косой чертой.
      if (ch === "'" || ch === '"') {
        let cursor = index + 1;
        while (cursor < text.length) {
          if (ch === '"' && text[cursor] === '\\') {
            cursor += 2;
            continue;
          }
          if (text[cursor] === ch) {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        push(tokens, index, Math.min(cursor, text.length), STRING);
        index = cursor;
        commandStart = false;
        continue;
      }
      // Обратные кавычки — подстановка команды; целиком считаем строкой.
      if (ch === '`') {
        const close = text.indexOf('`', index + 1);
        const end = close < 0 ? text.length : close + 1;
        push(tokens, index, end, STRING);
        index = end;
        commandStart = false;
        continue;
      }
      if (ch === '$') {
        const end = scanVariable(text, index);
        if (end !== null) {
          push(tokens, index, end, VARIABLE);
          index = end;
          commandStart = false;
          continue;
        }
        index += 1;
        continue;
      }
      // Слово: буквы, цифры, дефис, точка, слэш — пути и имена опций целиком.
      if (/[\w./-]/.test(ch)) {
        let cursor = index;
        while (cursor < text.length && /[\w./-]/.test(text[cursor]!)) cursor += 1;
        const word = text.slice(index, cursor);
        if (CONTROLS.has(word)) push(tokens, index, cursor, CONTROL);
        else if (KEYWORDS.has(word)) push(tokens, index, cursor, KEYWORD);
        else if (commandStart) push(tokens, index, cursor, FUNCTION);
        else push(tokens, index, cursor, IDENTIFIER);
        index = cursor;
        commandStart = false;
        continue;
      }
      index += 1;
    }

    return { tokens, state };
  },
};
