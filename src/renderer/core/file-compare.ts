/**
 * Сравнение двух произвольных файлов: какую пару сравнивать и как её назвать.
 *
 * Логика вынесена из интерфейса отдельно: у дерева два входа — «сравнить
 * выделенное» (ровно два файла) и «сравнить с…» (выбранный плюс подобранный).
 * Правила, кого с кем можно сравнивать по смыслу, проверяются тестами, а экран
 * сравнения получает уже готовую пару.
 *
 * Папки не сравниваем: экран различий показывает текст построчно, а разница
 * каталогов — это другое представление (список файлов), которого у нас нет.
 */

import { nameOf, parentOf } from '../../shared/paths';

export interface ComparePair {
  readonly left: string;
  readonly right: string;
}

/**
 * Пара для сравнения из выделения: берём первые два пути. Один путь или ноль —
 * пары нет: сравнивать не с чем, и молчаливое «сравнение файла с самим собой»
 * только запутало бы.
 */
export function pairFromSelection(paths: readonly string[]): ComparePair | null {
  const [left, right] = paths;
  if (!left || !right || left === right) return null;
  return { left, right };
}

/**
 * Подпись сравнения: имена файлов, а если имена совпали (два `index.ts` из разных
 * папок) — пути от их общего конца, чтобы строки в шапке не выглядели одинаково.
 */
export function compareLabel(pair: ComparePair): string {
  const leftName = nameOf(pair.left);
  const rightName = nameOf(pair.right);
  if (leftName !== rightName) return `${leftName} ↔ ${rightName}`;
  return `${distinctTail(pair.left)} ↔ ${distinctTail(pair.right)}`;
}

/** Хвост пути, отличающий его от второго: последние два сегмента. */
function distinctTail(path: string): string {
  const parent = nameOf(parentOf(path));
  return parent ? `${parent}/${nameOf(path)}` : path;
}
