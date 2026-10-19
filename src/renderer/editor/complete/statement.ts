/**
 * «Завершить текущий оператор»: дописать то, чего не хватает строке, и перейти дальше.
 *
 * Человек набирает `if order.total > 0` и останавливается: двоеточие, перевод строки и
 * отступ — механика, а не мысль. В больших IDE это отдельное действие (Complete Current
 * Statement): оно закрывает открытые скобки, ставит двоеточие у заголовка блока Python,
 * точку с запятой у оператора JS и переносит каретку на новую строку.
 *
 * Правила здесь, а не в редакторе: решать приходится по тексту строки (что открыто, чем
 * кончилось, что за язык), и каждое решение проверяется без окна. Редактор только
 * применяет готовую вставку.
 */

/** Что вставить в месте каретки и где после этого оказаться (смещение внутри вставки). */
export interface StatementCompletion {
  /** Текст вставки. */
  readonly insert: string;
  /** Где встанет курсор: смещение от начала вставки. Не задано — в конце. */
  readonly caret?: number;
}

/** Языки, у которых есть что завершать: свои правила у Python и у JS/TS. */
export function canCompleteStatement(languageId: string): boolean {
  const language = languageId.toLowerCase();
  return language === 'python' || language === 'typescript' || language === 'javascript';
}

/** Ключевые слова Python, после которых идёт блок и нужно двоеточие. */
const PYTHON_BLOCKS: ReadonlySet<string> = new Set([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'def',
  'class',
  'with',
  'try',
  'except',
  'finally',
  'match',
  'case',
  'async',
]);

/** Заголовки JS/TS, после которых идёт блок в фигурных скобках. */
const SCRIPT_HEADS: readonly string[] = ['if', 'for', 'while', 'switch', 'catch', 'with'];

/**
 * Что дописать. `null` — дописывать нечего: строка уже закончена или это не оператор
 * (комментарий, пустая строка, хвост уже набранного кода после каретки).
 *
 * `indentUnit` — чем делается отступ (`'    '` или `'\t'`): шаг берётся из настроек,
 * а не угадывается.
 */
export function completeStatement(
  text: string,
  caret: number,
  languageId: string,
  indentUnit = '    ',
): StatementCompletion | null {
  if (!canCompleteStatement(languageId)) return null;
  const at = Math.max(0, Math.min(caret, text.length));

  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = text.indexOf('\n', at);
  const line = text.slice(lineStart, at);
  const rest = text.slice(at, lineEnd < 0 ? text.length : lineEnd);
  const trimmed = line.trim();

  // После каретки уже стоит код — это не конец оператора, и дописывать в середину нельзя.
  if (rest.trim().length > 0) return null;
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  const indent = leadingIndent(line);
  const language = languageId.toLowerCase();

  // Открытая с конца фигурная скобка — не «забытая», а начало блока: переходим внутрь.
  // Это проверяется до закрытия скобок, иначе `function f() {` получило бы `}` подряд.
  if (language !== 'python' && trimmed.endsWith('{')) return { insert: `\n${indent}${indentUnit}` };

  // Открытые скобки закрываются следующими: пока они не закрыты, строка — не оператор.
  const missing = unclosedBrackets(line);
  if (missing.length > 0) return { insert: missing };

  if (language === 'python') {
    const head = /^(?:async\s+)?([\w]+)/.exec(trimmed)?.[1] ?? '';
    if (!PYTHON_BLOCKS.has(head)) return null;
    // Заголовок уже с двоеточием — остаётся перейти в тело блока.
    if (trimmed.endsWith(':')) return { insert: `\n${indent}${indentUnit}` };
    return { insert: `:\n${indent}${indentUnit}` };
  }

  // Заголовок с блоком: `if (x)` превращается в `if (x) { … }`, а не в `if (x);`.
  const head = /^([\w]+)\s*\(/.exec(trimmed)?.[1] ?? '';
  if (SCRIPT_HEADS.includes(head) && trimmed.endsWith(')')) {
    const body = `${indent}${indentUnit}`;
    return { insert: ` {\n${body}\n${indent}}`, caret: ` {\n${body}`.length };
  }

  // Обычный оператор: точка с запятой (если её ещё нет) и новая строка с тем же отступом.
  if (/[;{}:,]$/.test(trimmed)) return null;
  return { insert: `;\n${indent}` };
}

/** Отступ строки: пробелы и табуляции слева. */
function leadingIndent(line: string): string {
  return /^[\t ]*/.exec(line)?.[0] ?? '';
}

/**
 * Какие скобки остались открытыми — в виде закрывающих, в порядке закрытия.
 *
 * Строки и комментарии пропускаются: `if (name == ")"` открывает скобку, а не закрывает
 * её, и без этого правила вставка ломала бы код. Вложенность разбирается по стеку —
 * `f(g(x))` требует `))`, а не `)`.
 */
function unclosedBrackets(line: string): string {
  const closers: string[] = [];
  let quote: string | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '#') break;
    if (char === '/' && line[index + 1] === '/') break;
    if (char === '(') closers.push(')');
    else if (char === '[') closers.push(']');
    else if (char === '{') closers.push('}');
    else if (char === ')' || char === ']' || char === '}') {
      if (closers[closers.length - 1] === char) closers.pop();
    }
  }

  return closers.reverse().join('');
}
