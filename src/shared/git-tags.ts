/**
 * Разбор списка тегов репозитория.
 *
 * `git tag --list` с форматом отдаёт по строке на тег. Поля разделены ТАБУЛЯЦИЕЙ:
 * в формате `git tag` шестнадцатеричные вставки (`%x1f`) не разворачиваются, а
 * литеральный разделитель работает. Имя тега табуляцию содержать не может (git
 * такие имена запрещает), а заголовок — может, поэтому режем только по первым
 * двум разделителям, а остаток строки считаем заголовком целиком.
 *
 * Модуль чистый — запуск git остаётся в main, а разбор проверяется тестами.
 */

export interface GitTag {
  /** Короткое имя тега (`v1.2.0`). */
  name: string;
  /** Короткий хеш коммита, на который указывает тег. */
  commit: string;
  /** Заголовок: сообщение аннотированного тега или тема коммита. */
  subject: string;
}

const FIELD_SEPARATOR = '\t';

export function parseTagList(text: string): GitTag[] {
  const tags: GitTag[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const first = line.indexOf(FIELD_SEPARATOR);
    if (first <= 0) continue;

    const second = line.indexOf(FIELD_SEPARATOR, first + 1);
    const name = line.slice(0, first);
    const commit = second === -1 ? line.slice(first + 1) : line.slice(first + 1, second);
    const subject = second === -1 ? '' : line.slice(second + 1);

    tags.push({ name, commit, subject });
  }

  return tags;
}
