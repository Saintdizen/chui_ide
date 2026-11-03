import { describe, expect, it } from 'vitest';
import { clearQueuedPrompts, dropQueuedPrompt, enqueuePrompt, takeNextPrompt } from '../src/renderer/ui/chat-queue';
import type { ChatSession } from '../src/renderer/ui/chat-session';
import type { ChatAttachment } from '../src/shared/api';

/**
 * Очередь вопросов: что делает «отправить во время ответа» и «стоп».
 *
 * Правила ценностные и потому легко ломаются незаметно: очередь — это не UI
 * сам по себе, а обещание «написал — не пропало» и «вложения не растворились».
 */

function attachment(label: string): ChatAttachment {
  return { kind: 'file', label, text: `${label}: текст` } as ChatAttachment;
}

function session(): ChatSession {
  return { attachments: [] } as unknown as ChatSession;
}

describe('очередь вопросов', () => {
  it('ставит в конец и отдаёт в порядке написания', () => {
    const chat = session();
    enqueuePrompt(chat, { text: 'первый', attachments: [] });
    enqueuePrompt(chat, { text: 'второй', attachments: [] });
    expect(takeNextPrompt(chat)?.text).toBe('первый');
    expect(takeNextPrompt(chat)?.text).toBe('второй');
  });

  it('пустая очередь — undefined, а не пустая строка', () => {
    // По undefined `drainQueue` останавливается; пустой вопрос ушёл бы модели.
    expect(takeNextPrompt(session())).toBeUndefined();
  });

  it('снятый вопрос возвращает вложения в поле, но не текст', () => {
    const chat = session();
    enqueuePrompt(chat, { text: 'с файлом', attachments: [attachment('a.ts')] });
    chat.attachments = [attachment('сейчас.ts')];

    expect(dropQueuedPrompt(chat, 0)).toBe(true);
    expect(chat.queue).toEqual([]);
    // Вложения снятого — первыми: порядок совпадает с отправкой.
    expect(chat.attachments.map((item) => item.label)).toEqual(['a.ts', 'сейчас.ts']);
  });

  it('снятие несуществующего вопроса ничего не меняет', () => {
    const chat = session();
    chat.attachments = [attachment('сейчас.ts')];
    expect(dropQueuedPrompt(chat, 3)).toBe(false);
    expect(chat.attachments).toHaveLength(1);
  });

  it('«снять все» сохраняет порядок вложений и отвечает, было ли что снимать', () => {
    const chat = session();
    enqueuePrompt(chat, { text: 'раз', attachments: [attachment('раз.ts')] });
    enqueuePrompt(chat, { text: 'два', attachments: [attachment('два.ts')] });
    expect(clearQueuedPrompts(chat)).toBe(true);
    expect(chat.attachments.map((item) => item.label)).toEqual(['раз.ts', 'два.ts']);
    expect(clearQueuedPrompts(chat)).toBe(false);
  });
});
