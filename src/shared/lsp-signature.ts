/**
 * Разбор ответа языкового сервера на `textDocument/signatureHelp` — подсказка о
 * параметрах вызова.
 *
 * Живёт в `shared`, а не в renderer: это чистое правило над ответом сервера, его
 * стоит закрепить тестом (`tests/lsp-signature.test.ts`). Renderer (карточку и
 * когда её показывать) берёт готовый разбор — как наведение берёт `hoverText`.
 *
 * Из ответа нужны три вещи, и все три бывают «с сюрпризом»:
 *
 *   • ПОДПИСИ. Сервер может вернуть несколько перегрузок; активную он называет
 *     индексом `activeSignature`, но индекс бывает за границами — подрезаем сами.
 *   • АКТИВНЫЙ ПАРАМЕТР. Индекс `activeParameter` тоже бывает за границами списка
 *     параметров; приводим к допустимому или к `-1` (параметров нет).
 *   • ГРАНИЦЫ ПАРАМЕТРА. Метка параметра — это либо строка (подстрока подписи),
 *     либо пара смещений `[start, end]` в подписи. Для карточки нужны смещения:
 *     по ним активный параметр подсвечивается прямо внутри подписи.
 */

/** Параметр: текст и его место в подписи (смещения, оба включительно-исключительно). */
export interface SignatureParameter {
  text: string;
  start: number;
  end: number;
}

/** Одна подпись: строка вызова, документация и параметры с их местами. */
export interface SignatureInfo {
  label: string;
  documentation: string | null;
  parameters: readonly SignatureParameter[];
}

export interface SignatureHelp {
  signatures: readonly SignatureInfo[];
  /** Индекс активной подписи: уже приведён к границам списка. */
  activeSignature: number;
  /** Индекс активного параметра в активной подписи; `-1` — параметров нет. */
  activeParameter: number;
}

/**
 * Разметка из ответа сервера: строка, `MarkupContent` или их массив. Пустое —
 * `null`: карточке нечего показывать, и это не ошибка.
 */
function markupText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.map(markupText).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  if (value && typeof value === 'object') {
    const text = (value as { value?: unknown }).value;
    if (typeof text === 'string') return text.trim() || null;
  }
  return null;
}

/**
 * Место параметра в подписи. Сервер даёт либо `[start, end]`, либо строку —
 * подстроку подписи. Строку ищем от места предыдущего параметра (подписи бывают
 * с повторяющимися именами вроде `f(a, a)`, и первый раз — не всегда тот же).
 */
function parameterRange(label: string, raw: unknown, searchFrom: number): SignatureParameter | null {
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
    const start = Math.max(0, Math.min(raw[0], label.length));
    const end = Math.max(start, Math.min(raw[1], label.length));
    return { text: label.slice(start, end), start, end };
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const found = label.indexOf(raw, searchFrom);
    if (found < 0) return null;
    return { text: raw, start: found, end: found + raw.length };
  }
  return null;
}

/** Собрать параметры подписи в порядке их мест в строке. */
function parametersOf(label: string, raw: unknown): SignatureParameter[] {
  if (!Array.isArray(raw)) return [];
  const result: SignatureParameter[] = [];
  let searchFrom = 0;
  for (const entry of raw) {
    const parameterLabel = entry && typeof entry === 'object' ? (entry as { label?: unknown }).label : entry;
    const range = parameterRange(label, parameterLabel, searchFrom);
    if (!range) continue;
    searchFrom = range.end;
    result.push(range);
  }
  return result;
}

/**
 * Разбор ответа `signatureHelp`. `null` — показывать нечего: сервер молчит, ответ
 * пуст или подписей в нём нет. Индексы приводятся к допустимым здесь, чтобы показа
 * не пришлось спотыкаться о чужие числа.
 */
export function toSignatureHelp(result: unknown): SignatureHelp | null {
  if (!result || typeof result !== 'object') return null;
  const raw = (result as { signatures?: unknown }).signatures;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const signatures: SignatureInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const info = entry as { label?: unknown; documentation?: unknown; parameters?: unknown };
    const label = typeof info.label === 'string' ? info.label : '';
    if (label === '') continue;
    signatures.push({
      label,
      documentation: markupText(info.documentation),
      parameters: parametersOf(label, info.parameters),
    });
  }
  if (signatures.length === 0) return null;

  const activeSignature = clampIndex((result as { activeSignature?: unknown }).activeSignature, signatures.length);
  const parameters = signatures[activeSignature]!.parameters.length;
  const activeParameter =
    parameters === 0 ? -1 : clampIndex((result as { activeParameter?: unknown }).activeParameter, parameters);

  return { signatures, activeSignature, activeParameter };
}

/** Индекс в границах `[0, size-1]`; не число или вне границ — берём первое. */
function clampIndex(value: unknown, size: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.trunc(value), size - 1));
}

/** Часть подписи для карточки: текст и признак «это активный параметр». */
export interface SignaturePart {
  text: string;
  active: boolean;
}

/**
 * Разрезать подпись на части так, чтобы активный параметр был отдельным куском (его
 * и подсветим). Рамки параметров не перекрываем и не выходим за подпись: чужие
 * смещения — не наш повод уронить показ.
 */
export function signatureParts(signature: SignatureInfo, activeParameter: number): SignaturePart[] {
  const label = signature.label;
  const parts: SignaturePart[] = [];
  let cursor = 0;
  for (let index = 0; index < signature.parameters.length; index += 1) {
    const parameter = signature.parameters[index]!;
    const start = Math.max(cursor, Math.min(parameter.start, label.length));
    const end = Math.max(start, Math.min(parameter.end, label.length));
    if (start > cursor) parts.push({ text: label.slice(cursor, start), active: false });
    if (end > start) parts.push({ text: label.slice(start, end), active: index === activeParameter });
    cursor = end;
  }
  if (cursor < label.length) parts.push({ text: label.slice(cursor), active: false });
  return parts.filter((part) => part.text.length > 0);
}

/**
 * Что делать по знаку, набранному перед кареткой. `(` и `,` — спросить подсказку
 * (открыли вызов или перешли к следующему доводу), `)` — закрыть (вызов закончен),
 * остальное подсказку не трогает.
 */
export function signatureTrigger(char: string): 'request' | 'dismiss' | null {
  if (char === '(' || char === ',') return 'request';
  if (char === ')') return 'dismiss';
  return null;
}
