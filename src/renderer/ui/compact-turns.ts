import type { ChatMessage } from '../../shared/api';

/**
 * Ходов с последнего сжатия — по ним работает настройка «сжимать чаще».
 *
 * Считаем не сообщения, а вопросы человека: одно «ход» — вопрос плюс ответ на
 * него, иначе счётчик зависел бы от того, сколько шагов агент сделал внутри.
 * После сжатия в `history` остаются два служебных сообщения (резюме и «принято»),
 * поэтому отсчёт идёт от первых двух.
 */
export function turnsSinceCompact(history: readonly ChatMessage[]): number {
  let turns = 0;
  for (const message of history.slice(2)) {
    if (message.role === 'user') turns += 1;
  }
  return turns;
}
