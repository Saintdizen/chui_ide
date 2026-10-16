/**
 * HTML и XML: теги, атрибуты и значения атрибутов.
 *
 * Разбираются они одинаково, поэтому и грамматика одна. Смысл подсветки здесь —
 * отделить имя тега от имён атрибутов и от их значений: в строке
 * `<a href="…" class="…">` важны все три, и все три разные.
 *
 * Чего нет: переключения на другой язык внутри `<script>` и `<style>`. Это требует
 * подмешивать чужую грамматику по ходу разбора, то есть вкладывать одну подсветку в
 * другую; для нашей задачи (своя подсветка) это следующий шаг, и
 * записан он как долг, а не как «сделано».
 */

import { ST_BLOCK_COMMENT, ST_NORMAL, type Grammar, type LineResult } from '../grammar';
import { push, scanQuoted } from '../scanner';
import { ATTRIBUTE, COMMENT, KEYWORD, STRING, TAG, type Token } from '../tokens';

/** Знаки, из которых состоит имя тега или атрибута (`data-id`, `:class`, `v-if`). */
const NAME_CHAR = /[A-Za-z0-9_:@#.-]/;

export const htmlGrammar: Grammar = {
  id: 'html',
  line(text: string, state: number): LineResult {
    const tokens: Token[] = [];
    let index = 0;

    if (state === ST_BLOCK_COMMENT) {
      const close = text.indexOf('-->');
      if (close < 0) {
        push(tokens, 0, text.length, COMMENT);
        return { tokens, state };
      }
      push(tokens, 0, close + 3, COMMENT);
      index = close + 3;
      state = ST_NORMAL;
    }

    while (index < text.length) {
      const open = text.indexOf('<', index);
      if (open < 0) break;
      index = open;

      if (text.startsWith('<!--', index)) {
        const close = text.indexOf('-->', index + 4);
        if (close < 0) {
          push(tokens, index, text.length, COMMENT);
          return { tokens, state: ST_BLOCK_COMMENT };
        }
        push(tokens, index, close + 3, COMMENT);
        index = close + 3;
        continue;
      }

      // `<!DOCTYPE …>` и `<?xml … ?>` — целая строка одного цвета.
      if (text.startsWith('<!', index) || text.startsWith('<?', index)) {
        const close = text.indexOf('>', index);
        const end = close < 0 ? text.length : close + 1;
        push(tokens, index, end, KEYWORD);
        index = end;
        continue;
      }

      // Имя тега: `<div`, `</div`.
      let cursor = index + 1;
      if (text[cursor] === '/') cursor += 1;
      const nameStart = cursor;
      while (cursor < text.length && NAME_CHAR.test(text[cursor]!)) cursor += 1;
      if (cursor === nameStart) {
        index += 1;
        continue;
      }
      push(tokens, nameStart, cursor, TAG);
      index = cursor;
      state = ST_NORMAL;

      // Атрибуты до закрывающей скобки.
      while (index < text.length && text[index] !== '>') {
        const ch = text[index]!;
        if (ch === ' ' || ch === '\t' || ch === '/' || ch === '=') {
          index += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          const { end } = scanQuoted(text, index, ch);
          push(tokens, index, end, STRING);
          index = end;
          continue;
        }
        if (NAME_CHAR.test(ch)) {
          let end = index;
          while (end < text.length && NAME_CHAR.test(text[end]!)) end += 1;
          push(tokens, index, end, ATTRIBUTE);
          index = end;
          continue;
        }
        index += 1;
      }
      if (text[index] === '>') index += 1;
    }

    return { tokens, state };
  },
};
