import { describe, expect, it } from 'vitest';
import {
  clampString,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_TOOL_CALLS,
  sanitizeConversations,
  sanitizeHistory,
  sanitizeMessages,
  sanitizeToolCalls,
} from '../src/shared/chat-sanitize';

/**
 * Проверка прочитанной истории бесед.
 *
 * Файл истории мог быть правлен руками или достаться от другой версии, поэтому
 * каждое поле проверяется и подрезается. Проверяем и валидные значения, и мусор:
 * испорченный файл не должен ломать панель.
 */

describe('clampString', () => {
  it('не строка — подстановка', () => {
    expect(clampString(42, 'по умолчанию', 10)).toBe('по умолчанию');
  });
  it('длинную строку режет по пределу', () => {
    expect(clampString('abcdef', '', 3)).toBe('abc');
    expect(clampString('abc', '', 3)).toBe('abc');
  });
});

describe('sanitizeHistory', () => {
  it('не объект → пустая история', () => {
    expect(sanitizeHistory(null)).toEqual({ conversations: [] });
    expect(sanitizeHistory('x')).toEqual({ conversations: [] });
    expect(sanitizeHistory(undefined)).toEqual({ conversations: [] });
  });

  it('activeUid переносим только непустой строкой', () => {
    expect(sanitizeHistory({ conversations: [], activeUid: 'chat_1' })).toEqual({
      conversations: [],
      activeUid: 'chat_1',
    });
    expect(sanitizeHistory({ conversations: [], activeUid: '' })).toEqual({ conversations: [] });
    expect(sanitizeHistory({ conversations: [], activeUid: 7 })).toEqual({ conversations: [] });
  });
});

describe('sanitizeConversations', () => {
  it('не массив → пусто', () => {
    expect(sanitizeConversations('нет')).toEqual([]);
  });

  it('пропускает не-объекты, подставляет uid и заголовок', () => {
    const result = sanitizeConversations([null, 'x', {}]);
    expect(result).toHaveLength(1);
    expect(result[0]?.uid).toBe('chat_0');
    expect(result[0]?.title).toBe('Новая беседа');
    expect(result[0]?.updatedAt).toBe(0);
    expect(result[0]?.messages).toEqual([]);
  });

  it('режет заголовок по пределу и сохраняет валидные поля', () => {
    const result = sanitizeConversations([
      { uid: 'u', title: 'я'.repeat(300), updatedAt: 123, messages: [{ role: 'user', content: 'привет' }] },
    ]);
    expect(result[0]?.title).toHaveLength(120);
    expect(result[0]?.updatedAt).toBe(123);
    expect(result[0]?.messages).toEqual([{ role: 'user', content: 'привет' }]);
  });

  it('нечисловой updatedAt → 0', () => {
    const result = sanitizeConversations([{ updatedAt: Number.NaN }, { updatedAt: 'вчера' }]);
    expect(result.map((item) => item.updatedAt)).toEqual([0, 0]);
  });

  it('usage переносим только числами и только если что-то есть', () => {
    const result = sanitizeConversations([
      { usage: { promptTokens: 5, completionTokens: 'x' } },
      { usage: {} },
      { usage: 'нет' },
    ]);
    expect(result[0]?.usage).toEqual({ promptTokens: 5 });
    expect(result[1]?.usage).toBeUndefined();
    expect(result[2]?.usage).toBeUndefined();
  });

  it('число бесед ограничено', () => {
    const many = Array.from({ length: MAX_CONVERSATIONS + 5 }, () => ({}));
    expect(sanitizeConversations(many)).toHaveLength(MAX_CONVERSATIONS);
  });

  it('общий потолок файла: беседы за пределом не сохраняем', () => {
    // Одна строка на все сообщения: содержимое делится, память теста не растёт.
    const big = 'x'.repeat(100_000);
    const conversation = { messages: Array.from({ length: 10 }, () => ({ role: 'user', content: big })) };
    const many = Array.from({ length: MAX_CONVERSATIONS }, () => conversation);
    const result = sanitizeConversations(many);

    // 10 сообщений × 100 КБ = 1 МБ на беседу; при потолке 24 МБ помещается ~24.
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(MAX_CONVERSATIONS);
  });
});

describe('sanitizeMessages', () => {
  it('не массив → пусто', () => {
    expect(sanitizeMessages(null)).toEqual([]);
  });

  it('роль проверяем по списку', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'a' },
      { role: 'admin', content: 'b' },
      { role: 5, content: 'c' },
      'строка',
    ]);
    expect(result).toEqual([{ role: 'user', content: 'a' }]);
  });

  it('переносим name, toolCallId и оценку', () => {
    const result = sanitizeMessages([
      { role: 'tool', content: 'вывод', name: 'read_file', toolCallId: 'call_1' },
      { role: 'assistant', content: 'ок', rating: 'up' },
      { role: 'assistant', content: 'ок', rating: 'мимо' },
    ]);
    expect(result[0]).toEqual({ role: 'tool', content: 'вывод', name: 'read_file', toolCallId: 'call_1' });
    expect(result[1]?.rating).toBe('up');
    expect(result[2]?.rating).toBeUndefined();
  });

  it('нестроковый content → пустая строка', () => {
    expect(sanitizeMessages([{ role: 'user', content: 5 }])).toEqual([{ role: 'user', content: '' }]);
  });

  it('число сообщений ограничено', () => {
    const many = Array.from({ length: MAX_MESSAGES + 3 }, () => ({ role: 'user', content: 'x' }));
    expect(sanitizeMessages(many)).toHaveLength(MAX_MESSAGES);
  });
});

describe('sanitizeToolCalls', () => {
  it('битые вызовы пропускаем, id подставляем', () => {
    const calls = sanitizeToolCalls([
      { name: 'read_file', arguments: '{}' },
      { name: 'read_file' },
      { arguments: '{}' },
      'строка',
    ]);
    expect(calls).toEqual([{ id: 'call_0', name: 'read_file', arguments: '{}' }]);
  });

  it('число вызовов ограничено', () => {
    const many = Array.from({ length: MAX_TOOL_CALLS + 5 }, () => ({ name: 't', arguments: '{}' }));
    expect(sanitizeToolCalls(many)).toHaveLength(MAX_TOOL_CALLS);
  });
});
