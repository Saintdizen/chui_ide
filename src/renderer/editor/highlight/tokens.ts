/**
 * Типы токенов подсветки.
 *
 * Строки — ровно те, что понимает наша палитра (`core/theme.ts`): она сопоставляет
 * типу правило по префиксу, поэтому `keyword.control` разберётся как «управляющая
 * конструкция», а `string` — как строка. Держать здесь свои имена и переводить их в
 * палитру отдельной таблицей значило бы завести вторую правду о цветах; вместо этого
 * говорим с палитрой её же языком.
 *
 * Пустая строка (`PLAIN`) — «красить не надо»: пробелы, скобки, операторы. Это не
 * «нет токена», а осознанно бесцветный токен: так в разметке не бывает дыр, а лишний
 * `<span>` без оформления не создаётся (см. `editor-view.ts`).
 */

/** Комментарии — во всех языках курсив. */
export const COMMENT = 'comment';
/** Строковые литералы и шаблонные строки. */
export const STRING = 'string';
/** Числа: целые, дробные, экспоненциальные, разных оснований. */
export const NUMBER = 'number';
/** Ключевые слова, кроме управляющих: `class`, `function`, `const`, `import`… */
export const KEYWORD = 'keyword';
/** Управляющие конструкции: `if`, `for`, `while`, `return`, `try`… Отличаются цветом. */
export const CONTROL = 'keyword.control';
/** Имена типов: `int`, `str`, `number`, свои классы после `class`/`new`. */
export const TYPE = 'type.identifier';
/** Имена функций и методов — узнаём по скобке после имени. */
export const FUNCTION = 'function';
/** Константы: `true`, `null`, `None`, а также именованные вроде `NaN`. */
export const CONSTANT = 'constant';
/** Тег разметки: `div` в HTML, имя узла в XML. */
export const TAG = 'tag';
/** Имя атрибута: `class` в HTML, ключ в JSON. */
export const ATTRIBUTE = 'attribute.name';
/** Идентификатор: имя переменной, поля, свойства. */
export const IDENTIFIER = 'identifier';
/** Переменная оболочки — `$PATH`. В палитре того же цвета, что идентификатор. */
export const VARIABLE = 'variable';
/** Бесцветный токен: знаки препинания, операторы, пробелы. */
export const PLAIN = '';

/** Участок строки с одним оформлением. Границы — смещения в единицах UTF-16 внутри строки. */
export interface Token {
  readonly start: number;
  readonly end: number;
  /** Тип из списка выше (`COMMENT`, `STRING`, …) либо `PLAIN` — без оформления. */
  readonly type: string;
}

/**
 * Человеческое название роли токена — для подсказок и наведения. Таблицей, а не
 * функцией с условиями: название нужно показать, а не вычислить, и таблицу видно
 * целиком (легко проверить, что у каждой роли оно есть).
 */
const ROLE_LABELS: Record<string, string> = {
  [COMMENT]: 'комментарий',
  [STRING]: 'строка',
  [NUMBER]: 'число',
  [KEYWORD]: 'ключевое слово',
  [CONTROL]: 'управляющая конструкция',
  [TYPE]: 'тип',
  [FUNCTION]: 'функция',
  [CONSTANT]: 'константа',
  [TAG]: 'тег',
  [ATTRIBUTE]: 'имя свойства',
  [IDENTIFIER]: 'имя',
  [VARIABLE]: 'переменная',
};

/** Название роли токена. `null` — роль бесцветная, сказать о ней нечего. */
export function roleLabel(type: string | null): string | null {
  if (type === null || type.length === 0) return null;
  return ROLE_LABELS[type] ?? null;
}
