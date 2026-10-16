/**
 * Пошаговый поиск «багованного» коммита (`git bisect`): состояние и разбор вывода.
 *
 * Bisect — не одна команда, а диалог: git сам переставляет ветку на середину отрезка
 * и после каждого ответа («хороший»/«плохой») сужает его вдвое, пока не назовёт
 * первый плохой коммит. Он печатает ход словами — эти строки и разбираем, чтобы
 * показать «осталось N версий, примерно M шагов». Само git-состояние (идёт ли поиск)
 * видно по файлу `BISECT_START` в каталоге git; разбор тут — чистая работа с текстом.
 */

/** Что сейчас происходит в поиске. */
export interface GitBisectState {
  /** Идёт ли поиск прямо сейчас. */
  active: boolean;
  /** Коммит, на котором стоит рабочее дерево (проверяемая середина). */
  current: { hash: string; summary: string } | null;
  /** Сколько версий осталось проверить; null — git не сказал. */
  remaining: number | null;
  /** Примерное число шагов до итога; null — git не сказал. */
  steps: number | null;
  /** Найденный первый плохой коммит (короткий хеш) — поиск завершён. */
  firstBad: string | null;
  /** Словами git: что он сделал или на чём споткнулся. */
  message: string;
}

/** Слова из вывода git: сколько версий осталось и сколько это примерно шагов. */
export function parseBisectProgress(text: string): { remaining: number | null; steps: number | null } {
  // «Bisecting: 3 revisions left to test after this (roughly 2 steps)»
  const match = /(\d+)\s+revisions?\s+left[^(]*\(roughly\s+(\d+)\s+steps?\)/i.exec(text);
  if (!match) return { remaining: null, steps: null };
  return { remaining: Number(match[1]), steps: Number(match[2]) };
}

/**
 * «abc1234 is the first bad commit» — поиск завершился и назвал виновника.
 *
 * Сперва смотрим журнал bisect: в нём хеш полный и всегда в скобках. Строка
 * формулируется по-разному в зависимости от версии git: до 2.5x — `first bad commit`,
 * с 2.5x термин печатается в кавычках (`first 'bad' commit`); сам термин к тому же
 * можно перенастроить (`git bisect start --term-old/--term-new`). Поэтому между
 * «first» и «commit» допускаем любой текст, а не ровно слово «bad»: иначе на новой
 * версии git поиск «не заканчивается» и виновник теряется.
 */
export function parseBisectFirstBad(text: string): string | null {
  const logged = /#\s*first[^:]*commit:\s*\[([0-9a-f]{7,40})\]/i.exec(text);
  if (logged) return logged[1]!;
  const match = /([0-9a-f]{7,40})\s+is\s+the\s+first[^\n]*?commit/i.exec(text);
  return match ? match[1]! : null;
}

/**
 * Разбор хода поиска из строки вывода git. `started` — есть ли файл `BISECT_START`:
 * без него поиск не идёт, что бы ни было в тексте.
 */
export function parseBisectState(
  text: string,
  started: boolean,
): Pick<GitBisectState, 'active' | 'remaining' | 'steps' | 'firstBad'> {
  const progress = parseBisectProgress(text);
  const firstBad = parseBisectFirstBad(text);
  return {
    // Первый плохой коммит означает, что поиск нашёл итог: он ещё «идёт» до `reset`,
    // но середины для проверки больше нет.
    active: started && firstBad === null,
    remaining: progress.remaining,
    steps: progress.steps,
    firstBad,
  };
}
