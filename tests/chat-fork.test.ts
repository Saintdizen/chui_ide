import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import { forkPlan, forkTitle } from '../src/renderer/ui/chat-fork';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const bot = (content: string): ChatMessage => ({ role: 'assistant', content });

/** Контекст без сжатия — хвост ленты, как в обычной беседе. */
const plain = {
  title: 'Про кеш',
  transcript: [user('первый'), bot('ответ 1'), user('второй'), bot('ответ 2')],
  history: [user('первый'), bot('ответ 1'), user('второй'), bot('ответ 2')],
};

describe('forkPlan', () => {
  it('null — копия всей беседы, исходник не трогаем', () => {
    const plan = forkPlan(plain, null);
    expect(plan.transcript).toHaveLength(4);
    expect(plan.history).toHaveLength(4);
    expect(plan.transcript).not.toBe(plain.transcript);
  });

  it('правка вопроса режет ленту по нему, а контекст — по тому же вопросу', () => {
    const plan = forkPlan(plain, 2);
    expect(plan.transcript.map((m) => m.content)).toEqual(['первый', 'ответ 1']);
    // Режем контекст ПЕРЕД вопросом, а не вместе с ответом на него.
    expect(plan.history.map((m) => m.content)).toEqual(['первый', 'ответ 1']);
  });

  it('вопрос уже за резюме сжатия — отдаёт копию целиком, а не пустоту', () => {
    const compacted = {
      title: 'Сжатая',
      transcript: [user('старый'), bot('старый ответ'), user('новый'), bot('новый ответ')],
      history: [bot('резюме'), user('новый'), bot('новый ответ')],
      compacted: true,
    };
    const plan = forkPlan(compacted, 0);
    expect(plan.compacted).toBe(true);
    expect(plan.transcript).toHaveLength(4);
    expect(plan.history).toHaveLength(3);
  });

  it('имя из аргумента главнее, и «— ветка» не двоится', () => {
    expect(forkPlan(plain, null, 'про кеш').title).toBe('про кеш');
    expect(forkTitle('Про кеш')).toBe('Про кеш — ветка');
    expect(forkTitle('Про кеш — ветка')).toBe('Про кеш — ветка');
    expect(forkTitle('')).toBe('Беседа — ветка');
  });
});
