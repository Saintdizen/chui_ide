/**
 * Именованные аргументы: внутри вызова подсказываются имена параметров.
 *
 * У Python аргумент можно передать по имени (`parse(text, strict=True)`), и человек
 * помнит не порядок параметров, а их названия — но не всегда: сигнатуру он видел в
 * другом файле и уже закрыл. Разбор вызова даёт то, что нужно: какие имена у этой
 * функции, какие уже переданы и что набрано сейчас, — и подсказка встаёт в общий
 * список, рядом со словами файла.
 *
 * Откуда берутся имена: из объявления той же функции в открытом файле. Чужой файл без
 * языкового сервера не читается, а выдумывать имена нельзя — подсказка с неверным
 * именем хуже отсутствия подсказки.
 *
 * Ключи объекта (TS) сюда не входят: чтобы их назвать, нужен тип параметра, а модели
 * типов в клиенте нет. Их и отдаёт языковой сервер своим ответом.
 */

import { declarationOf, paramsOf } from './override';
import { matchScore } from './fuzzy';
import type { CompletionItem } from './completions';

/** Где стоит каретка: какой вызов вокруг и что в нём уже набрано. */
export interface CallContext {
  /** Имя вызываемого: `parse` или `self.parse` (по последнему сегменту ищем объявление). */
  readonly callee: string;
  /** Набираемое имя аргумента — оно и отбирает подсказки. */
  readonly typed: string;
  /** Имена, переданные ЯВНО (`strict=True`): их второй раз не предлагают. */
  readonly passed: ReadonlySet<string>;
  /**
   * Сколько доводов передано позиционно. По ним видно, какие параметры уже заняты:
   * `parse(text, ` — это первый параметр, и предлагать его имя поздно.
   */
  readonly positional: number;
}

/** Слова, после которых скобка — не вызов, а управляющая конструкция. */
const NOT_CALLS: ReadonlySet<string> = new Set([
  'if',
  'elif',
  'else',
  'for',
  'while',
  'with',
  'return',
  'assert',
  'lambda',
  'not',
  'and',
  'or',
  'in',
  'is',
  'except',
  'def',
  'class',
  'del',
  'yield',
  'raise',
  'from',
  'import',
]);

/** Знак, продолжающий имя параметра или функции. */
const NAME_CHAR = /[\p{L}\p{Nl}\p{Nd}\p{Pc}_$]/u;

/**
 * Разобрать место под кареткой. `null` — это не аргумент вызова.
 *
 * Идём влево от каретки и ищем открывающую скобку ЭТОГО уровня: внутренние пары
 * пропускаем, иначе `f(g(1), x` дал бы вызов `g`. Имя перед скобкой — вызываемое.
 */
export function callContextAt(text: string, column: number, languageId: string): CallContext | null {
  if (languageId.toLowerCase() !== 'python') return null;
  const at = Math.max(0, Math.min(column, text.length));

  let depth = 0;
  let open = -1;
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    // Закрывающая — значит вошли во вложенную пару: её содержимое не наш уровень.
    if (char === ')' || char === ']' || char === '}') {
      depth += 1;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      if (char === '(') {
        open = index;
        break;
      }
      // Открытая скобка ДРУГОГО вида на нашем уровне — каретка не в аргументах.
      return null;
    }
    if (depth > 0) continue;
    // Конец оператора без скобки: каретка не в аргументах вызова.
    if (char === '\n' || char === ';') return null;
  }
  if (open < 0) return null;

  // Имя перед скобкой: `parse`, `self.parse`. Ничего нет — это не вызов.
  let nameEnd = open;
  while (nameEnd > 0 && (text[nameEnd - 1] === ' ' || text[nameEnd - 1] === '\t')) nameEnd -= 1;
  let nameStart = nameEnd;
  while (nameStart > 0 && (NAME_CHAR.test(text[nameStart - 1]!) || text[nameStart - 1] === '.')) nameStart -= 1;
  const callee = text.slice(nameStart, nameEnd);
  if (callee.length === 0 || callee.endsWith('.')) return null;
  if (NOT_CALLS.has(callee)) return null;

  // Аргументы на этом уровне: делим по запятым, не заходя во вложенные скобки и строки.
  const args = splitArguments(text.slice(open + 1, at));
  const current = args.length > 0 ? args[args.length - 1]! : '';
  // Печатают значение (`strict=|`) — имена тут ни к чему: их место до знака равенства.
  if (current.includes('=')) return null;

  const passed = new Set<string>();
  let positional = 0;
  for (const arg of args.slice(0, -1)) {
    if (arg.trim().length === 0) continue;
    const name = argumentNameOf(arg);
    if (name) passed.add(name);
    else positional += 1;
  }

  const typed = current.trim();
  if (!/^[\p{L}\p{Nl}\p{Nd}\p{Pc}_$]*$/u.test(typed)) return null;
  return { callee, typed, passed, positional };
}

/** Разделить аргументы по запятым верхнего уровня: внутри скобок и строк запятая — не разделитель. */
function splitArguments(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]!;
    if (quote !== null) {
      current += char;
      if (char === '\\') {
        current += inner[index + 1] ?? '';
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Имя переданного аргумента: `strict` и `strict=True` дают `strict`; значение — пусто. */
function argumentNameOf(argument: string): string | null {
  const match = /^\s*([\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\w$]*)\s*=/u.exec(argument);
  return match?.[1] ?? null;
}

/** Имена параметров из строки объявления: без `self`, `*args` и `**kwargs`. */
export function parameterNames(params: string): string[] {
  const names: string[] = [];
  for (const part of params.split(',')) {
    const raw = part.trim();
    // `*` — разделитель именованных, `*args`/`**kwargs` — не именованные аргументы.
    if (raw.length === 0 || raw === '*' || raw.startsWith('*')) continue;
    const name = /^([\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\w$]*)/u.exec(raw)?.[1];
    if (!name || name === 'self' || name === 'cls') continue;
    names.push(name);
  }
  return names;
}

/**
 * Подсказки-аргументы для места под кареткой.
 *
 * `source` — текст открытого файла: объявление вызываемой функции ищется в нём.
 * Нет объявления — нет и подсказок (чужие функции без сервера не разобрать).
 */
export function namedArgumentItems(source: string, context: CallContext): CompletionItem[] {
  const wanted = context.callee.split('.').pop() ?? context.callee;
  const declaration = declarationOf(source, wanted);
  if (!declaration) return [];
  const params = parameterNames(paramsOf(declaration));
  if (params.length === 0) return [];

  const items: CompletionItem[] = [];
  params.forEach((name, index) => {
    // Первые доводы переданы позиционно — их имена уже заняты по порядку.
    if (index < context.positional) return;
    if (context.passed.has(name)) return;
    const match = context.typed.length === 0 ? { score: 0, positions: [] } : matchScore(name, context.typed);
    if (!match) return;
    items.push({
      label: `${name}=`,
      kind: 'word',
      detail: 'параметр',
      insert: `${name}=`,
      positions: match.positions,
    });
  });
  return items;
}
