/**
 * Разбор ответа `textDocument/inlineValue`: значения переменных прямо в коде во время отладки.
 *
 * Пока программа остановлена, сервер (умеющий `inlineValue`) помечает участки строк, где
 * стоит показать значение: справа от имени переменной появляется `x = 42`, у выражения —
 * его результат. Это подсказка СЕРВЕРА о том, ЧТО показать; сами значения берутся у
 * отладчика, и именно поэтому ответ бывает трёх видов:
 *
 *   • текст (`text`) — сервер уже знает, что показать, показываем как есть;
 *   • поиск переменной (`variableName`) — значение просим у отладчика по имени; имени нет —
 *     берём текст участка («x.foo»), а различать ли регистр, подсказывает `caseSensitiveLookup`;
 *   • выражение (`expression`) — отладчик вычисляет выражение; выражения нет — берём текст участка.
 *
 * Модуль чистый: ни сети, ни DOM, ни отладчика. Он только говорит, ЧТО запросить, — а
 * запрос к отладчику делает вызывающий (у него и сессия, и она живая).
 */

/** Как получить значение для участка: готовый текст, поиск переменной или вычисление. */
export type InlineValueAction =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'lookup'; readonly variableName: string; readonly caseSensitive: boolean }
  | { readonly kind: 'evaluate'; readonly expression: string };

/** Значение, которое надо показать в участке строки. Столбцы 1-based, как их видит редактор. */
export interface InlineValue {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly action: InlineValueAction;
}

/**
 * Разобрать ответ `textDocument/inlineValue`. Битые записи пропускаем: без диапазона
 * показать нечего. Формы без данных (`lookup` без имени, `evaluate` без выражения)
 * сохраняем как есть — недостающее подставит вызывающий из текста участка.
 */
export function toInlineValues(raw: unknown): InlineValue[] {
  if (!Array.isArray(raw)) return [];
  const out: InlineValue[] = [];
  for (const item of raw) {
    const value = toInlineValue(item);
    if (value) out.push(value);
  }
  return out;
}

function toInlineValue(raw: unknown): InlineValue | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };
    text?: unknown;
    variableName?: unknown;
    caseSensitiveLookup?: unknown;
    expression?: unknown;
  };
  const start = value.range?.start;
  const end = value.range?.end;
  if (typeof start?.line !== 'number' || typeof start.character !== 'number') return null;
  // Многострочные значения не показываем: подсказка вставляется в строку, а не в блок.
  if (typeof end?.line === 'number' && end.line !== start.line) return null;
  const startColumn = start.character + 1;
  const endColumn = (typeof end?.character === 'number' ? end.character : start.character) + 1;

  const action = actionFor(value);
  return { line: start.line + 1, startColumn, endColumn: Math.max(endColumn, startColumn), action };
}

/** Вид значения: `text` важнее прочих (если он есть, спрашивать отладчик незачем). */
function actionFor(value: {
  text?: unknown;
  variableName?: unknown;
  caseSensitiveLookup?: unknown;
  expression?: unknown;
}): InlineValueAction {
  if (typeof value.text === 'string' && value.text.length > 0) return { kind: 'text', text: value.text };
  // `variableLookup` узнаётся по `caseSensitiveLookup`; имени может и не быть — тогда
  // вызывающий возьмёт имя из текста участка.
  if ('caseSensitiveLookup' in value || typeof value.variableName === 'string') {
    return {
      kind: 'lookup',
      variableName: typeof value.variableName === 'string' ? value.variableName : '',
      caseSensitive: value.caseSensitiveLookup === true,
    };
  }
  // Всё остальное — `evaluatableExpression`; без выражения тоже годится (текст участка).
  return { kind: 'evaluate', expression: typeof value.expression === 'string' ? value.expression : '' };
}

/**
 * Что вычислять, если сервер не назвал выражение или переменную: текст самого участка.
 * Так делают и другие редакторы — сервер помечает `x.foo`, а значение берётся по имени.
 */
export function expressionFor(value: InlineValue, sourceText: string): string {
  if (value.action.kind === 'lookup' && value.action.variableName.length > 0) return value.action.variableName;
  if (value.action.kind === 'evaluate' && value.action.expression.length > 0) return value.action.expression;
  return sourceText;
}

/** Подпись к показу из значения отладчика: `x = 42` (имя и значение). */
export function inlineLabel(expression: string, value: string): string {
  return `${expression} = ${value}`;
}
