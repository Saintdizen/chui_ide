/**
 * Postfix-шаблоны: `выражение.if` превращается в `if выражение:`.
 *
 * Приём из больших IDE: частый оборот пишется вокруг уже набранного выражения, а не
 * заново. Набрал `order.if` — получил `if order:`; набрал `items.for` — получил цикл по
 * `items`. Без этого человек либо пишет оборот сначала и тащит выражение внутрь, либо
 * копирует его — и то и другое лишняя работа, которую видно по коду.
 *
 * Здесь только правила: какие шаблоны есть у языка, как найти выражение перед точкой и
 * что встанет вместо него. Куда поставить курсор и как применить правку — дело
 * редактора (`assistant.ts`). Поэтому модуль чистый и проверяется без окна.
 */

import { matchScore } from './fuzzy';

/** Один шаблон: слово после точки и тело, в которое встанет выражение. */
export interface PostfixTemplate {
  /** Что набирают после точки: `if`, `for`. */
  readonly key: string;
  /** Что получится — коротко, для списка подсказок (`if expr:`). */
  readonly detail: string;
  /**
   * Тело с разметкой: `$EXPR` — место выражения, `$0` — где встанет курсор после
   * подстановки. Разметка та же, что у сниппетов, и разбирается тем же способом.
   */
  readonly body: string;
}

/** Общие шаблоны Python: обороты, которые пишут чаще всего. */
const PYTHON_TEMPLATES: readonly PostfixTemplate[] = [
  { key: 'if', detail: 'if expr:', body: 'if $EXPR:\n    $0' },
  { key: 'not', detail: 'if not expr:', body: 'if not $EXPR:\n    $0' },
  { key: 'notnull', detail: 'if expr is not None:', body: 'if $EXPR is not None:\n    $0' },
  { key: 'for', detail: 'for item in expr:', body: 'for item in $EXPR:\n    $0' },
  { key: 'ret', detail: 'return expr', body: 'return $EXPR' },
  { key: 'var', detail: 'имя = expr', body: '$0 = $EXPR' },
];

/** То же для JS/TS: фигурные скобки и точка с запятой — как принято в языке. */
const SCRIPT_TEMPLATES: readonly PostfixTemplate[] = [
  { key: 'if', detail: 'if (expr) { }', body: 'if ($EXPR) {\n  $0\n}' },
  { key: 'notnull', detail: 'if (expr != null) { }', body: 'if ($EXPR != null) {\n  $0\n}' },
  { key: 'log', detail: 'console.log(expr)', body: 'console.log($EXPR);' },
  { key: 'ret', detail: 'return expr', body: 'return $EXPR;' },
  { key: 'const', detail: 'const имя = expr', body: 'const $0 = $EXPR;' },
];

/** Шаблоны языка. Пусто — у языка их нет, и подсказка не появляется вовсе. */
export function postfixTemplates(languageId: string): readonly PostfixTemplate[] {
  const language = languageId.toLowerCase();
  if (language === 'python') return PYTHON_TEMPLATES;
  if (language === 'typescript' || language === 'javascript') return SCRIPT_TEMPLATES;
  return [];
}

/** Выражение перед точкой: где оно начинается и что это за выражение. */
export interface PostfixMatch {
  /** Начало выражения — абсолютное смещение в документе: с него идёт замена. */
  readonly from: number;
  /** Само выражение: `order`, `self.items[0]`. */
  readonly expression: string;
  /** Набранное после точки — по нему отбираются шаблоны. */
  readonly prefix: string;
}

/** Знак, продолжающий имя: по нему читается слово. */
const WORD_CHAR = /[\p{L}\p{Nl}\p{Nd}_$]/u;

/**
 * Найти выражение перед точкой. `null` — каретка не в postfix-месте.
 *
 * Читаем влево: сначала слово (что набрано после точки), потом саму точку, потом
 * выражение — имя с цепочкой обращений и вызовов (`self.items[0].first`). Скобки
 * считаем парными: без этого `f(a.b)` дало бы выражение `f(a.b`, и шаблон сломался бы.
 */
export function postfixAt(text: string, column: number, lineStart: number, languageId: string): PostfixMatch | null {
  if (postfixTemplates(languageId).length === 0) return null;
  const at = Math.max(0, Math.min(column, text.length));

  let cursor = at;
  while (cursor > 0 && WORD_CHAR.test(text[cursor - 1]!)) cursor -= 1;
  const prefix = text.slice(cursor, at);
  // Точка обязательна, и вплотную: `order . if` — это не postfix, а два оборота.
  if (cursor === 0 || text[cursor - 1] !== '.') return null;
  // Слово после точки тоже обязательно: на голой точке попап не нужен.
  if (prefix.length === 0) return null;

  const end = cursor - 1;
  let start = end;
  let depth = 0;
  while (start > 0) {
    const char = text[start - 1]!;
    if (char === ')' || char === ']' || char === '}') {
      depth += 1;
      start -= 1;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      if (depth === 0) break;
      depth -= 1;
      start -= 1;
      continue;
    }
    if (depth > 0) {
      start -= 1;
      continue;
    }
    if (WORD_CHAR.test(char) || char === '.') {
      start -= 1;
      continue;
    }
    break;
  }

  const expression = text.slice(start, end);
  if (expression.trim().length === 0) return null;
  // Выражение не должно начинаться с точки — тогда это не выражение, а мусор.
  if (expression.startsWith('.')) return null;
  return { from: lineStart + start, expression, prefix };
}

/** Развёрнутый шаблон: текст и место курсора в нём (смещение от начала текста). */
export interface ExpandedPostfix {
  readonly text: string;
  readonly caret: number;
}

/** Подставить выражение в тело шаблона и найти место курсора. */
export function expandPostfix(template: PostfixTemplate, expression: string): ExpandedPostfix {
  const body = template.body.split('$EXPR').join(expression);
  const caret = body.indexOf('$0');
  if (caret < 0) return { text: body, caret: body.length };
  return { text: body.slice(0, caret) + body.slice(caret + 2), caret };
}

/** Подходящие шаблоны по набранному после точки: чем точнее совпадение, тем выше. */
export function postfixOffers(match: PostfixMatch, languageId: string): PostfixTemplate[] {
  // Пустое набранное — не повод открывать список шаблонов: он вылезал бы на каждой точке.
  if (match.prefix.length === 0) return [];
  const scored: { template: PostfixTemplate; score: number }[] = [];
  for (const template of postfixTemplates(languageId)) {
    const found = matchScore(template.key, match.prefix);
    if (!found) continue;
    scored.push({ template, score: found.score });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored.map((entry) => entry.template);
}
