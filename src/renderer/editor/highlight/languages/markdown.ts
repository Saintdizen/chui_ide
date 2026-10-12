/**
 * Markdown: заголовки, код и ссылки.
 *
 * Разметка — текст, в котором разметка и содержимое перемешаны, поэтому и подсветка
 * здесь про то, чтобы отделить одно от другого: заголовок видно сразу, код лежит
 * другим цветом, ссылку не спутать с текстом.
 *
 * Ограждённый блок кода разбирается по строкам: пока он не закрыт, строки внутри —
 * код, а не разметка. Начинать в них свою подсветку по языку из ограждения (` ```js `)
 * мы не будем: это требует вложенной грамматики и переключения разбора на лету, а
 * выгода невелика — блок кода в документации и так отличается фоном рамки.
 */

import { ST_LANGUAGE_BASE, ST_NORMAL, type Grammar, type LineResult } from '../grammar';
import { push } from '../scanner';
import { COMMENT, KEYWORD, STRING, type Token } from '../tokens';

/** Ограждение блока кода: три обратные кавычки или три тильды. */
const FENCE = /^\s{0,3}(```|~~~)/;

/** Заголовок: от одного до шести решёток и пробел после них. */
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;

export const markdownGrammar: Grammar = {
  id: 'markdown',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];

    // Внутри блока кода: следим только за закрывающим ограждением.
    if (state === ST_LANGUAGE_BASE) {
      if (FENCE.test(text)) {
        push(tokens, 0, text.length, STRING);
        return { tokens, state: ST_NORMAL };
      }
      // Строки кода внутри блока оставляем как есть: подсветку языка не подмешиваем.
      return { tokens, state: ST_LANGUAGE_BASE };
    }

    if (FENCE.test(text)) {
      push(tokens, 0, text.length, STRING);
      return { tokens, state: ST_LANGUAGE_BASE };
    }

    if (HEADING.test(text)) {
      push(tokens, 0, text.length, KEYWORD);
      return { tokens, state: ST_NORMAL };
    }

    // Комментарий HTML — единственная разметка, которая в markdown прячет текст.
    const commentStart = text.indexOf('<!--');
    if (commentStart === 0) {
      push(tokens, 0, text.length, COMMENT);
      return { tokens, state: ST_NORMAL };
    }

    let index = 0;
    while (index < text.length) {
      const ch = text[index]!;
      // Код в строке: `` `код` `` — до парной обратной кавычки.
      if (ch === '`') {
        const close = text.indexOf('`', index + 1);
        const end = close < 0 ? text.length : close + 1;
        push(tokens, index, end, STRING);
        index = end;
        continue;
      }
      // Ссылка: `[подпись](адрес)` — подпись цветом ссылки, адрес цветом строки.
      if (ch === '[') {
        const label = text.indexOf(']', index + 1);
        if (label > 0 && text[label + 1] === '(') {
          const url = text.indexOf(')', label + 2);
          if (url > 0) {
            push(tokens, index + 1, label, KEYWORD);
            push(tokens, label + 2, url, STRING);
            index = url + 1;
            continue;
          }
        }
      }
      index += 1;
    }

    return { tokens, state: ST_NORMAL };
  },
};
