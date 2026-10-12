/**
 * YAML: ключи, значения и комментарии решёткой.
 *
 * Смысл подсветки здесь один: отделить КЛЮЧ от значения. В YAML ключ и значение
 * стоят рядом через двоеточие, и без цвета строка превращается в сплошное полотно —
 * глазами за неё не зацепиться. Поэтому ключ (и ключ в элементе списка `- key:`) —
 * своим цветом, как имя атрибута.
 *
 * Значения разбираем по виду: кавычки — строка, цифры — число, `true`/`false`/
 * `null`/`yes`/`no` — ключевое слово. Остальное оставляем обычным текстом: в YAML
 * значение сплошь и рядом — путь или шаблон, и красить его целиком не стоит.
 */

import { ST_NORMAL, type Grammar, type LineResult } from '../grammar';
import { isDigit, push, scanQuoted } from '../scanner';
import { ATTRIBUTE, COMMENT, KEYWORD, NUMBER, STRING, type Token } from '../tokens';

/** Слова, которые YAML понимает как «истина», «ложь» и «пусто». */
const LITERALS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'True', 'False', 'Null', '~']);

export const yamlGrammar: Grammar = {
  id: 'yaml',
  line(text: string, _state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;

    // Отступ и признак элемента списка пропускаем: `- key: value` — тот же ключ.
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
    if (text[index] === '-' && (text[index + 1] === ' ' || text[index + 1] === undefined)) {
      index += 1;
      while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
    }

    // Комментарий в начале строки — раньше ключа его быть не может.
    if (text[index] === '#') {
      push(tokens, index, text.length, COMMENT);
      return { tokens, state: ST_NORMAL };
    }

    // Ключ: до двоеточия, если двоеточие вообще есть и не внутри кавычек.
    const keyEnd = keyBoundary(text, index);
    if (keyEnd > index) {
      push(tokens, index, keyEnd, ATTRIBUTE);
      index = keyEnd;
      // Двоеточие и пробелы после него — бесцветные.
      while (index < text.length && text[index] !== ' ' && text[index] !== '\t') index += 1;
    }

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
      if (ch === '"' || ch === "'") {
        const { end } = scanQuoted(text, index, ch);
        push(tokens, index, end, STRING);
        index = end;
        continue;
      }
      if (isDigit(ch) || (ch === '-' && isDigit(text[index + 1]))) {
        let end = ch === '-' ? index + 1 : index;
        while (end < text.length && /[0-9._eE+-]/.test(text[end]!)) end += 1;
        push(tokens, index, end, NUMBER);
        index = end;
        continue;
      }
      if (/[A-Za-z~]/.test(ch)) {
        let end = index;
        while (end < text.length && /[A-Za-z0-9_~]/.test(text[end]!)) end += 1;
        const word = text.slice(index, end);
        // Бесцветное слово отдельным токеном не помечаем: разметка без дыр, а
        // лишние «пустые» токены — работа на каждом кадре без всякой пользы.
        if (LITERALS.has(word)) push(tokens, index, end, KEYWORD);
        index = end;
        continue;
      }
      index += 1;
    }

    return { tokens, state: ST_NORMAL };
  },
};

/**
 * Где кончается ключ: позиция двоеточия, за которым идёт пробел или конец строки.
 * `-1` — ключа на этой строке нет. Двоеточие внутри `http://` или в кавычках ключом
 * не считается — это значение вида «ссылка».
 */
function keyBoundary(text: string, start: number): number {
  let index = start;
  if (text[index] === '"' || text[index] === "'") {
    const quote = text[index];
    const close = text.indexOf(quote, index + 1);
    if (close < 0) return -1;
    index = close + 1;
  } else {
    while (index < text.length && !':#{}[]'.includes(text[index]!)) index += 1;
  }
  if (text[index] !== ':') return -1;
  const after = text[index + 1];
  if (after !== undefined && after !== ' ' && after !== '\t') return -1;
  return index;
}
