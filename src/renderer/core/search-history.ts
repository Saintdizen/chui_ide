/**
 * История запросов поиска — своя в панели поиска, не общая с путями файлов.
 *
 * Зачем: запрос умирал вместе с панелью. Закрыл поиск, вернулся через минуту —
 * набирай снова то же самое. В VS Code `Ctrl+F` поднимает прошлый запрос, а
 * стрелки в поле листают предыдущие — к этому привыкают с первого же дня.
 *
 * Почему отдельно от `recent-files.ts`: там пути, здесь запросы. Сложить их в
 * одно — значит однажды предложить в поле поиска `/src/main/index.ts` вместо
 * `TODO`. Списков к тому же два и внутри модуля: искать «TODO» и подставлять
 * «FIXME» — разные вещи, и общая история подставила бы FIXME в поле «Найти».
 *
 * Модуль чистый: список в памяти, без DOM и без хранилища. Кто и когда
 * сохраняет — дело того, кто его держит.
 */

/** Сколько запросов помним. Дальше — шум: листать стрелками тридцать штук долго. */
export const SEARCH_HISTORY_LIMIT = 30;

export interface SearchHistory {
  /** Запросы, свежие сверху. */
  entries(): readonly string[];
  /** Запомнить запрос: он встаёт первым, прежнее место забывается. */
  remember(query: string): void;
  /** Забыть всё: например, при выходе из проекта. */
  clear(): void;
}

/**
 * Запрос, который стоит помнить: непустой (не из одних пробелов) и без переводов
 * строк.
 *
 * Многострочный поиск панелью не поддерживается — хранить его значило бы держать
 * в истории то, что нельзя повторить.
 */
function isRememberable(query: unknown): query is string {
  return typeof query === 'string' && query.trim().length > 0 && !query.includes('\n') && !query.includes('\r');
}

export function createSearchHistory(limit = SEARCH_HISTORY_LIMIT): SearchHistory {
  const keep = Math.max(1, Math.floor(limit));
  let list: string[] = [];

  return {
    entries: () => list.slice(),
    remember(query) {
      // Мусор — это не история: отбрасываем так же, как `recent-files` отбрасывает
      // не-пути, и не даём одному запросу занять две строки.
      if (!isRememberable(query)) return;
      // Регистр учитываем: «TODO» и «todo» находят разное, и склеивать их значило
      // бы менять то, что вернёт искатель.
      list = [query, ...list.filter((item) => item !== query)].slice(0, keep);
    },
    clear() {
      list = [];
    },
  };
}

/**
 * Следующий запрос при листании стрелками.
 *
 * `index` — где стоим: `-1` — своё место в поле вне истории, `0` — самый свежий
 * запрос, дальше по возрастанию к старым.
 * `delta` — `-1` вверх (к свежим), `1` вниз (к старым).
 *
 * Возвращает `{ index, query }`; `query = null` — вышли за список, вернулись к
 * тому, что человек сам набрал. Возврат к набранному — не мелочь: без него
 * стрелка «вниз» за последним запросом затирала бы только что набранное.
 */
export function stepHistory(
  entries: readonly string[],
  index: number,
  delta: number,
  current: string,
): { index: number; query: string | null } {
  if (entries.length === 0) return { index: -1, query: null };

  // Своё место в поле — это `-1`, а не нулевой запрос: «вверх» от него ведёт к
  // свежему запросу, «вниз» — никуда. Считать как `index + delta` значило бы
  // получить `-2` и уехать не в ту ветку.
  const next = index < 0 ? (delta < 0 ? 0 : -1) : index + delta;

  if (next < 0) {
    // Выше самого свежего — возврат к набранному, а не залипание на краю: иначе
    // листание не отменить, не стерев поле руками.
    return { index: -1, query: index === -1 ? null : current };
  }
  // За последним — снова своё место в поле.
  if (next >= entries.length) return { index: -1, query: current };
  return { index: next, query: entries[next] ?? null };
}
