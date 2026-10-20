import type { ChatAttachment } from './api';

/**
 * Пределы для отложенных ('kept') вложений.
 *
 * Обычный список вложений держит десяток файлов, и это нормально: столько человек
 * тащит в один вопрос. Отложенные же — это состояние между вопросами, и их текст
 * придётся дописывать к каждому резюме. Поэтому здесь потолки скромнее, а лишнее
 * отваливается по старости: дольше всего живёт то, что приложили последним.
 */
export const KEPT_MAX_ITEMS = 8;
export const KEPT_MAX_CHARS = 48_000;

/**
 * Отдать приложенное к вопросу.
 *
 * Копию для сжатия здесь НЕ делаем: что переживёт пересказ, решает человек
 * пометкой на чипе (`toggleKept`). Неявное «всё, что отправили, поедет и дальше»
 * залипало бы на файле, про который давно забыли.
 */
export function takeSent(session: { attachments: ChatAttachment[] }): ChatAttachment[] {
  const sent = session.attachments;
  session.attachments = [];
  return sent;
}

/** Снять вложение ещё до отправки: если оно было отложенным, убрать и там. */
export function dropAttachment(session: { kept?: ChatAttachment[] }, label: string): void {
  if (!session.kept) return;
  const next = session.kept.filter((item) => item.label !== label);
  if (next.length === session.kept.length) return;
  if (next.length > 0) session.kept = next;
  else delete session.kept;
}

/**
 * Дописать отложенный контекст к резюме сжатой беседы.
 *
 * Резюме пересказывает, о чём говорили, но не повторяет присланные файлы: после
 * сжатия модель продолжала бы работу, не видя кода, о котором идёт речь. Поэтому
 * вложения едут следующей репликой пользователя — как если бы человек приложил их
 * снова. Блок размечен так же, как обычный контекст задания (`renderAttachments`),
 * и лежит внутри реплики человека, а не отдельным system: всё, что пришло от
 * пользователя, должно быть видно как пришедшее от пользователя.
 *
 * Ничего не приложено — возвращаем `null`, и история остаётся как была.
 */
export function keptContextMessage(kept: readonly ChatAttachment[] | undefined): { role: 'user'; content: string } | null {
  const items = keepLatest(kept ?? []);
  if (items.length === 0) return null;

  const blocks = items.map((item) => `### ${item.title}\n${item.text}`);
  return {
    role: 'user',
    content: [
      'Продолжение работы: контекст, который я приложил раньше и который остаётся актуальным.',
      '',
      ...blocks,
    ].join('\n'),
  };
}

/**
 * Свежие отложенные вложения в пределах потолков.
 *
 * Считаем в символах (так оно и хранится), но с запасом: на кириллице символ
 * дороже латинского, и лучще отсечь чуть раньше, чем удивиться счёту.
 */
export function keepLatest(items: readonly ChatAttachment[]): ChatAttachment[] {
  const kept: ChatAttachment[] = [];
  let budget = KEPT_MAX_CHARS;
  for (let index = items.length - 1; index >= 0 && kept.length < KEPT_MAX_ITEMS; index -= 1) {
    const item = items[index]!;
    const size = item.text.length;
    // Картинки в дешёвый счёт не входят: они едут частями контента, а не текстом.
    if (item.kind !== 'image' && size > budget && kept.length > 0) continue;
    if (item.kind !== 'image') budget -= size;
    kept.unshift(item);
  }
  return kept;
}

