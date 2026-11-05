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
