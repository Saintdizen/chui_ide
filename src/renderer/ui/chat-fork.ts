import type { ChatMessage } from '../../shared/api';
import { contextIndexOf, type ChatSession } from './chat-session';

/**
 * Ветка беседы: что скопировать в новую вкладку.
 *
 * Вынесено из `chat.ts`, потому что это чистое преобразование массивов, и
 * проверить его надо тестами: ошибка здесь (не тот кусок `history`) тихо
 * ломает контекст следующего запроса, а в ленте всё выглядит правильно.
 */
export interface ForkPlan {
  title: string;
  history: ChatMessage[];
  transcript: ChatMessage[];
  compacted?: boolean;
}

export function forkTitle(title: string, name = ''): string {
  const given = name.trim();
  if (given) return given;
  const base = title.trim() || 'Беседа';
  // Дважды подряд ветвимся редко, но «— ветка — ветка» — это уже не название.
  return base.endsWith(' — ветка') ? base : `${base} — ветка`;
}

/**
 * План ветки: `cut` — номер сообщения в ленте, с которого начинается новое
 * продолжение (`null` — копируем всю беседу).
 *
 * Вопрос уже за резюме сжатия — резать нечего, отдаём копию целиком: ветка
 * всё равно полезнее, чем отказ, а старый вопрос в ней останется в сводке.
 */
export function forkPlan(
  session: Pick<ChatSession, 'title' | 'history' | 'transcript' | 'compacted'>,
  cut: number | null,
  name = '',
): ForkPlan {
  const title = forkTitle(session.title, name);
  const whole: ForkPlan = {
    title,
    history: [...session.history],
    transcript: [...session.transcript],
  };
  if (session.compacted) whole.compacted = true;
  if (cut === null) return whole;
  const index = contextIndexOf(session.transcript, session.history, cut);
  if (index < 0) return whole;
  return {
    title,
    history: session.history.slice(0, index),
    transcript: session.transcript.slice(0, cut),
    ...(session.compacted ? { compacted: true } : {}),
  };
}

/** Общий предок двух веток: сколько первых сообщений у них совпадает. */
export interface ForkCompare {
  /** Число совпадающих сообщений от начала — место, где ветки разошлись. */
  shared: number;
  /** Что есть только в левой ветке (после точки расхождения). */
  left: ChatMessage[];
  /** Что есть только в правой. */
  right: ChatMessage[];
}

/**
 * Сравнить две ветки беседы.
 *
 * Сравниваем по `transcript`, а не по `history`: после компакции история
 * сжата до резюме, и две ветки выглядели бы разными с первого сообщения,
 * хотя человек их такими не делал.
 *
 * Сообщение считается общим по роли и тексту: id у копий разный, а слова —
 * те же, и сравнивать надо именно слова.
 */
export function compareForks(left: readonly ChatMessage[], right: readonly ChatMessage[]): ForkCompare {
  const same = (a: ChatMessage, b: ChatMessage): boolean =>
    a.role === b.role && (a.content ?? '') === (b.content ?? '');

  let shared = 0;
  while (shared < left.length && shared < right.length && same(left[shared]!, right[shared]!)) {
    shared += 1;
  }
  return { shared, left: left.slice(shared), right: right.slice(shared) };
}
