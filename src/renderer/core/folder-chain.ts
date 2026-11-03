import type { DirEntry } from '../../shared/api';

/**
 * Свёрнутые цепочки папок: `a/b/c`, где у каждой ровно одна папка и ни одного
 * файла, показываются одной строкой.
 *
 * Зачем: в проектах вроде Java или Go глубина вложенности большая, а содержания
 * на верхних уровнях нет — три-четыре строки на пути. Склеенные в одну, они
 * оставляют дереву место под то, что в папках действительно лежит.
 */

/** Что показать вместо папки: заголовок из имён и путь до конца цепочки. */
export interface FolderChain {
  /** Подпись строки — имена звеньев через разделитель. */
  readonly label: string;
  /** Звенья по отдельности: по ним считается глубина. */
  readonly parts: readonly string[];
  /** Путь последнего звена: его содержимое и рисуется под строкой. */
  readonly path: string;
}

const DIRECTORY = 'directory';

/**
 * Продолжается ли цепочка за этой папкой.
 *
 * Условие одно и жёсткое: в папке ровно одна запись, и она — папка. Файл в списке
 * обрывает цепочку: `src/index.ts` и `src/utils/` — это уже две разные вещи, и
 * склеивать их в `src/index.ts/utils` бессмысленно.
 */
function chainGoes(child: readonly DirEntry[] | undefined): child is readonly [DirEntry] {
  const [only, ...rest] = child ?? [];
  return rest.length === 0 && only !== undefined && only.kind === DIRECTORY;
}

/**
 * Собрать полную цепочку от папки вниз.
 *
 * `children` — уже прочитанные списки папок. Непрочитанная папка обрывает цепочку
 * так же, как пустая: удлинять строку, пока ответ не пришёл, значило бы потом
 * перерисовывать её с другим заголовком.
 */
export function folderChain(
  entry: DirEntry,
  children: ReadonlyMap<string, readonly DirEntry[]>,
  separator = '/',
): FolderChain {
  const parts = [entry.name];
  let path = entry.path;
  // Счётчик — страховка от петли в данных: кольцо в `children` случиться не должно,
  // но дерево рисуется на каждом кадре, и вечная цепочка подвесила бы отрисовку.
  for (let step = 0; step < 64; step += 1) {
    const next = children.get(path);
    if (!chainGoes(next)) break;
    const only = next[0];
    parts.push(only.name);
    path = only.path;
  }
  return { label: parts.join(separator), parts, path };
}

/**
 * Сколько звеньев склеено.
 *
 * Нужно для отступа: содержимое цепочки начинается на её глубине плюс число
 * склеенных звеньев. Без этого дети цепочки съезжают на один уровень влево и
 * выглядят как её соседи.
 */
export function chainDepth(chain: FolderChain): number {
  return chain.parts.length;
}
