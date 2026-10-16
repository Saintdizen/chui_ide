/**
 * SQL: ключевые слова без учёта регистра, строки в одинарных кавычках.
 *
 * Единственная тонкость — регистр: `select`, `SELECT` и `Select` — одно и то же, а
 * таблица слов записана в нижнем регистре. Поэтому слово перед проверкой приводим к
 * нижнему регистру, а красим как есть в тексте.
 *
 * Имена в кавычках (`"users"`, `` `users` ``) считаем идентификаторами: это ровно то,
 * чем они и являются, — именами, которые человек взял в кавычки, чтобы не спорить с
 * регистром и зарезервированными словами.
 */

import { ST_BLOCK_COMMENT, ST_NORMAL, type Grammar, type LineResult } from '../grammar';
import { isDigit, isIdentStart, push, scanIdentifier, scanNumber, wordSet } from '../scanner';
import { COMMENT, IDENTIFIER, KEYWORD, NUMBER, STRING, TYPE, VARIABLE, type Token } from '../tokens';

const KEYWORDS = wordSet([
  'add',
  'all',
  'alter',
  'and',
  'any',
  'as',
  'asc',
  'begin',
  'between',
  'by',
  'cascade',
  'case',
  'commit',
  'constraint',
  'create',
  'cross',
  'default',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'except',
  'exists',
  'explain',
  'foreign',
  'from',
  'full',
  'grant',
  'group',
  'having',
  'if',
  'in',
  'index',
  'inner',
  'insert',
  'intersect',
  'into',
  'is',
  'join',
  'key',
  'left',
  'like',
  'limit',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'references',
  'returning',
  'revoke',
  'right',
  'rollback',
  'select',
  'set',
  'table',
  'then',
  'transaction',
  'union',
  'unique',
  'update',
  'using',
  'values',
  'view',
  'when',
  'where',
  'with',
]);

/** Типы столбцов — тот же синий, что и у ключевых слов, но роль иная. */
const TYPES = wordSet([
  'bigint',
  'bigserial',
  'blob',
  'bool',
  'boolean',
  'bytea',
  'char',
  'clob',
  'date',
  'decimal',
  'double',
  'float',
  'int',
  'integer',
  'json',
  'jsonb',
  'numeric',
  'precision',
  'real',
  'serial',
  'smallint',
  'text',
  'time',
  'timestamp',
  'timestamptz',
  'uuid',
  'varchar',
]);

export const sqlGrammar: Grammar = {
  id: 'sql',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;

    if (state === ST_BLOCK_COMMENT) {
      const close = text.indexOf('*/');
      if (close < 0) {
        push(tokens, 0, text.length, COMMENT);
        return { tokens, state };
      }
      push(tokens, 0, close + 2, COMMENT);
      index = close + 2;
      state = ST_NORMAL;
    }

    while (index < text.length) {
      const ch = text[index]!;
      if (ch === ' ' || ch === '\t') {
        index += 1;
        continue;
      }
      if (text.startsWith('--', index)) {
        push(tokens, index, text.length, COMMENT);
        break;
      }
      if (text.startsWith('/*', index)) {
        const close = text.indexOf('*/', index + 2);
        if (close < 0) {
          push(tokens, index, text.length, COMMENT);
          return { tokens, state: ST_BLOCK_COMMENT };
        }
        push(tokens, index, close + 2, COMMENT);
        index = close + 2;
        continue;
      }
      // Строка: `''` внутри — экранированная кавычка, а не конец строки.
      if (ch === "'") {
        let cursor = index + 1;
        while (cursor < text.length) {
          if (text[cursor] === "'") {
            if (text[cursor + 1] === "'") {
              cursor += 2;
              continue;
            }
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        push(tokens, index, Math.min(cursor, text.length), STRING);
        index = cursor;
        continue;
      }
      // Имя в кавычках — идентификатор.
      if (ch === '"' || ch === '`') {
        const close = text.indexOf(ch, index + 1);
        const end = close < 0 ? text.length : close + 1;
        push(tokens, index, end, IDENTIFIER);
        index = end;
        continue;
      }
      // Параметр: `:name`, `@name`, `?`, `$1`.
      if (ch === '?' || ch === '$') {
        push(tokens, index, index + 1, VARIABLE);
        index += 1;
        continue;
      }
      if ((ch === ':' || ch === '@') && isIdentStart(text[index + 1])) {
        const end = scanIdentifier(text, index + 1);
        push(tokens, index, end, VARIABLE);
        index = end;
        continue;
      }
      if (isDigit(ch)) {
        const end = scanNumber(text, index);
        push(tokens, index, end, NUMBER);
        index = end;
        continue;
      }
      if (isIdentStart(ch)) {
        const end = scanIdentifier(text, index);
        const word = text.slice(index, end);
        const lower = word.toLowerCase();
        if (KEYWORDS.has(lower)) push(tokens, index, end, KEYWORD);
        else if (TYPES.has(lower)) push(tokens, index, end, TYPE);
        else push(tokens, index, end, IDENTIFIER);
        index = end;
        continue;
      }
      index += 1;
    }

    return { tokens, state };
  },
};
