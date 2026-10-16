/**
 * CSS (и SCSS/Less вместе с ним): селекторы, свойства и значения.
 *
 * Здесь подсветке нужен счётчик фигурных скобок. Вне блока стоит селектор (`.card`),
 * внутри — свойство (`color`) и его значение. Без глубины блока отличить одно от
 * другого нельзя: и там и там слова, разделённые знаками.
 *
 * Глубину держим прямо в состоянии строки, упаковав вместе с признаком «идёт блочный
 * комментарий»: состояние — одно число, а хранить надо две вещи. Признак занимает
 * старший разряд, глубина — младшие; вложенность в тысячу скобок не встретится, а
 * если встретится, подсветка не сломается — просто перестанет видеть комментарий.
 *
 * Разбор идёт тремя ясными случаями, а не общей погоней за знаками: селектор (вне
 * блока), имя свойства (сразу после `{` или `;`) и значение. Так проще читать и
 * проще чинить: у каждого случая видно, где он кончается.
 */

import type { Grammar, LineResult } from '../grammar';
import { isDigit, push, scanQuoted } from '../scanner';
import { ATTRIBUTE, KEYWORD, NUMBER, STRING, TAG, type Token } from '../tokens';

/** Признак незакрытого комментария в упакованном состоянии строки. */
const IN_COMMENT = 1000;

export const cssGrammar: Grammar = {
  id: 'css',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];
    let depth = state % IN_COMMENT;
    let inComment = state >= IN_COMMENT;
    // Сразу после `{` или `;` внутри блока стоит имя свойства, а не значение.
    let expectingProperty = depth > 0;
    let index = 0;

    if (inComment) {
      const close = text.indexOf('*/');
      if (close < 0) {
        push(tokens, 0, text.length, 'comment');
        return { tokens, state: IN_COMMENT + depth };
      }
      push(tokens, 0, close + 2, 'comment');
      index = close + 2;
      inComment = false;
    }

    while (index < text.length) {
      const ch = text[index]!;
      if (ch === ' ' || ch === '\t') {
        index += 1;
        continue;
      }
      if (text.startsWith('/*', index)) {
        const close = text.indexOf('*/', index + 2);
        if (close < 0) {
          push(tokens, index, text.length, 'comment');
          return { tokens, state: IN_COMMENT + depth };
        }
        push(tokens, index, close + 2, 'comment');
        index = close + 2;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        expectingProperty = true;
        index += 1;
        continue;
      }
      if (ch === '}') {
        depth = Math.max(0, depth - 1);
        expectingProperty = depth > 0;
        index += 1;
        continue;
      }
      if (ch === ';' || ch === ',') {
        expectingProperty = depth > 0;
        index += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const { end } = scanQuoted(text, index, ch);
        push(tokens, index, end, STRING);
        index = end;
        continue;
      }
      // Цвет: `#rrggbb` и `#rgb` — числом.
      if (ch === '#' && /[0-9a-fA-F]/.test(text[index + 1] ?? '')) {
        let end = index + 1;
        while (end < text.length && /[0-9a-fA-F]/.test(text[end]!)) end += 1;
        push(tokens, index, end, NUMBER);
        index = end;
        continue;
      }
      if (isDigit(ch) || ((ch === '.' || ch === '-') && isDigit(text[index + 1] ?? ''))) {
        let end = index + (ch === '.' || ch === '-' ? 1 : 0);
        while (end < text.length && /[0-9.]/.test(text[end]!)) end += 1;
        while (end < text.length && /[a-z%]/.test(text[end]!)) end += 1; // единицы: px, em, %
        push(tokens, index, end, NUMBER);
        index = end;
        continue;
      }
      // `@media`, `@import`, `!important` — ключевые слова.
      if (ch === '@' || ch === '!') {
        let end = index + 1;
        while (end < text.length && /[A-Za-z-]/.test(text[end]!)) end += 1;
        if (end > index + 1) {
          push(tokens, index, end, KEYWORD);
          index = end;
          continue;
        }
        index += 1;
        continue;
      }
      // Имя свойства внутри блока — но перед ним может стоять и вложенный селектор
      // (`@media { .a { … } }`). Различаем по знаку: до двоеточия — свойство, до
      // фигурной скобки — селектор.
      if (depth > 0 && expectingProperty) {
        let end = index;
        while (end < text.length && !':;{}'.includes(text[end]!)) end += 1;
        const name = text.slice(index, end).trimEnd();
        if (text[end] === '{') {
          if (name.length > 0) push(tokens, index, index + name.length, TAG);
          index = end;
          continue;
        }
        if (name.length > 0) push(tokens, index, index + name.length, ATTRIBUTE);
        index = end;
        if (text[index] === ':') index += 1;
        expectingProperty = false;
        continue;
      }
      // Селектор — вне блока: до `{`, `,` или `;`.
      if (depth === 0) {
        let end = index;
        while (end < text.length && !'{},;'.includes(text[end]!)) end += 1;
        const selector = text.slice(index, end).trimEnd();
        if (selector.length > 0) push(tokens, index, index + selector.length, TAG);
        index = end;
        continue;
      }
      // Значение внутри блока: имена (`flex`, `none`) оставляем без цвета.
      let end = index;
      while (end < text.length && !';}{'.includes(text[end]!)) end += 1;
      index = end > index ? end : index + 1;
    }

    return { tokens, state: (inComment ? IN_COMMENT : 0) + depth };
  },
};
