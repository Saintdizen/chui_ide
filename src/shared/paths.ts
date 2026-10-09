/**
 * Работа с путями строками — там, где `node:path` недоступен.
 *
 * В renderer `node:path` нет и быть не должно (изоляция контекста), поэтому пути
 * считаются строками. Ловушка одна и та же во всех таких местах: разделитель не
 * всегда прямой. Main отдаёт пути как есть (`path.join`), и на Windows это
 * обратные слэши. Если где-то жёстко резать по «/», на Windows путь не находится:
 * файл выглядит лежащим вне проекта, переименование строит «/имя» в пустом
 * родителе, а крошки схлопываются в один сегмент.
 *
 * Поэтому разделитель всюду берётся из самого пути. Здесь — общие правила,
 * чтобы не повторять их (и не повторять ошибку) в каждом модуле.
 */

/** Разделитель пути: какой есть в строке. Пустой путь — считаем прямым. */
export function separatorOf(target: string): string {
  return target.includes('\\') ? '\\' : '/';
}

/** Разбить путь на сегменты. Режем по обоим разделителям. */
export function splitPath(target: string): string[] {
  return target.split(/[/\\]/).filter((segment) => segment.length > 0);
}

/**
 * Родительский путь — всё до последнего разделителя. Разделителя нет — пустая
 * строка: у «имени без каталога» родителя не бывает.
 */
export function parentOf(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return index < 0 ? '' : target.slice(0, index);
}

/** Последний сегмент пути: имя файла или папки. */
export function nameOf(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return index < 0 ? target : target.slice(index + 1);
}

/** Соединить родителя и имя. Пустой родитель — просто имя. */
export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const trimmed = parent.replace(/[/\\]+$/, '');
  return `${trimmed}${separatorOf(parent)}${name}`;
}

/** Путь лежит внутри папки. Сравниваем по границе сегмента, а не по подстроке. */
export function isInsidePath(folder: string, target: string): boolean {
  if (target === folder) return true;
  return target.startsWith(joinPath(folder, ''));
}

/** Оставшаяся от корня часть пути; сам корень — пустая строка, чужой путь — как есть. */
export function pathAfter(root: string, target: string): string {
  return isInsidePath(root, target) ? target.slice(root.replace(/[/\\]+$/, '').length + 1) : target;
}
