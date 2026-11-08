import fsSync from 'node:fs';
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
 * Путь — это другой корень области или его потомок.
 *
 * Нужен для областей из нескольких папок: файл из второго корня не обязан
 * лежать внутри первого, и проверять его надо против своего.
 */
export function isInsideAnyRoot(roots: readonly string[], target: string): boolean {
  return roots.some((root) => isInsideRoot(root, target));
}

/**
 * Куда на самом деле ведёт путь.
 *
 * `real` — то, что вернул `fs.realpath`; `null`, когда раскрыть не удалось
 * (файла ещё нет — например, при создании). Обратного раскрытия мало:
 * `realpath` раскрывает ТОЛЬКО последний элемент, а папка, в которой он лежит,
 * может сама оказаться симлинком наружу.
 *
 * Раскрыть нечего — файла нет, но папка может быть симлинком наружу: тогда
 * `resolved` обманывает, он начинается с корня, а ведёт совсем в другое место.
 * Поэтому при создании файла раскрываем ближайшего существующего предка и
 * подклеиваем остаток. Раскрыть не удалось совсем — верим `resolved`: иначе
 * нельзя было бы создать папку, которой ещё нет.
 */
export function resolveRealTarget(rootReal: string | null, resolved: string, real: string | null): string {
  if (real !== null) return real;
  // Нет корня — нет и рамки, о которой спрашивают: раскрывать не о чем.
  if (!rootReal) return path.resolve(resolved);
  return realOfNearestAncestor(path.resolve(resolved));
}

/**
 * Раскрыть ближайшего СУЩЕСТВУЮЩЕГО предка и подклеить остаток.
 *
 * Так и находится настоящий адрес файла, которого ещё нет. Синхронно: функция
 * остаётся решением без `await`, её зовут внутри проверки пути.
 */
function realOfNearestAncestor(resolved: string): string {
  let probe = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fsSync.realpathSync(probe), ...tail);
    } catch {
      const parent = path.dirname(probe);
      // Дошли до корня файловой системы и ничего живого не нашли: сказать
      // нечего — возвращаем как было, иначе создание папок перестанет работать.
      if (parent === probe) return resolved;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
  }
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
