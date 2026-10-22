import path from 'node:path';

/**
 * Проверки пути для рабочей папки — решения без ввода-вывода.
 *
 * Живут отдельно от `WorkspaceService`, потому что это правила, а не работа с
 * диском: их видно в тестах, а сервис только подставляет реальный путь. Ошибиться
 * здесь дорого: проверка защищает и от `..` в запросе, и от чтения чужих файлов
 * по симлинку.
 */

/** Путь лежит внутри корня проекта. Считается до обращения к диску. */
export function isInsideRoot(root: string, target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Симлинк уводит за пределы проекта. `null` с любой стороны — сказать нечего,
 * и это не ошибка.
 *
 * Различать случаи нужно: для операций с содержимым уход наружу — запрет, а для
 * чтения метаданных — нет. Так устроены виртуальные окружения: `.venv/bin/python`
 * ссылается на системный интерпретатор, и без этой проверки IDE не поняла бы,
 * каким питоном запускать код.
 */
export function escapesRoot(rootReal: string | null, real: string | null): boolean {
  if (!real || !rootReal) return false;
  return real !== rootReal && !real.startsWith(rootReal + path.sep);
}

/**
 * Путь из вывода ripgrep — к абсолютному, от каталога, в котором его запускали.
 *
 * `rg` печатает `./app.ts`, а свой обход отдаёт абсолютный путь. Если оставить
 * относительный, `path.relative(корень, hit.path)` разрешит его от процесса,
 * а не от проекта. Абсолютный путь ripgrep не трогаем: `path.resolve` так и
 * делает.
 */
export function absoluteSearchPath(cwd: string, reported: string): string {
  return path.resolve(cwd, reported);
}
