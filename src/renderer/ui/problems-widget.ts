/**
 * Вид виджета проблем в строке состояния — решение без DOM, чтобы его можно было
 * проверить тестом.
 *
 * Правило: ноль показывается словами, если проверка работу не сделала. Молчащий
 * виджет читается как «ошибок нет», а пустой список без линтера — это не чистота.
 */

/** Счётчики проблем: числа плюс признаки прохода. */
export interface ProjectProblemCounts {
  errors: number;
  warnings: number;
  /** Идёт проверка всего проекта — числа ещё не про неё. */
  checking?: boolean;
  /** Почему числам верить нельзя (нет линтера, отказ, ещё не проверяли). */
  unchecked?: string | null;
  /** Проход не уложился во время: найденное верно, список — не весь. */
  partial?: boolean;
}

/** Что показать в виджете: слова, число или ничего. */
export interface ProblemsWidgetView {
  /** Виджет спрятан — сказать нечего (проверили, чисто). */
  hidden: boolean;
  text: string;
  tone: 'plain' | 'checking' | 'unchecked' | 'errors' | 'warnings';
  title: string;
}

// Склонение зашито в две функции: у ошибок и предупреждений разные слова, общий
// помощник пришлось бы звать с шестью аргументами на каждую строку.
function errorsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ошибка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ошибки`;
  return `${count} ошибок`;
}

function warningsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} предупреждение`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} предупреждения`;
  return `${count} предупреждений`;
}

const TIMED_OUT = 'Проверка не уложилась во время — список может быть неполным';

export function problemsWidget(counts: ProjectProblemCounts): ProblemsWidgetView {
  const { errors, warnings } = counts;
  const checking = Boolean(counts.checking);
  const reason = counts.unchecked ?? (counts.partial ? TIMED_OUT : null);
  const blank = errors === 0 && warnings === 0;
  const blind = !checking && blank && reason !== null;

  const numbers = [errors > 0 ? errorsLabel(errors) : '', warnings > 0 ? warningsLabel(warnings) : '']
    .filter(Boolean)
    .join(', ');

  const tone: ProblemsWidgetView['tone'] = checking
    ? 'checking'
    : blind
      ? 'unchecked'
      : errors > 0
        ? 'errors'
        : warnings > 0
          ? 'warnings'
          : 'plain';

  const title = checking
    ? 'Идёт проверка проекта: линтер и зависимости'
    : blind
      ? `${reason}. Команда «Проверить проект» запустит проход заново`
      : blank
        ? 'Ошибок и предупреждений нет'
        : `Ошибок: ${errors}, предупреждений: ${warnings}.${reason ? ` ${reason}.` : ''} Нажмите, чтобы перейти к первой`;

  return {
    hidden: !checking && blank && reason === null,
    text: checking ? 'проверяю…' : blind ? 'не проверено' : numbers,
    tone,
    title,
  };
}
