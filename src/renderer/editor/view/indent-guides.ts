/**
 * Направляющие отступов — вертикальные линии на каждом шаге отступа (VS Code, JetBrains).
 *
 * Считаются по тексту строки, а не по дереву блоков: шаг отступа бывает разной ширины
 * (табуляция из настройки или несколько пробелов), а между ними бывают неполные ступени.
 * Потому уровень — это «сколько целых ступеней отступа стоит в начале строки», а линия
 * встаёт на НАЧАЛО каждой ступени, включая первую (столбец 0).
 *
 * Нет отступа — нет линий: иначе вертикальная черта шла бы по всему файлу поверх кода.
 */

export interface IndentGuide {
  /** Смещение линии в пикселях от левого края строки. */
  readonly x: number;
}

export interface IndentOptions {
  /** Ширина шага отступа в столбцах. */
  readonly indentSize: number;
}

/** Строка — только отступ без значащего текста? */
export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * Сколько целых ступеней отступа в начале строки.
 *
 * Табуляция считается за один шаг, как бы широко ни разворачивалась; пробелы —
 * по `indentSize` на ступень. Если в отступе есть табуляции, считаем по ним: смесь
 * двух видов отступа в одном файле — редкость, и ступени по пробелам там уже не совпадут.
 */
export function indentLevels(text: string, options: IndentOptions): number {
  const size = Math.max(1, Math.trunc(options.indentSize));
  let tabs = 0;
  let spaces = 0;
  for (const char of text) {
    if (char === '\t') tabs += 1;
    else if (char === ' ') spaces += 1;
    else break;
  }
  return tabs > 0 ? tabs : Math.floor(spaces / size);
}

/**
 * Линии для строки. `previous` — предыдущая непустая строка: строку без своего отступа
 * (закрывающая скобка) подтягиваем к её глубине — иначе линия уровня обрывалась бы ровно
 * на `}`.
 */
export function indentGuides(
  text: string,
  options: IndentOptions,
  /** Смещения столбцов в пикселях (`layoutLine`) — там, где табуляция шире знака. */
  offsets: readonly number[],
  charWidth: number,
  previous: string | null,
): IndentGuide[] {
  const own = indentLevels(text, options);
  // Своего отступа нет (`}` или пустая строка) — тянемся к глубине предыдущей строки.
  const indented = text.startsWith(' ') || text.startsWith('\t');
  const borrowed = !indented;
  const levels = borrowed ? Math.max(own, previous ? indentLevels(previous, options) : 0) : own;
  if (levels <= 0) return [];

  const size = Math.max(1, Math.trunc(options.indentSize));
  const guides: IndentGuide[] = [];
  // Линия на начале ступени: первый уровень — столбец 0, второй — `size` и т.д.
  for (let level = 0; level < levels; level += 1) {
    const column = level * size;
    // Значащий текст уже начался — линия там перечёркивала бы буквы. Для чужой
    // глубины границы нет: там текст — это `}` или ничего, линия идёт по глубине.
    if (!borrowed && column > text.length) break;
    guides.push({ x: column === 0 ? 0 : (offsets[column] ?? column * charWidth) });
  }
  return guides;
}
