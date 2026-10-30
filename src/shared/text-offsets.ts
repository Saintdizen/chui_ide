/**
 * Смещения в тексте для мест, которые сервер отдал строками и столбцами.
 *
 * Сервер и мы считаем одинаково (с единицы), а буфер живёт смещениями: перевод
 * нужен один и тот же везде, где ответ LSP становится подсветкой. Столбцы у сервера
 * — в UTF-16, как и у нас в JS-строке, так что просто сумма длин строк.
 */
export function offsetsAt(
  text: string,
  places: readonly { line: number; column: number; endColumn: number }[],
): { start: number; end: number }[] {
  if (places.length === 0) return [];
  // Начала строк — один проход, а не `split` на каждое место.
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }

  const out: { start: number; end: number }[] = [];
  for (const place of places) {
    const lineStart = starts[place.line - 1];
    // Строка за концом документа (сервер смотрел другую версию) — место не наше.
    if (lineStart === undefined) continue;
    // Конец строки: где начинается следующая. Столбец за её концом прижимаем сюда
    // же — ответ сервера может быть о старой версии текста, и подсветка, перелезшая
    // через перевод строки, была бы хуже, чем чуть короткая.
    const nextStart = starts[place.line];
    const lineEnd = nextStart === undefined ? text.length : nextStart - 1;
    const start = Math.min(lineEnd, lineStart + Math.max(0, place.column - 1));
    const end = Math.min(lineEnd, lineStart + Math.max(0, place.endColumn - 1));
    if (end > start) out.push({ start, end });
  }
  return out;
}
