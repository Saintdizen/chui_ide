/**
 * Куда ведёт клавиша в списке (`listbox`).
 *
 * Зачем это отдельным модулем. `↑/↓` — единственное, что списки делали
 * сами. `Home`/`End`, `PageUp`/`PageDown` и переход по первой букве каждый из
 * трёх списков (палитра, быстрое открытие, выпадающий список) писал или
 * забывал по-своему — а чаще забывал. Хуже всего это для читалки: текущий
 * вариант не называется вовсе.
 *
 * Здесь только решение — какая строка станет текущей. Рисование и
 * объявления остаются за видом.
 */

/** Что делает клавиша в списке. `null` — клавиша не наша. */
export type ListMove =
  | { readonly kind: 'to'; readonly index: number }
  | { readonly kind: 'type'; readonly letter: string };

/**
 * Сколько строк в «странице». Настоящая страница зависит от высоты, а высота —
 * от вёрстки: без замера берём разумное умолчание. Уточнить вправе вид.
 */
export const LIST_PAGE = 10;

/**
 * Текущая строка после клавиши.
 *
 * Обёртка по краям, а не остановка: `↓` на последней строке останавливалась
 * намертво, и человек не понимал, список кончился или сломался.
 * `Home`/`End` — намеренный скачок к краю.
 */
export function listMove(key: string, current: number, count: number, page: number = LIST_PAGE): ListMove | null {
  if (count <= 0) return null;
  const last = count - 1;
  const clamp = (index: number): number => Math.min(Math.max(index, 0), last);

  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp':
      return { kind: 'to', index: (current + (key === 'ArrowDown' ? 1 : -1) + count) % count };
    case 'Home':
      return { kind: 'to', index: 0 };
    case 'End':
      return { kind: 'to', index: last };
    case 'PageDown':
      return { kind: 'to', index: clamp(current + Math.max(page, 1)) };
    case 'PageUp':
      return { kind: 'to', index: clamp(current - Math.max(page, 1)) };
    default:
      // Буква, цифра — переход по началу названия. Пробел сюда НЕ идёт: в
      // списках выбора он выбирает, и перехват сделал бы выбор невозможным.
      if ([...key].length === 1 && key !== ' ' && /\S/.test(key)) {
        return { kind: 'type', letter: key };
      }
      return null;
  }
}

/**
 * Строка по началу набранного текста.
 *
 * Ищем с строки ЗА текущей: тогда повторное нажатие той же буквы листает
 * одноимённые, а не замирает на первом. Не нашли после — ищем с начала,
 * иначе переход «застревал» бы на хвосте списка.
 */
export function typeaheadIndex(labels: readonly string[], typed: string, current: number): number | null {
  const needle = typed.trim().toLowerCase();
  if (needle === '' || labels.length === 0) return null;
  const start = current + 1;
  for (let step = 0; step < labels.length; step += 1) {
    const index = (start + step) % labels.length;
    if (labels[index]!.toLowerCase().startsWith(needle)) return index;
  }
  return null;
}

/**
 * Идентификатор строки для `aria-activedescendant`.
 *
 * Строки пересоздаются на каждую отрисовку, поэтому идентификатор берётся от
 * позиции, а не от самого узла: `listbox` называет, КАКАЯ строка текущая, и
 * читалка сама находит её в разметке по имени.
 */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * Идентификатор строки дерева — для `aria-activedescendant` у самого дерева.
 *
 * Как и у списков, имя даётся по позиции в наборе: строки дерева тоже
 * пересоздаются на каждую отрисовку, и держаться за сам узел нельзя.
 */
export function treeRowId(index: number): string {
  return optionId('tree', index);
}
