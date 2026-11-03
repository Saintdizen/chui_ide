/**
 * Переход по своим промптам (`Alt+↑` / `Alt+↓`).
 *
 * Чистые функции над списком сообщений: кто из них «свой промпт» и куда
 * прыгнуть следующим. Без этого правила жили бы в обработчике клавиш рядом
 * с DOM — и проверить их можно было бы только глазами в окне.
 *
 * Правило одно и простое: шагаем по ВОПРОСАМ человека, листая ленту. Ответы и
 * вызовы инструментов пропускаются: их много, и переход через них выглядел бы
 * как «я нажал — ничего не произошло».
 */

export interface NavMessage {
  role: string;
}

/**
 * Индексы сообщений, которые человек набрал сам (вопросы, не ответы).
 *
 * Берём именно `user`: `tool` и `assistant` — это ответы модели, за них человек
 * не цепляется взглядом, когда листает свою мысль.
 */
export function promptIndexes(messages: readonly NavMessage[]): number[] {
  const found: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') found.push(index);
  }
  return found;
}

/**
 * Куда прыгнуть от текущего положения.
 *
 * `current` — индекс сообщения, до которого человек уже долистал (-1 — никуда).
 * Назад и вперёд НЕ замыкаются: в поиске по кругу ходят (там важно знать, что
 * совпадения кончились), а здесь это было бы ловушкой — нажал «вверх» на
 * первом вопросе и улетел в последний, перепрыгнув всю беседу.
 *
 * Возвращает индекс сообщения или -1, если идти некуда.
 */
export function promptNeighbour(messages: readonly NavMessage[], current: number, delta: number): number {
  const prompts = promptIndexes(messages);
  if (prompts.length === 0) return -1;

  if (delta > 0) {
    // Строго больше текущего: если стоим ровно на вопросе — идём к следующему,
    // а не топчемся на месте.
    for (const index of prompts) if (index > current) return index;
    return -1;
  }

  // Назад: строго меньше текущего. `current` вне списка (прокрутили в конец,
  // но ни на чём не останавливались) — последний вопрос: оттуда назад есть куда.
  // `-1` проверяем отдельно: сравнение `index < current` с ним не сработало бы -
  // ни один индекс не меньше -1, и «назад» молча ничего не делал бы.
  if (current < 0) return prompts[prompts.length - 1]!;
  for (let at = prompts.length - 1; at >= 0; at -= 1) {
    const index = prompts[at]!;
    if (index < current) return index;
  }
  return -1;
}

/**
 * Где мы сейчас, судя по прокрутке.
 *
 * Берём последнее сообщение, чей верх не выше верхней кромки ленты: так
 * «вниз» ведёт к следующему вопросу, а не возвращает к тому же самому
 * (иначе первое нажатие после прокрутки не меняло бы ничего).
 *
 * `tops` — расстояние от верха содержимого ленты до верха каждого сообщения,
 * `scrollTop` — где лента сейчас. Позиции именно в координатах содержимого:
 * `offsetTop` относительно ленты, а не окна.
 */
export function messageAtScroll(tops: readonly number[], scrollTop: number): number {
  let at = -1;
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index]! <= scrollTop) at = index;
    else break;
  }
  return at;
}
