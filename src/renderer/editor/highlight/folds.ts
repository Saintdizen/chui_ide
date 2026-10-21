/**
 * Свёртка по грамматике: блоки по скобкам, многострочные комментарии и строки.
 *
 * Языковой сервер знает про блоки лучше нас, но его может не быть — а свернуть код
 * хочется всегда. Свернуть по отступам (`indentFoldRanges`) получается не везде:
 * в C-подобном коде скобка блока часто стоит в конце строки, а следующая строка — с
 * тем же отступом, и по отступам блока не видно. Зато его видно по СКОБКАМ, а что
 * скобка — код, а не буква в строке, знает грамматика подсветки: она уже разбирает
 * текст, отличая строки и комментарии от кода.
 *
 * Поэтому здесь два источника, и оба — из той же грамматики, что красит текст:
 *
 *   • ПАРЫ СКОБОК `{}`, `()`, `[]`. Пара на разных строках — блок от строки
 *     открывающей скобки до строки закрывающей. Скобки внутри строк и комментариев
 *     не считаем: `"{"` — это текст, а не начало блока;
 *   • МНОГОСТРОЧНЫЕ КОНСТРУКЦИИ: пока строка начинается не в обычном режиме
 *     грамматики, она внутри чего-то, что тянется на строки, — блочного комментария
 *     (`/* … *​/`), тройной строки (`"""`), шаблона (`` ` ``). Такую конструкцию
 *     тоже можно сложить, и грамматика говорит это сама своим состоянием, без наших
 *     догадок о языке.
 *
 * Отступы остаются третьим источником и складываются с этим (`mergeFoldRanges`):
 * скобки накрывают C-подобный код, отступы — всё, что блоками по скобкам не описано
 * (Python, YAML, тексты). Модуль чистый — ни DOM, ни сети, — поэтому проверяется
 * тестами без окна.
 */

import { mergeFoldRanges, type FoldRange } from '../../../shared/fold-ranges';
import { ST_NORMAL, type Grammar } from './grammar';
import { COMMENT, STRING } from './tokens';

/**
 * Предел числа строк: выше него свёртку по грамматике не считаем вовсе. Без сервера
 * останутся отступы — этого довольно, а полный разбор файла в сотни тысяч строк на
 * каждую правку того не стоит.
 */
export const MAX_SEMANTIC_FOLD_LINES = 50_000;

/** Открывающая скобка — закрывающей. */
const CLOSERS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/** Сколько строк многострочная конструкция занимает, чтобы её стоило складывать. */
export interface SemanticFoldOptions {
  /** Предел числа строк (для тестов и переопределения): выше — пусто. */
  maxLines?: number;
}

/**
 * Диапазоны свёртки по готовой грамматике. Языка без грамматики это не смущает:
 * текста по скобкам не сворачиваем (неизвестно, что скобка, а что буква) — вернём пусто.
 *
 * Грамматику передаёт вызывающий: реестр грузится по требованию (`grammarFor` в
 * `core/highlight`), и держать здесь статический импорт значило бы вернуть все
 * 34 языка в первый чанк — ради свёртки, которую чат не спрашивает.
 */
export function semanticFoldRanges(
  grammar: Grammar | null,
  text: string,
  options: SemanticFoldOptions = {},
): FoldRange[] {
  if (!grammar) return [];
  return foldRangesWithGrammar(grammar, text, options);
}

/**
 * То же по готовой грамматике — когда она уже на руках (`await` реестра снаружи).
 */
export function foldRangesWithGrammar(grammar: Grammar, text: string, options: SemanticFoldOptions = {}): FoldRange[] {
  const maxLines = options.maxLines ?? MAX_SEMANTIC_FOLD_LINES;
  const lines = text.split('\n');
  if (lines.length > maxLines) return [];
  return grammarFoldRanges(grammar, lines);
}

/**
 * Разбор для готовой грамматики. Отдельной функцией — чтобы её было видно в тестах
 * с любой грамматикой, не выискивая файл нужного языка.
 */
export function grammarFoldRanges(grammar: Grammar, lines: readonly string[]): FoldRange[] {
  const ranges: FoldRange[] = [];
  /** Стек открытых скобок: знак, строка (с нуля) и место — по месту ищем пару. */
  const open: Array<{ char: string; line: number }> = [];
  /** Строка, где началась многострочная конструкция (−1 — никакой). */
  let regionStart = -1;
  let state = ST_NORMAL;

  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!;
    const result = grammar.line(text, state);

    // Многострочная конструкция: началась на этой строке или тянется дальше.
    if (result.state !== ST_NORMAL) {
      if (regionStart < 0) regionStart = line;
    } else if (regionStart >= 0) {
      // Конструкция закрылась: если она длиннее строки — есть что складывать.
      if (line > regionStart) ranges.push({ startLine: regionStart + 1, endLine: line + 1 });
      regionStart = -1;
    }

    // Скобки: считаем только те, что в коде, — внутри строк и комментариев они текст.
    const ignored = ignoredSpans(text, result.tokens);
    for (let column = 0; column < text.length; column += 1) {
      if (ignored[column]) continue;
      const char = text[column]!;
      if (CLOSERS[char] !== undefined) {
        open.push({ char, line });
        continue;
      }
      if (char !== '}' && char !== ')' && char !== ']') continue;
      // Закрывающая скобка закрывает только свою пару; чужая на стеке — игнорируем
      // (битый код): искать «похожую» ниже значило бы соединять разные блоки.
      const top = open[open.length - 1];
      if (!top || CLOSERS[top.char] !== char) continue;
      open.pop();
      if (line > top.line) ranges.push({ startLine: top.line + 1, endLine: line + 1 });
    }

    state = result.state;
  }

  return mergeFoldRanges(ranges);
}

/** Карта «знак пропустить»: единица на позициях внутри строк и комментариев. */
function ignoredSpans(text: string, tokens: readonly { start: number; end: number; type: string }[]): Uint8Array {
  const ignored = new Uint8Array(text.length);
  for (const token of tokens) {
    if (token.type !== STRING && token.type !== COMMENT) continue;
    const from = Math.max(0, token.start);
    const to = Math.min(text.length, token.end);
    for (let index = from; index < to; index += 1) ignored[index] = 1;
  }
  return ignored;
}
