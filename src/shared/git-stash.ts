/**
 * Разбор списка отложенных изменений (stash).
 *
 * `git stash list` отдаёт по строке на запись. Формат строки зависит от того, как
 * запись сделана:
 *   • без сообщения — `WIP on <ветка>: <короткий хеш> <заголовок коммита>`;
 *   • с сообщением `-m` — `On <ветка>: <сообщение>`.
 *
 * Модуль чистый: только текст → структура. Запуск git остаётся в main, поэтому
 * разбор проверяется тестами отдельно.
 */

export interface GitStashEntry {
  /** Номер записи: `stash@{index}`, 0 — самая свежая. */
  index: number;
  /** Ссылка вида `stash@{0}` — её понимают команды git. */
  ref: string;
  /** Описание записи: сообщение или заголовок коммита, от которого отложили. */
  message: string;
  /** Ветка, откуда отложили; `null`, если её не видно в описании. */
  branch: string | null;
}

/** Поля строки разделены байтом `\x1f`: заголовки git могут содержать что угодно, кроме него. */
const FIELD_SEPARATOR = '\u001f';

const WIP = /^WIP on ([^:]+):\s*(.*)$/;
const ON = /^On ([^:]+):\s*(.*)$/;

export function parseStashList(text: string): GitStashEntry[] {
  const entries: GitStashEntry[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const [ref, subject = ''] = line.split(FIELD_SEPARATOR);
    if (!ref) continue;

    const numbered = /^stash@\{(\d+)\}$/.exec(ref);
    if (!numbered) continue;

    // Ветку и «человеческое» описание достаём из заголовка; если он незнакомого
    // вида — оставляем как есть, лишь бы запись не потерялась.
    const wip = WIP.exec(subject);
    const on = ON.exec(subject);
    const branch = wip?.[1] ?? on?.[1] ?? null;
    // У записи без сообщения после ветки стоит короткий хеш коммита — от него
    // человеку толку нет, оставляем только заголовок.
    const wipText = wip ? wip[2]!.replace(/^[0-9a-f]{7,40}\s+/, '').trim() : '';
    const message = wip ? wipText || wip[2]! : (on?.[2] ?? subject);

    entries.push({ index: Number(numbered[1]), ref, message, branch });
  }

  return entries;
}
