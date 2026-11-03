import type { LanguageIndent } from './languages';

/**
 * Чем оказался отступ файла: табы или пробелы, и если пробелы — сколько их.
 *
 * Отдельно от `LanguageIndent` (`languages.ts`), потому что такие два ответа
 * разные по природе: там — «как в языке принято», тут — «как в ЭТОМ файле
 * написано». Когда они расходятся, прав человек и файл: в TypeScript сплошь и
 * рядом два пробела, а дефолт языка — четыре.
 */
export type IndentStyle = LanguageIndent;

/** На сколько строк смотрим. Дальше — уже не выборка, а весь файл. */
const SAMPLE_LINES = 200;

/** Сколько отступов нужно набрать, чтобы вывод был не случайным. */
const MIN_EVIDENCE = 2;

/**
 * Определить отступ файла по его началу.
 *
 * Возвращает `null`, если улик нет: пустой файл, всё в одну строку, ни одного
 * отступа. Это НЕ то же самое, что «пробелы по четыре» — так мы бы навязали
 * человеку выбор, которого он не делал. `null` — значит «бери настройку».
 *
 * Табуляция сильнее пробелов: она однозначна, а число пробелов угадывается по
 * наименьшему шагу, что при вложенной разметке может ошибиться. Если в файле
 * есть хоть один отступ табом — считаем табами.
 */
export function detectIndent(lines: readonly string[]): IndentStyle | null {
  let tabIndents = 0;
  let spaceIndents = 0;
  // Шаг отступа — наименьший встреченный. Наибольший не годится: вложенная
  // строка даст восемь там, где шаг — четыре.
  let smallestStep = 0;

  const limit = Math.min(lines.length, SAMPLE_LINES);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;

    // Пустой промежуток от начала строки до первого непробельного знака.
    const lead = line.length - line.trimStart().length;
    if (lead === 0) continue;

    const head = line.slice(0, lead);
    // Сочетание таба с пробелами (таб + выравнивание) — вс равно таб: ширину
    // такого отступа задаёт таб, а не пробелы после него.
    if (head.includes('\t')) {
      tabIndents += 1;
      continue;
    }

    spaceIndents += 1;
    const width = lead;
    if (smallestStep === 0 || width < smallestStep) smallestStep = width;
  }

  // Табы побеждают при равенстве: таб однозначен, а шаг пробелов мы угадываем.
  if (tabIndents >= MIN_EVIDENCE && tabIndents >= spaceIndents) {
    // Шаг при табах не узнать из файла — там его не видно. Берём четыре: это
    // ответ языка по умолчанию, а ширина таба и так настраивается отдельно.
    return { tabSize: 4, insertSpaces: false };
  }
  // `MIN_EVIDENCE` и на пробелы: одна строка с отступом — не выбор стиля.
  if (spaceIndents >= MIN_EVIDENCE) {
    // Шаг больше восьми — скорее выравнивание длинной строки, чем отступ.
    const step = smallestStep >= 2 && smallestStep <= 8 ? smallestStep : 4;
    return { tabSize: step, insertSpaces: true };
  }
  return null;
}

/**
 * Рассудить, каким отступом править файл.
 *
 * Порядок: что нашлось в файле важнее, чем что говорит язык, а язык важнее
 * общей настройки. Файл — единственный, кто знает, как в нём уже написано:
 * вставишь не тот отступ — и правишь одну строку, а ломаешь выравнивание во всём.
 */
export function resolveIndent(
  detected: IndentStyle | null,
  language: LanguageIndent | undefined,
  settings: LanguageIndent,
): LanguageIndent {
  return detected ?? language ?? settings;
}
