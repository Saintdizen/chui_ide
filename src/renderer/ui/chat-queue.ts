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
