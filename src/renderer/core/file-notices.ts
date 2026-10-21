/**
 * Фразы, которыми окно отвечает на действие с файлом.
 *
 * Вынесены ради одной вещи: это читает человек, и «сколько ссылок поправили» —
 * не украшение, а ответ на вопрос «а импорты он мне починил?». Пока строки жили
 * внутри обработчика `file.rename`, проверить их можно было только руками.
 */

export interface RenameNoticeFacts {
  /** Новое имя файла — только само имя, без папок. */
  name: string;
  /** Сколько файлов получило правки ссылок; 0 — ссылки не правились. */
  touched: number;
}

/**
 * Итог переименования. Число поправленных ссылок показываем только когда их правда
 * правили: «обновлено ссылок: 0» читается как сбой, хотя это просто тишина.
 */
export function renamedNotice(facts: RenameNoticeFacts): string {
  const head = `Переименовано: ${facts.name}`;
  return facts.touched > 0 ? `${head} · обновлено ссылок: ${facts.touched}` : head;
}

/** Подтверждение удаления пачки: число и слово-склонение — «3 объекта».
 *
 * Один вопрос на всю пачку намеренно: спрашивать по разу на файл — то самое
 * раздражение, ради ухода от которого и делают групповое выделение.
 */
export function deleteManyPrompt(count: number, plural: (n: number) => string): { message: string; detail: string } {
  return {
    message: `Переместить в корзину ${count} ${plural(count)}?`,
    detail: 'Файлы и папки можно вернуть из корзины системы.',
  };
}

/**
 * Итог удаления, когда часть объектов не далась. Ноль — не показываем вовсе:
 * «в корзине: 0» человеку ничего не говорит.
 */
export function trashedNotice(count: number, plural: (n: number) => string): string | null {
  return count > 0 ? `В корзине: ${count} ${plural(count)}` : null;
}

/**
 * Итог переноса: одного называем по имени, пачку — числом. Без причин пропусков:
 * на этом шаге видно только, что какой-то объект не переехал, а не почему.
 */
export function movedNotice(moved: number, onlyOne: string | null, plural: (n: number) => string): string {
  return onlyOne !== null ? `Перенесено: ${onlyOne}` : `Перенесено: ${moved} ${plural(moved)}`;
}

/** Подтверждение удаления одного файла: вопрос и вторая строка — что за файл и как вернуть. */
export function deletePrompt(name: string, relative: string): { message: string; detail: string } {
  return {
    message: `Переместить ${name} в корзину?`,
    detail: `${relative} — файл можно вернуть из корзины системы.`,
  };
}
