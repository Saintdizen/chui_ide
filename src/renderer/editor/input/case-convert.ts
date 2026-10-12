/**
 * Смена стиля имени: camelCase ↔ snake_case и родственные.
 *
 * Работает не по регуляркам «на весь текст», а по СЛОВАМ: имя сперва разбивается на
 * слова (по границам camelCase, подчёркиваниям, дефисам, точкам и пробелам), а потом
 * слова собираются в нужный стиль. Так `getUserName`, `get_user_name` и
 * `get-user-name` дают один и тот же результат, а не «что получится».
 *
 * Разбор идёт по Unicode-категориям (`\p{L}`, `\p{N}`), а не по `[A-Za-z]`: имена
 * бывают и с кириллицей, и цифрами (частая причина, почему «цифра слипается со
 * словом» — `base64` не должно распадаться на `base` и `64` при camelCase-границе).
 *
 * Модуль чистый: ни буфера, ни DOM — поэтому проверяется тестами напрямую.
 */

/** Стили, между которыми умеет переключать редактор. */
export type CaseStyle = 'camel' | 'pascal' | 'snake' | 'kebab' | 'constant' | 'dot' | 'title' | 'lower' | 'upper';

/** Подпись стиля — для палитры команд. */
export const CASE_LABEL: Readonly<Record<CaseStyle, string>> = {
  camel: 'camelCase',
  pascal: 'PascalCase',
  snake: 'snake_case',
  kebab: 'kebab-case',
  constant: 'CONSTANT_CASE',
  dot: 'dot.case',
  title: 'заголовок из слов',
  lower: 'строчные',
  upper: 'ПРОПИСНЫЕ',
};

/**
 * Разбить имя на слова. Границы — строчная→прописная (`getUser`), сокращение перед
 * словом (`HTTPServer` → `HTTP`, `Server`) и всё, что не буква и не цифра (`_`, `-`,
 * `.`, пробел). Цифры остаются при своём слове: `base64` — одно слово.
 */
export function splitWords(text: string): string[] {
  return (
    text
      // getX → get X
      .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
      // HTTPServer → HTTP Server
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((part) => part.length > 0)
  );
}

/** Первая буква — заглавная, остальные как есть (уже приведены к нижнему при сборке). */
function capitalize(word: string): string {
  if (word.length === 0) return word;
  return word[0]!.toUpperCase() + word.slice(1);
}

/**
 * Перевести имя в нужный стиль. Пусто или нет слов — возвращаем исходный текст:
 * если в строке нет букв и цифр, менять нечего, и «пустой результат» не нужен.
 */
export function convertCase(text: string, style: CaseStyle): string {
  const words = splitWords(text);
  if (words.length === 0) return text;

  const lower = words.map((word) => word.toLowerCase());
  switch (style) {
    case 'camel':
      return lower.map((word, index) => (index === 0 ? word : capitalize(word))).join('');
    case 'pascal':
      return lower.map(capitalize).join('');
    case 'snake':
      return lower.join('_');
    case 'kebab':
      return lower.join('-');
    case 'constant':
      return lower.join('_').toUpperCase();
    case 'dot':
      return lower.join('.');
    case 'title':
      return words.map(capitalize).join(' ');
    case 'lower':
      return text.toLowerCase();
    case 'upper':
      return text.toUpperCase();
  }
}
