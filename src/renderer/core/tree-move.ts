/**
 * Перенос файлов и папок дерева в целевую папку: какие шаги имеет смысл делать.
 *
 * Сам перенос — это `workspace.rename` (переименование внутри каталога и перенос
 * между каталогами — одна операция `fs.rename`). Здесь решается, ЧТО переносить:
 * бессмысленные и опасные шаги отсеиваются до запроса, иначе часть из них упала бы
 * уже на диске и человек увидел бы ошибку там, где её не должно быть вовсе.
 */

import { isInsidePath, joinPath, nameOf } from '../../shared/paths';

export interface MoveStep {
  readonly from: string;
  readonly to: string;
}

/**
 * Шаги переноса выбранных путей в `targetDir`.
 *
 * Пропускаем:
 *   • путь, который уже лежит в целевой папке (переезд в никуда);
 *   • папку, переезжающую внутрь себя или своего потомка (путь стал бы цикличным);
 *   • вложенный путь, если вместе с ним едет его предок: он уедет с ним, а
 *     отдельный шаг споткнулся бы о уже несуществующий старый путь.
 */
export function movePlan(paths: readonly string[], targetDir: string): MoveStep[] {
  return planInto(paths, targetDir);
}

/**
 * План копирования: шаги те же, что у переноса, — отсеиваются те же бессмысленные
 * случаи (в ту же папку, внутрь себя, вложенное при едущем предке).
 */
export function copyPlan(paths: readonly string[], targetDir: string): MoveStep[] {
  return planInto(paths, targetDir);
}

function planInto(paths: readonly string[], targetDir: string): MoveStep[] {
  const steps: MoveStep[] = [];
  for (const from of paths) {
    const to = joinPath(targetDir, nameOf(from));
    if (to === from) continue;
    if (isInsidePath(from, to)) continue;
    const underSelected = paths.some((other) => other !== from && isInsidePath(other, from));
    if (underSelected) continue;
    steps.push({ from, to });
  }
  return steps;
}
