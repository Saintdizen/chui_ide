import { describe, expect, it } from 'vitest';
import type { ChatConversation } from '../src/shared/api';
import { sanitizeConversations, MAX_CONTENT_CHARS } from '../src/shared/chat-sanitize';
import { serializeSession } from '../src/renderer/ui/chat-persistence';
import type { ChatSession } from '../src/renderer/ui/chat-session';

/**
 * Черновик беседы должен переживать сохранение и чтение файла.
 *
 * Поле добавили в тип и в сериализатор, но белый список `sanitizeConversations`
 * собирает объект полями вручную — черновик туда не попал, и набранный вопрос
 * исчезал при первом же открытии. Тест ловит ровно этот разрыв.
 */

function sessionWith(draft: string): ChatSession {
  return {
    id: 1,
    uid: 'chat_1',
    title: 'Беседа',
    history: [],
    transcript: [],
    draft,
    toolPreset: 'default',
  } as unknown as ChatSession;
}

describe('черновик в файле беседы', () => {
  it('пишется в файл', () => {
    const saved = serializeSession(sessionWith('половина вопроса'));
    expect(saved.draft).toBe('половина вопроса');
  });

  it('не пишется, если пуст', () => {
    const saved = serializeSession(sessionWith(''));
    // Пустая строка — не черновик: в файле ей нечего делать.
    expect('draft' in saved).toBe(false);
  });

  it('переживает запись и чтение', () => {
    const saved = serializeSession(sessionWith('перенос строки\nи вторая'));
    const [back] = sanitizeConversations(JSON.parse(JSON.stringify([saved])));

    expect(back?.draft).toBe('перенос строки\nи вторая');
  });

  it('мусор в файле не становится черновиком', () => {
    const raw = [{ uid: 'chat_1', title: 'т', updatedAt: 0, messages: [], draft: 42 }];
    expect(sanitizeConversations(raw)[0]?.draft).toBeUndefined();

    const empty = [{ uid: 'chat_1', title: 'т', updatedAt: 0, messages: [], draft: '' }];
    expect(sanitizeConversations(empty)[0]?.draft).toBeUndefined();
  });

  it('слишком длинный черновик обрезается до размера сообщения', () => {
    const long = 'я'.repeat(MAX_CONTENT_CHARS + 500);
    const [back] = sanitizeConversations([{ uid: 'chat_1', title: 'т', updatedAt: 0, messages: [], draft: long }]);

    expect(back?.draft?.length).toBe(MAX_CONTENT_CHARS);
  });
});

// Проверка формы: сериализатор обязан класть черновик в то же поле типа.
const _draftField: keyof ChatConversation = 'draft';
void _draftField;
