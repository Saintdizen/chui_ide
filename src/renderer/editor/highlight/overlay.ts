/**
 * Наложение одной подсветки на другую: что важнее, то и красит знак.
 *
 * У строки есть своя подсветка из грамматики, а сверху приходит семантическая от
 * языкового сервера. Сервер разобрал программу целиком и потому точнее: где он высказался,
 * его роль важнее грамматики. Где промолчал — остаётся грамматика.
 *
 * Участки обеих подсветок могут резать друг друга как угодно, поэтому сначала собирается
 * общая сетка границ, а затем каждый её отрезок красится ролью того участка, что накрыл его
 * целиком (верхний важнее нижнего). Соседние отрезки с одной ролью склеиваются: иначе
 * строка рассыпалась бы на лишние `<span>`.
 *
 * Модуль чистый: только числа и строки, ни DOM, ни модели текста.
 */

/** Участок строки с ролью палитры. `role` — `null`, когда красить не надо (обычный текст). */
export interface RoleRange {
  readonly start: number;
  readonly end: number;
  readonly role: string | null;
}

/**
 * Наложить `top` на `base`. Оба списка — участки в одних единицах (столбцы с нуля).
 * Возвращаются непересекающиеся участки по возрастанию, соседние с одной ролью склеены.
 */
export function overlayRanges(base: readonly RoleRange[], top: readonly RoleRange[]): RoleRange[] {
  const effective = top.filter((range) => range.end > range.start);

  const bounds = new Set<number>();
  for (const range of base) {
    bounds.add(range.start);
    bounds.add(range.end);
  }
  for (const range of effective) {
    bounds.add(range.start);
    bounds.add(range.end);
  }
  const sorted = [...bounds].sort((left, right) => left - right);

  const out: RoleRange[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index]!;
    const end = sorted[index + 1]!;
    if (end <= start) continue;
    // Верхний участок важнее нижнего; ищем накрывающий целиком.
    const onTop = effective.find((range) => range.start <= start && range.end >= end);
    const under = onTop ? undefined : base.find((range) => range.start <= start && range.end >= end);
    const role = (onTop ?? under)?.role ?? null;
    const last = out[out.length - 1];
    if (last && last.end === start && last.role === role) {
      out[out.length - 1] = { start: last.start, end, role };
    } else {
      out.push({ start, end, role });
    }
  }
  return out;
}
