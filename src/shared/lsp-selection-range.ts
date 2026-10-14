/**
 * Разбор ответа `textDocument/selectionRange`: цепочка участков вокруг места, от самого
 * узкого к самому широкому.
 *
 * За этим запросом стоит обычное «выделить шире»: курсор внутри `user.name`, нажал раз —
 * выделилось слово `name`, ещё раз — `user.name`, потом всё выражение, строка, блок,
 * функция. Сервер уже знает дерево разбора, поэтому цепочка приходит готовой: узкая
 * запись — `range`, её родитель — `parent`, и так до самого широкого участка файла.
 *
 * Модуль чистый: ни сети, ни DOM. Здесь только две вещи — развернуть цепочку родителей
 * в плоский список и выбрать из него соседний участок по направлению. Оба правила
 * проверяются юнит-тестами без окна; редактор их лишь применяет к выделению.
 *
 * Позиции переводим в 1-based: так их видит редактор (`Position` буфера). Один перевод
 * здесь, а не у каждого вызова, — иначе 0-based LSP просочилось бы в показ.
 */

/** Участок текста: строки и столбцы (1-based), столбец конца — исключающий. */
export interface SelectionSpan {
  /** Начальная строка (1-based). */
  readonly startLine: number;
  /** Столбец начала (1-based, включительно). */
  readonly startColumn: number;
  /** Конечная строка (1-based). */
  readonly endLine: number;
  /** Столбец конца (1-based, исключительно). */
  readonly endColumn: number;
}

/** Куда шагнуть: шире (в родителя) или уже (во вложенного потомка). */
export type SelectionStep = 'expand' | 'shrink';

/**
 * Цепочка участков из ответа сервера, от узкого к широкому.
 *
 * Ответ — массив по числу запрошенных мест; мы спрашиваем одно, поэтому берём первый
 * элемент и идём по его `parent` вверх. Повторы подряд (иногда сервер отдаёт одну и ту
 * же границу дважды) и битые записи пропускаем: у участка обязана быть начало раньше
 * конца, иначе выбирать его незачем.
 */
export function toSelectionSpans(raw: unknown): SelectionSpan[] {
  if (!Array.isArray(raw)) return [];
  const first = raw[0];
  if (!first || typeof first !== 'object') return [];

  const spans: SelectionSpan[] = [];
  const seen = new Set<string>();
  let node: unknown = first;
  while (node && typeof node === 'object') {
    const span = toSpan((node as { range?: unknown }).range);
    if (span) {
      const key = spanKey(span);
      // Повтор границы подряд смысла не несёт — оставляем один участок.
      if (!seen.has(key)) {
        seen.add(key);
        spans.push(span);
      }
    }
    node = (node as { parent?: unknown }).parent;
  }
  return spans;
}

function toSpan(raw: unknown): SelectionSpan | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    start?: { line?: unknown; character?: unknown };
    end?: { line?: unknown; character?: unknown };
  };
  const start = value.start;
  const end = value.end;
  if (typeof start?.line !== 'number' || typeof start.character !== 'number') return null;
  if (typeof end?.line !== 'number' || typeof end.character !== 'number') return null;
  const span: SelectionSpan = {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
  // Пустой и перевёрнутый участок не выбираем: выбирать нечего.
  if (comparePositions(span.startLine, span.startColumn, span.endLine, span.endColumn) >= 0) return null;
  return span;
}

function spanKey(span: SelectionSpan): string {
  return `${span.startLine}:${span.startColumn}:${span.endLine}:${span.endColumn}`;
}

/** Сравнение двух позиций «строка, столбец»: −1 раньше, 0 совпадают, 1 позже. */
function comparePositions(line1: number, column1: number, line2: number, column2: number): number {
  if (line1 !== line2) return line1 < line2 ? -1 : 1;
  if (column1 !== column2) return column1 < column2 ? -1 : 1;
  return 0;
}

/** Тот же участок — по всем четырём границам. */
function sameSpan(a: SelectionSpan, b: SelectionSpan): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

/** `inner` целиком внутри `outer` (включая совпадение границ). */
function containsSpan(outer: SelectionSpan, inner: SelectionSpan): boolean {
  const startsBefore = comparePositions(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) <= 0;
  const endsAfter = comparePositions(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn) >= 0;
  return startsBefore && endsAfter;
}

/**
 * Соседний участок по направлению.
 *
 * `current` — то, что выделено сейчас (`null` — одна каретка, ничего не выделено).
 * Наружу берём ПЕРВЫЙ участок, который строго шире текущего: это ближайший родитель.
 * Внутрь — ПОСЛЕДНИЙ, который строго уже: ближайший потомок. Нет подходящего —
 * `null`: шире уже некуда, а уже нечего (вызывающий тогда сворачивает выделение к каретке).
 *
 * Правило не хранит состояние: и «шире», и «уже» считаются от текущего выделения и
 * свежей цепочки. Поэтому редактору не нужно помнить, на каком шаге он остановился.
 */
export function stepSelection(
  spans: readonly SelectionSpan[],
  current: SelectionSpan | null,
  step: SelectionStep,
): SelectionSpan | null {
  if (step === 'expand') {
    if (!current) return spans[0] ?? null;
    for (const span of spans) {
      if (!sameSpan(span, current) && containsSpan(span, current)) return span;
    }
    return null;
  }

  if (!current) return null;
  let found: SelectionSpan | null = null;
  for (const span of spans) {
    if (!sameSpan(span, current) && containsSpan(current, span)) found = span;
  }
  return found;
}
