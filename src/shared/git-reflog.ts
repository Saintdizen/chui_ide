/**
 * Разбор журнала ссылок (`git reflog`) — «что происходило с указателями ветки».
 *
 * Формат строки задаём сами: `%h%x1f%gd%x1f%ad%x1f%gs` — короткий хеш, ссылка
 * (`HEAD@{0}`), дата и описание операции. Разделитель `%x1f`: `git reflog` идёт
 * через тот же движок, что `git log`, поэтому шестнадцатеричная вставка здесь
 * разворачивается (в отличие от `git tag --format`).
 *
 * Модуль чистый: только текст → структура, поэтому проверяется тестами.
 */

export interface GitReflogEntry {
  /** Короткий хеш коммита, на который указывала ссылка. */
  hash: string;
  /** Сама ссылка с номером: `HEAD@{0}`. */
  ref: string;
  /** Дата операции (короткая). */
  date: string;
  /** Что произошло: `commit: …`, `reset: moving to …`, `checkout: …`. */
  action: string;
}

const FIELD_SEPARATOR = '\u001f';

export function parseReflog(text: string): GitReflogEntry[] {
  const entries: GitReflogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const [hash = '', ref = '', date = '', action = ''] = line.split(FIELD_SEPARATOR);
    if (!hash || !ref) continue;
    entries.push({ hash, ref, date, action });
  }
  return entries;
}
