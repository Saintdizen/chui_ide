/**
 * Подбор фрагментов под задачу (п.66).
 *
 * `search` отвечает путями и номерами строк — модель идёт за телом отдельными
 * `read`. `code` называет объявления. Ни тот, ни другой не отвечает на «покажи
 * то, что относится к делу»: между списком мест и рабочим контекстом у модели
 * два-три лишних шага и несколько лишних тысяч символов.
 *
 * `snippets` сам достаёт тела найденных объявлений и ранжирует их под задачу.
 * Оценка — не магия: имя символа совпало целиком, началом, словом запроса;
 * объявление в том же каталоге, что и запрос; чем короче фрагмент, тем лучше
 * (плотность). Ранг считаем на месте, без индексов и эмбеддингов: цена ошибки
 * ранжирования — порядок строк, а не потеря ответа.
 */
import type { SearchSymbol } from '../../shared/code-search';

/** Сколько строк тела берём у объявления. */
export const SNIPPET_LINES = 24;
/** Сколько фрагментов отдаём по умолчанию и сколько всего. */
export const SNIPPETS_DEFAULT = 5;
export const SNIPPETS_MAX = 12;
/** Оценка, выше которой в фрагменте есть хоть одно слово задачи. */
const NOTHING_WORD_SCORE = 40;

/** Ширина фрагмента: дальше — уже не «относящееся к делу». */
const SNIPPET_MAX_CHARS = 1600;

export interface Snippet {
  /** Объявление, из которого взят фрагмент. */
  readonly symbol: SearchSymbol;
  /** Тело: строки от начала объявления до пустой строки или `SNIPPET_LINES`. */
  readonly text: string;
  /** Почему этот фрагмент в списке — коротким словом для ответа. */
  readonly why: string;
  /** Оценка: больше — ближе к задаче. */
  readonly score: number;
}

/** Слова запроса: по ним меряем совпадение с именем и телом фрагмента. */
export function queryWords(query: string): string[] {
  return query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-zа-яё0-9_$]+/i)
    .filter((word) => word.length > 1);
}

/**
 * Тесты и фикстуры: в подбор под задачу они не годятся.
 *
 * Совпадение в `tests/snippets.test.ts` — это «где написано про это», а модель
 * спрашивает «где это работает». Тесты остаются в обычном `search`, их видно
 * отдельным запросом. Отсев не окончательный: если кроме тестов ничего нет —
 * отдаём их (см. ниже).
 */
function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|fixtures?)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path);
}

/**
 * Оценка фрагмента под задачу.
 *
 * Веса подобраны так, чтобы имя решало больше тела: объявление с точно нужным
 * именем полезнее, чем чужое объявление, где слово встретилось внутри. Каталог
 * совпадает — небольшой плюс: поиск в `src/main/ai` с задачей про `read` обычно
 * и про `agent-read.ts`. Дробим на 100, чтобы ранг оставался числом для сортировки.
 */
export function scoreSnippet(symbol: SearchSymbol, text: string, query: string): { score: number; why: string } {
  const wanted = queryWords(query);
  const name = symbol.name.toLowerCase();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (name === query.toLowerCase()) {
    score += 100;
    reasons.push('имя совпало целиком');
  } else if (name.startsWith(query.toLowerCase())) {
    score += 60;
    reasons.push('имя начинается с запроса');
  }
  const inName = wanted.filter((word) => name.includes(word)).length;
  if (inName > 0 && !reasons.length) {
    score += 25 * inName;
    reasons.push('слова в имени');
  }
  const inText = wanted.filter((word) => lower.includes(word)).length;
  if (inText > 0) {
    score += 10 * inText;
    if (!reasons.length) reasons.push('слова в теле');
  }
  // Плотность: короткий фрагмент с тем же попаданием полезнее длинного.
  score += Math.max(0, 20 - Math.floor(text.length / 200));
  if (reasons.length === 0) reasons.push('по объявлению');

  return { score, why: reasons.join(', ') };
}

/**
 * Тело объявления из текста файла: от его строки и до пустой строки перед
 * следующим объявлением, но не глубже `SNIPPET_LINES` и `SNIPPET_MAX_CHARS`.
 *
 * Границы именно так: в языке без отступов (не парсим их) пустая строка —
 * единственный надёжный признак конца функции. Закрывающая скобка тоже годится,
 * но у объекта-литерала она внутри тела — потому она лишь второй признак.
 */
export function snippetOf(lines: readonly string[], symbol: SearchSymbol, next: SearchSymbol | undefined): string {
  const start = Math.max(0, symbol.line - 1);
  const limit = Math.min(lines.length, start + SNIPPET_LINES, next ? next.line - 1 : lines.length);
  const picked: string[] = [];
  let chars = 0;
  for (let index = start; index < limit; index += 1) {
    const line = lines[index] ?? '';
    // Пустая строка после первой — конец объявления.
    if (index > start && line.trim() === '') break;
    chars += line.length + 1;
    if (chars > SNIPPET_MAX_CHARS) break;
    picked.push(line);
  }
  // Убрать хвост из одних закрывающих скобок: они ничего не объясняют.
  while (picked.length > 1 && /^[)\]};]*$/.test(picked[picked.length - 1]!.trim())) picked.pop();
  return picked.join('\n');
}

/** Отбор: посчитать всех, взять лучших, отрезать по лимиту. */
export function rankSnippets(
  candidates: ReadonlyArray<{ symbol: SearchSymbol; text: string }>,
  query: string,
  limit = SNIPPETS_DEFAULT,
): Snippet[] {
  const scored = candidates.map(({ symbol, text }) => {
    const { score, why } = scoreSnippet(symbol, text, query);
    return { symbol, text, why, score };
  });
  scored.sort(
    (a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.line - b.symbol.line,
  );
  // Объявления, где нет ни одного слова задачи, — не подбор, а шум: при запросе
  // `readFile` второе объявление `other` ничего в себе не содержит, и отдавать
  // его рядом с точным попаданием значит размывать ответ. Есть только такие —
  // отдаём всё: пустой ответ хуже неточного.
  const meaningful = scored.filter((snippet) => snippet.score >= NOTHING_WORD_SCORE);
  const relevant = meaningful.filter((snippet) => !isTestPath(snippet.symbol.path));
  // Есть что показать из кода — тесты не нужны; остались только тесты — они и есть ответ.
  const ranked = relevant.length > 0 ? relevant : meaningful.length > 0 ? meaningful : scored;
  return ranked.slice(0, Math.max(1, Math.min(limit, SNIPPETS_MAX)));
}
