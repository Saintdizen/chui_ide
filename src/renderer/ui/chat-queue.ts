import { restoreSent } from '../../shared/chat-attachments';
import type { ChatSession, QueuedPrompt } from './chat-session';

/**
 * Очередь вопросов беседы (`chat.ts` → `send`/`drainQueue`).
 *
 * Вынесено из панели ради проверки: сама панель тянет пол-приложения и тестом не
 * поднимается, а правила тут ценностные и легко портятся — "стоп не теряет
 * набранное", "снятый вопрос возвращает вложения", "порядок сохраняется".
 * Модуль чистый: ни DOM, ни зависимости от вида — только данные беседы.
 */

/** Поставить вопрос в конец: "после текущего ответа". */
export function enqueuePrompt(session: ChatSession, item: QueuedPrompt): void {
  session.queue = [...(session.queue ?? []), item];
}

/**
 * Взять следующий вопрос, убрав его из очереди.
 *
 * `undefined` — очередь пуста: `drainQueue` по этому ответу и останавливается,
 * поэтому двойного вызова (и двойной отправки) не бывает.
 */
export function takeNextPrompt(session: ChatSession): QueuedPrompt | undefined {
  const [next, ...rest] = session.queue ?? [];
  session.queue = rest.length > 0 ? rest : [];
  return next;
}

/**
 * Снять один вопрос, вернув его вложения в поле.
 *
 * Набранный текст НЕ возвращаем: поле — это то, что человек пишет сейчас, и
 * вписывать туда старый вопрос поверх нового было бы хуже, чем потерять текст.
 * Вложения — другое дело: их сбор стоил времени и клика на каждом файле.
 *
 * Возвращаем `true`, если вопрос был и список изменился.
 */
export function dropQueuedPrompt(session: ChatSession, index: number): boolean {
  const queued = session.queue ?? [];
  const item = queued[index];
  if (!item) return false;
  session.queue = queued.filter((_, at) => at !== index);
  restoreSent(session, item.attachments);
  return true;
}

/**
 * Переставить вопрос на `delta` мест: -1 вверх (раньше), +1 вниз (позже).
 *
 * Зачем `delta`, а не пара индексов: в ленте на строку одна кнопка, и она знает своё
 * направление. Заодно вся арифметика остаётся здесь, а не в виде.
 *
 * `false` — двигать некуда: очередь короче двух или ход за край. Сессию при отказе
 * НЕ трогаем (не переприсваиваем `queue`): `false` значит «ничего не было», и по нему
 * вызывающий не перерисовывает список — фокус остаётся на нажатой кнопке.
 *
 * Вложения едут с вопросом: это его части, а не позиции в списке.
 */
export function moveQueuedPrompt(session: ChatSession, index: number, delta: number): boolean {
  const queued = session.queue ?? [];
  const to = index + delta;
  if (delta === 0) return false;
  if (index < 0 || index >= queued.length) return false;
  if (to < 0 || to >= queued.length) return false;
  const next = [...queued];
  // `splice` отдаёт `undefined` при пустом массиве — отсекаем это одним guard'ом,
  // чтобы `next.splice(...)` не получил `QueuedPrompt | undefined`.
  const [item] = next.splice(index, 1);
  if (!item) return false;
  next.splice(to, 0, item);
  session.queue = next;
  return true;
}

/** Снять все вопросы: вложения возвращаются в порядке очереди. */
export function clearQueuedPrompts(session: ChatSession): boolean {
  const queued = session.queue ?? [];
  if (queued.length === 0) return false;
  session.queue = [];
  // С конца: `restoreSent` кладёт в начало, и только так самый первый вопрос
  // оказывается первым в поле — в том порядке, в каком человек его писал.
  for (const item of [...queued].reverse()) restoreSent(session, item.attachments);
  return true;
}
