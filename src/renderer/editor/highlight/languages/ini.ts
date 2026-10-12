/**
 * TOML и INI: секции, ключи и значения.
 *
 * Языки разные, но подсветка у них одна и та же и устроена проще некуда: строка в
 * скобках — секция, слово перед знаком «равно» — ключ, остальное — значение. Так
 * читается и `pyproject.toml`, и `.editorconfig`.
 *
 * Комментарии: и решётка, и точка с запятой — в INI она встречается не реже.
 */

import { ST_NORMAL, type Grammar, type LineResult } from '../grammar';
import { isDigit, push, scanQuoted } from '../scanner';
import { ATTRIBUTE, COMMENT, KEYWORD, NUMBER, STRING, TAG, type Token } from '../tokens';

/** Значения, понимаемые как булевы или пустое. */
const LITERALS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off']);

/** Слово перед `=` — ключ; знак `=` отделяет его от значения. */
const KEY = /^\s*([A-Za-z0-9_.\-"']+)\s*=/;

export const iniGrammar: Grammar = {
  id: 'ini',
  line(text: string, _state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;

    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;

    if (text[index] === '#' || text[index] === ';') {
      push(tokens, index, text.length, COMMENT);
      return { tokens, state: ST_NORMAL };
    }

    // Секция: `[section]` или `[[array]]`.
    if (text[index] === '[') {
      const close = text.indexOf(']', index + 1);
      const end = close < 0 ? text.length : close + 1;
      push(tokens, index, end, TAG);
      index = end;
    } else {
      const key = KEY.exec(text);
      if (key) {
        const start = text.indexOf(key[1]!, index);
        push(tokens, start, start + key[1]!.length, ATTRIBUTE);
        index = start + key[1]!.length;
      }
    }

    while (index < text.length) {
      const ch = text[index]!;
      if (ch === ' ' || ch === '\t') {
        index += 1;
        continue;
      }
      if (ch === '#' || ch === ';') {
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
      if (/[A-Za-z]/.test(ch)) {
        let end = index;
        while (end < text.length && /[A-Za-z0-9_-]/.test(text[end]!)) end += 1;
        const word = text.slice(index, end);
        if (LITERALS.has(word.toLowerCase())) push(tokens, index, end, KEYWORD);
        index = end;
        continue;
      }
      index += 1;
    }

    return { tokens, state: ST_NORMAL };
  },
};
