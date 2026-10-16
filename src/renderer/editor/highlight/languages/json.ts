/**
 * JSON — и заодно JSONC/JSON5, где разрешены комментарии.
 *
 * Разметка здесь почти не нужна, кроме одной вещи, ради которой её и делают: КЛЮЧ и
 * значение должны различаться. И то и другое — строки в кавычках, а ключи
 * светлее, чем значения. Различаем по знаку после кавычек: если дальше идёт
 * двоеточие, это ключ.
 *
 * Комментарии понимаем намеренно, хотя в строгом JSON их нет: файлы настроек в
 * проекте (файлы настроек инструментов) их сплошь и рядом содержат, и
 * показывать из-за этого строку как мусор было бы хуже, чем понять.
 */

import { ST_BLOCK_COMMENT, ST_NORMAL, type Grammar, type LineResult } from '../grammar';
import { isDigit, push, scanNumber, scanQuoted } from '../scanner';
import { ATTRIBUTE, KEYWORD, NUMBER, STRING, type Token } from '../tokens';

/** Ключевые слова JSON: ровно три, и все — цветом ключевого слова. */
const LITERALS = new Set(['true', 'false', 'null']);

export const jsonGrammar: Grammar = {
  id: 'json',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;

    if (state === ST_BLOCK_COMMENT) {
      const close = text.indexOf('*/');
      if (close < 0) {
        push(tokens, 0, text.length, 'comment');
        return { tokens, state };
      }
      push(tokens, 0, close + 2, 'comment');
      index = close + 2;
      state = ST_NORMAL;
    }

    while (index < text.length) {
      const ch = text[index]!;
      if (ch === ' ' || ch === '\t') {
        index += 1;
        continue;
      }
      if (text.startsWith('//', index)) {
        push(tokens, index, text.length, 'comment');
        break;
      }
      if (text.startsWith('/*', index)) {
        const close = text.indexOf('*/', index + 2);
        if (close < 0) {
          push(tokens, index, text.length, 'comment');
          return { tokens, state: ST_BLOCK_COMMENT };
        }
        push(tokens, index, close + 2, 'comment');
        index = close + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const { end } = scanQuoted(text, index, ch);
        // Ключ отличается от значения только знаком после кавычек.
        let look = end;
        while (look < text.length && (text[look] === ' ' || text[look] === '\t')) look += 1;
        push(tokens, index, end, text[look] === ':' ? ATTRIBUTE : STRING);
        index = end;
        continue;
      }
      if (isDigit(ch) || (ch === '-' && isDigit(text[index + 1]))) {
        const end = scanNumber(text, ch === '-' ? index + 1 : index);
        push(tokens, index, end, NUMBER);
        index = end;
        continue;
      }
      // Литералы `true`/`false`/`null` — буквами, без кавычек.
      if (/[a-z]/.test(ch)) {
        let end = index;
        while (end < text.length && /[a-z]/.test(text[end]!)) end += 1;
        const word = text.slice(index, end);
        if (LITERALS.has(word)) push(tokens, index, end, KEYWORD);
        index = end;
        continue;
      }
      index += 1;
    }

    return { tokens, state };
  },
};
