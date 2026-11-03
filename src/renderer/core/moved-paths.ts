import { nameOf } from '../../shared/paths';
import { movedTo } from '../../shared/drop-guard';

/**
 * Что будет с вкладкой и текстом в памяти, когда файл меняет место.
 *
 * Решение, а не действие: `file-mutation-commands` кладёт файл на диск и берёт
 * отсюда список того, что надо передвинуть после успеха. Так правило проверяется
 * тестом, а не проверкой руками «сохранилось ли».
 */
export interface MovedPaths {
  /** Куда переехали вкладки: `file.rename` / `file.moveInto` двигают по этим парам. */
  readonly tabs: readonly { readonly from: string; readonly to: string }[];
  /**
   * Буферы, которые надо сохранить ДО переноса.
   *
   * Без этого правка теряется молча: старый путь закрывается в памяти, новый
   * читается с диска — и всё, что человек не сохранил, уезжает вместе с ним.
   */
  readonly unsaved: readonly string[];
  /** Имена без папок — для карточки уведомления. */
  readonly notice: string;
}

/**
 * Что надо знать о файлах, чтобы посчитать перенос: путь и «есть ли несохранённое».
 * `isDirty` — именно для открытого буфера: закрытый файл несохранённого не имеет.
 */
export function movedPaths(
  paths: readonly string[],
  targetDir: string,
  isDirty: (path: string) => boolean,
): MovedPaths {
  const tabs = paths.map((from) => ({ from, to: movedTo(from, targetDir) }));
  const unsaved = paths.filter(isDirty);
  return {
    tabs,
    unsaved,
    // Карточка не влезет в строку целиком: единственное имя — то, что человек искал.
    notice: paths.map(nameOf).join(', '),
  };
}
