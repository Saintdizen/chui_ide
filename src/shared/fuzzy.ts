/**
 * Сопоставление набранного с именем — по началу и по «горбам» заглавных букв.
 *
 * Правило, которое человек ждёт от подсказок: набранное совпадает не только с
 * НАЧАЛОМ имени, но и с его «горбами» — заглавными буквами внутри и началами слов
 * после разделителя. Набрал `gT` — получил `getTitle`; набрал `MC` — получил
 * `MyClass`; набрал `myc` — получил `MyClass` (это уже совпадение с начала). Именно
 * этого не хватало прежнему подбору: он знал только `startsWith`, а потому на `gT`
 * не находил `getTitle` вовсе.
 *
 * Второе решение — регистр. Строчная буква в набранном совпадает с любой (`my` —
 * и `MyClass`, и `myValue`), а заглавная требует заглавной ровно там же: набрав `MC`,
 * человек просит имена именно с этих заглавных, и `macOS` такой запрос не удовлетворит.
 * Так работает выбор «учёт регистра: первая буква».
 *
 * Третье — оценка (score). Совпадение с начала имени ценнее совпадения по горбам;
 * короткое имя ценнее длинного; сплошное совпадение ценнее совпадения с разрывами;
 * чем дальше первый совпавший знак, тем хуже. По этой оценке список и сортируется —
 * лучший вариант оказывается первым и выделяется сразу.
 *
 * Модуль чистый: строка и набранное на входе, оценка и места совпадений на выходе.
 * Ни DOM, ни буфера — поэтому проверяется тестами без окна.
 */

/** Оценка совпадения: чем больше, тем лучше; места — индексы совпавших знаков имени. */
export interface MatchResult {
  readonly score: number;
  /** Индексы совпавших знаков в имени — по ним в списке подсвечиваются совпадения. */
  readonly positions: readonly number[];
}

/** Надбавки источникам, которые знают больше нашего словаря (см. `completions.ts`). */
export const EXTERNAL_BONUS = 40;

/** Разделитель слов в имени: всё, что не буква и не цифра (`_`, `-`, `.`, `#`, пробел). */
const SEPARATOR = /[^\p{L}\p{Nl}\p{Nd}]/u;

/**
 * Оценить, насколько `name` подходит под набранное `pattern`. `null` — не подходит
 * вовсе: тогда имени в списке быть не должно.
 */
export function matchScore(name: string, pattern: string): MatchResult | null {
  if (pattern.length === 0) return { score: 0, positions: [] };
  if (pattern.length > name.length) return null;
  const positions = matchPositions(name, pattern);
  if (!positions) return null;
  return { score: relevance(name, pattern, positions), positions };
}

/**
 * Где знаки набранного находятся в имени. Возвращаем места или `null`.
 *
 * Идём по имени слева направо и ищем для каждого знака набранного подходящую позицию.
 * Ключевое правило — ГДЕ её искать. Совпадение подряд разрешено где угодно (имя
 * продолжается по буквам: `myc` → `My`+`c`), а вот после РАЗРЫВА следующий знак обязан
 * встать на границу слова: заглавную внутри имени (`C` в `MyClass`) или начало после
 * разделителя (`v` в `my_var`). Без этого правила `gT` нашёл бы `get_T`, но потерял
 * `getTitle`, а с ним — берётся и то, и другое.
 */
function matchPositions(name: string, pattern: string): number[] | null {
  const positions: number[] = [];
  let from = 0;
  let previous = -1;

  for (let index = 0; index < pattern.length; index += 1) {
    const wanted = pattern[index]!;
    let found = -1;
    for (let at = from; at < name.length; at += 1) {
      if (!charMatches(name[at]!, wanted)) continue;
      // Подряд после прошлого совпадения — годится в любом месте; после разрыва —
      // только на границе слова.
      if (at === previous + 1 || isBoundary(name, at)) {
        found = at;
        break;
      }
    }
    if (found < 0) return null;
    positions.push(found);
    previous = found;
    from = found + 1;
  }
  return positions;
}

/** Совпадает ли знак имени с набранным знаком: заглавная требует заглавной, строчная — любой. */
function charMatches(candidate: string, wanted: string): boolean {
  if (isUpper(wanted)) return candidate === wanted;
  return candidate.toLowerCase() === wanted.toLowerCase();
}

/** Начало слова в имени: самый первый знак, после разделителя, после цифры или горб (`aB`). */
function isBoundary(name: string, at: number): boolean {
  if (at <= 0) return true;
  const previous = name[at - 1]!;
  const current = name[at]!;
  if (SEPARATOR.test(previous)) return true;
  if (isUpper(current) && !isUpper(previous)) return true;
  if (isDigit(current) && !isDigit(previous)) return true;
  return false;
}

/**
 * Оценка совпадения по его виду. Не «правильность», а порядок в списке: чем больше —
 * тем выше строка. Сложение слагаемых, а не одна формула, — чтобы каждое решение
 * (от начала / короткое / без разрывов / раньше первый знак) можно было назвать словом.
 */
function relevance(name: string, pattern: string, positions: readonly number[]): number {
  const first = positions[0]!;
  // Совпадение с начала имени — самое надёжное; при этом сплошное (реальное начало
  // слова) ценнее совпадения по первым горбам.
  let score = first === 0 ? (name.startsWith(pattern) ? 1000 : 800) : 500;

  score -= name.length;

  let gaps = 0;
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! !== positions[index - 1]! + 1) gaps += 1;
  }
  score -= gaps * 25;
  score -= first * 5;

  return score;
}

function isUpper(ch: string): boolean {
  return ch.toUpperCase() === ch && ch.toLowerCase() !== ch;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
