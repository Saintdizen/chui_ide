/**
 * Ширина знака в клетках: 0, 1 или 2. Правило Юникода East Asian Width.
 *
 * Лежит в `shared`, потому что оно не про редактор: терминал считает клетки той же
 * меркой, а модель экрана терминала — чистая и проверяется без окна. Файл не знает
 * ни DOM, ни шрифта — поэтому его может импортировать и сборка главного процесса.
 */

/**
 * Широкие знаки (East Asian Width = Wide или Fullwidth) — две клетки.
 *
 * Диапазоны те же, что у любого редактора кода: CJK, корейское письмо, полноширинные
 * формы, частые эмодзи. Точный список Юникода тут не нужен — важны ходовые письмена,
 * а редкий знак, попавший в «две клетки» вместо одной, сдвинет каретку меньше, чем
 * иероглиф, посчитанный за одну.
 */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // хангыль-чамо
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK-радикалы, знаки
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // кана, CJK-совместимость
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK расширение A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK основные иероглифы
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // и-слоги
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // хангыль-слоги
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK-совместимость идеографов
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // вертикальные формы
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK-совместимость форм
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // полноширинные формы ASCII
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // полноширинные знаки
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // эмодзи
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) || // доп. эмодзи
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK расширение B и далее
  );
}

/**
 * Нулевая ширина: знак рисуется поверх соседнего, своей клетки не занимает.
 * Свойства Юникода тут доступны прямо в регулярке — в отличие от East Asian Width.
 * Соединители и селекторы начертания проверяются отдельно: в классе символов ZWJ
 * соседствовал бы с эмодзи, а такое правило считает опечаткой (оно ждёт чередование),
 * хотя здесь мы сверяем ОДНУ кодовую точку.
 */
const combiningMark = /^[\p{Mn}\p{Me}]$/u;

function isZeroWidth(codePoint: number): boolean {
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d) return true; // ZWSP/ZWNJ/ZWJ
  if (codePoint === 0xfeff) return true; // метка порядка байт
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return true; // селекторы начертания
  return combiningMark.test(String.fromCodePoint(codePoint));
}

/** Сколько клеток занимает знак: 0 — нулевой ширины, 2 — широкий, 1 — обычный. */
export function cellsOf(codePoint: number): number {
  if (isZeroWidth(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}
