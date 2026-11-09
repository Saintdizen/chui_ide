import { estimateTextTokens } from '../../shared/context-fit';

/**
 * Сводка экономии среза VI: сколько ответов и токенов не ушло модели.
 *
 * Зачем отдельный модуль: экономия разбросана по пяти механизмам (режимы
 * `read`, дерево `list`, кэш `search`, повторы ответов, сворачивание вывода),
 * и каждый сам по себе выглядит мелочью. Вместе они — ответ на вопрос «а
 * сколько это дало»: без числа пункт экономии не проверить.
 *
 * Считаем в токенах, а не в символах: символы — это цена строки, а платят за
 * токены. Перевод — та же оценка, что у истории чата, чтобы цифры сходились.
 */

/** Что намолотил один механизм. */
export interface SavingsPart {
  /** Как механизм называется в сводке. */
  readonly name: string;
  /** Сколько символов ответов не отдали. */
  readonly chars: number;
  /** Сколько раз механизм сработал. */
  readonly times: number;
}

export interface SavingsSummary {
  readonly parts: readonly SavingsPart[];
  /** Сумма символов по всем механизмам. */
  readonly chars: number;
  /** То же в токенах — округлённо вверх: обещать меньше, чем отдали, нельзя. */
  readonly tokens: number;
}

/** Синонимы подписи механизма: лаконично и по-русски, как в остальных ответах. */
const NAMES: Record<string, string> = {
  readModes: 'каркас вместо головы',
  tree: 'дерево папки',
  searchCache: 'кэш поиска',
  repeats: 'повторы ответов',
  output: 'сворачивание вывода',
};

/** Собрать сводку: части без единого срабатывания не показываем — ноль не новость. */
export function savingsSummary(parts: readonly SavingsPart[]): SavingsSummary {
  const shown = parts
    .filter((part) => part.chars > 0 && part.times > 0)
    .map((part) => ({ ...part, name: NAMES[part.name] ?? part.name }))
    .sort((a, b) => b.chars - a.chars);
  const chars = shown.reduce((sum, part) => sum + part.chars, 0);
  return { parts: shown, chars, tokens: estimateTextTokens('x'.repeat(chars)) };
}

/**
 * Строка сводки для человека и для модели.
 *
 * Одна строка, а не таблица: сводку читают раз в конце, и разбираться в ней
 * некогда. Порядок — по вкладу: первым то, что дало больше всего.
 */
export function savingsLine(summary: SavingsSummary): string {
  if (summary.parts.length === 0) return 'экономия: пока нечего показать — механизмы не срабатывали';
  const list = summary.parts
    .map((part) => `${part.name} ${Math.round(estimateTextTokens('x'.repeat(part.chars)))}`)
    .join(', ');
  return `экономия: ${summary.tokens} токенов (${list})`;
}
