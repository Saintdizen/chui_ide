/**
 * Разбор ответа `textDocument/documentColor`: цвета, объявленные в файле.
 *
 * CSS-сервер (и SCSS/LESS) знает, что `#3b82f6` или `rgb(59, 130, 246)` — это цвет, и
 * присылает его вместе с местом: здесь мы приводим ответ к простой форме, а как
 * показать — решает представление (плашка перед значением).
 *
 * Разбор — чистое правило: ни сети, ни DOM. Поэтому его видно в тестах без окна,
 * и он общий с тем, что мог бы читать агент, — как остальные `shared/lsp-*.ts`.
 */

/** Один найденный цвет: где он в тексте (1-based, как у нас) и какой он. */
export interface DocumentColor {
  readonly line: number;
  /** Начало значения — 1-based столбец: плашка рисуется перед этим знаком. */
  readonly column: number;
  /** Цвет в привычном виде `#rrggbb` (с альфой — `#rrggbbaa`). */
  readonly hex: string;
  /** Непрозрачность 0..1: плашка показывает цвет на шахматном фоне, если он не плотный. */
  readonly alpha: number;
}

/**
 * Цвета из ответа сервера. Битые записи и невалидные числа пропускаем: сервер может
 * прислать `NaN` (говорят, у некоторых парсеров бывает), и такой цвет в CSS-строку
 * не собрать — лучше не показать, чем показать чужой.
 */
export function toDocumentColors(raw: unknown): DocumentColor[] {
  if (!Array.isArray(raw)) return [];
  const colors: DocumentColor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { range?: unknown; color?: unknown };
    const range = value.range as { start?: { line?: unknown; character?: unknown } } | undefined;
    const color = value.color as { red?: unknown; green?: unknown; blue?: unknown; alpha?: unknown } | undefined;
    if (!range?.start || !color) continue;
    const { line, character } = range.start;
    if (typeof line !== 'number' || typeof character !== 'number') continue;

    const red = channel(color.red);
    const green = channel(color.green);
    const blue = channel(color.blue);
    if (red === null || green === null || blue === null) continue;

    const alpha = typeof color.alpha === 'number' && Number.isFinite(color.alpha) ? clamp01(color.alpha) : 1;
    colors.push({
      line: line + 1,
      column: character + 1,
      hex: hexOf(red, green, blue, alpha),
      alpha,
    });
  }
  return colors;
}

/** Канал цвета в 0..255. `null` — не число (сервер прислал мусор). */
function channel(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.round(clamp01(raw) * 255);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Цвет в CSS-виде. Альфа приписывается только когда она не полная: `#ff0000` короче и
 * привычнее `#ff0000ff`, а показывать лишние два знака ради очевидного — шум.
 */
function hexOf(red: number, green: number, blue: number, alpha: number): string {
  const base = `#${two(red)}${two(green)}${two(blue)}`;
  return alpha >= 1 ? base : `${base}${two(Math.round(alpha * 255))}`;
}

function two(value: number): string {
  return value.toString(16).padStart(2, '0');
}
