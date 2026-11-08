import { joinPath, nameOf, parentOf } from '../../shared/paths';

/**
 * Дублирование файла или папки: какое имя возьмёт копия.
 *
 * Правило одно, но его легко сделать неправильным на мелочах: `a.ts` →
 * `a copy.ts`, а не `a.ts copy`; десять копий не должны дать `a copy.txt copy`.
 * Поэтому имя собирается здесь, а не в команде, и проверяется тестом.
 *
 * Расширение отрезается только у файла: у папки точка — часть имени, и
 * `my.config` — папка, а не файл без расширения.
 */
export interface DuplicatePlan {
  readonly source: string;
  readonly target: string;
}

/** Расширение с точкой — только когда оно есть и не пустое. */
function extensionOf(name: string, isDirectory: boolean): string {
  if (isDirectory) return '';
  const dot = name.lastIndexOf('.');
  // У `a.` и `.gitignore` расширения нет — это имя целиком.
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot);
}

/**
 * Имя очередной копии. `taken` отвечает, занято ли имя на диске — через
 * него, а не через `fs`: решение проверяется без диска.
 *
 * Первая копия — «a copy.ts», вторая — «a copy 2.ts»: так человек видит отличие
 * и не получает «copy copy».
 */
export function duplicateName(name: string, isDirectory: boolean, taken: (candidate: string) => boolean): string {
  const ext = extensionOf(name, isDirectory);
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length);
  const candidate = (suffix: string): string => `${stem}${suffix}${ext}`;

  let result = candidate(' copy');
  for (let index = 2; taken(result); index += 1) {
    result = candidate(` copy ${index}`);
  }
  return result;
}

/** План дублирования: где лежит источник и как назовётся копия. */
export function duplicatePlan(
  source: string,
  isDirectory: boolean,
  taken: (candidate: string) => boolean,
): DuplicatePlan {
  return {
    source,
    target: joinPath(parentOf(source), duplicateName(nameOf(source), isDirectory, taken)),
  };
}
