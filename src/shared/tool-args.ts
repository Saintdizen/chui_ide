/**
 * Разбор числовых и логических аргументов инструментов агента.
 *
 * Зачем отдельный модуль: модель присылает аргументы не всегда так, как их
 * описывает схема. Число приходит строкой («2»), флаг — строкой «true», а иногда
 * и вовсе мусором («2.5», «abc»). Раньше такие значения просто отбрасывались как
 * «аргумента нет», и инструмент делал СОВСЕМ ДРУГОЕ, чем просили: `read_file` с
 * `startLine: "2"` читал не вторую строку, а файл целиком. Молчаливый промах хуже
 * громкого отказа: и расход контекста, и ответ не про то.
 *
 * Отсюда правило: разбираем терпимо (строка с числом — это число), но если
 * значение ПРИШЛО и разобрать его нельзя — говорим об этом тому, кто его прислал,
 * а не делаем вид, что аргумента не было.
 *
 * Модуль чистый: ни DOM, ни ФС, ни IPC — только значения.
 */

/** Значение аргумента «не задано»: пустая строка и `null` считаются отсутствием. */
export function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Число из аргумента: принимаем и число, и строку с числом («2» → 2).
 * `undefined` — разобрать не удалось (тогда решает вызывающий: отказать или молчать).
 */
export function numericArg(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Целое из аргумента. Дробное («2.5») — уже не номер строки, отдаём `undefined`. */
export function integerArg(value: unknown): number | undefined {
  const number = numericArg(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

/** Логическое из аргумента: `true`, `"true"`, `1`, `"1"` — всё это «да». */
export function booleanArg(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
  }
  return undefined;
}

/**
 * Значение для сообщения об ошибке. Длинное не тащим: в аргументах бывают и
 * целые наборы правок, и файлы — в отказе же важно, ЧТО именно не подошло.
 */
export function describeValue(value: unknown, limit = 40): string {
  if (value === undefined) return 'ничего';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    return `«${flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat}»`;
  }
  if (typeof value === 'object') return Array.isArray(value) ? 'массив' : 'объект';
  return String(value);
}
