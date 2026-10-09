import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import {
  COMPACT_MAX_CHARS,
  COMPACT_MIN_CHARS,
  compactionBudgetChars,
  estimateMessagesTokens,
  splitTranscript,
  trimMessagesToFit,
} from '../src/shared/context-fit';

/**
 * Предохранитель контекста: обрезка истории в агентном цикле.
 *
 * Здесь проверяем главное свойство — обрезается «целыми ходами» и не рвёт пару
 * `assistant.toolCalls` → `tool`: если их расщепить, провайдер отклонит запрос
 * как нарушающий протокол вызова инструмента. Заодно рамка запроса (ведущий
 * system-блок) должна переживать любую обрезку.
 */

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('estimateMessagesTokens', () => {
  it('растёт с объёмом текста', () => {
    expect(estimateMessagesTokens([user('привет')])).toBeLessThan(estimateMessagesTokens([user('привет'.repeat(100))]));
  });

  it('картинку считает фиксированно, а не по длине data-URL', () => {
    const withImage: ChatMessage = { role: 'user', content: 'a', images: [`data:image/png;base64,${'A'.repeat(50_000)}`] };
    // Огромная base64-строка не должна раздувать оценку: провайдер берёт за картинку не по символам.
    expect(estimateMessagesTokens([withImage])).toBeLessThan(5_000);
  });
});

describe('trimMessagesToFit', () => {
  const history: ChatMessage[] = [
    { role: 'system', content: 'инструкции' },
    user('первый вопрос'),
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'данные'.repeat(3_000) },
    user('второй вопрос'),
    assistant('второй ответ'),
  ];

  it('ничего не трогает, когда помещается', () => {
    const result = trimMessagesToFit(history, { limitTokens: 1_000_000 });
    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(history.length);
  });

  it('режет старые ходы целиком и оставляет рамку запроса', () => {
    const result = trimMessagesToFit(history, { limitTokens: 1_000, keepRecent: 2, marker: 'обрезано' });

    expect(result.dropped).toBeGreaterThan(0);
    // Ведущий system-блок на месте, за ним — заметка.
    expect(result.messages[0]).toEqual({ role: 'system', content: 'инструкции' });
    expect(result.messages[1]).toEqual({ role: 'system', content: 'обрезано' });
    // Хвост — последние два хода.
    expect(result.messages.at(-2)).toEqual(user('второй вопрос'));
    expect(result.messages.at(-1)).toEqual(assistant('второй ответ'));
  });

  it('не оставляет висячий результат инструмента без его вызова', () => {
    const result = trimMessagesToFit(history, { limitTokens: 1_000, keepRecent: 2 });
    // Начать хвост с role='tool' нельзя: провайдер ждёт его только после вызова.
    expect(result.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(result.messages.at(-2)?.role).not.toBe('tool');
  });

  it('сохраняет пару вызов→результат, когда она попадает в оставленный хвост', () => {
    const pair: ChatMessage[] = [
      user('с'.repeat(4_000)),
      assistant('о'.repeat(4_000)),
      user('новый вопрос'),
      { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c9', name: 'read_file', content: 'д'.repeat(2_000) },
    ];
    const result = trimMessagesToFit(pair, { limitTokens: 700 });

    // Ход с вызовом остался целиком: и сам вызов, и его результат.
    expect(result.messages.some((message) => message.toolCallId === 'c9')).toBe(true);
    expect(result.messages.some((message) => message.toolCalls?.some((call) => call.id === 'c9'))).toBe(true);
  });

  it('оставляет хотя бы последний ход даже при сильном переполнении', () => {
    const huge: ChatMessage[] = [user('x'.repeat(100_000)), assistant('ответ')];
    const result = trimMessagesToFit(huge, { limitTokens: 100 });
    expect(result.messages).toEqual([assistant('ответ')]);
  });

  it('возвращает копию, не меняя исходный массив', () => {
    const result = trimMessagesToFit(history, { limitTokens: 1_000, keepRecent: 2 });
    expect(result.messages).not.toBe(history);
    expect(history).toHaveLength(6);
  });
});

describe('compactionBudgetChars', () => {
  it('растёт с окном модели, но зажато в границы', () => {
    // Крошечное окно не должно дробить беседу до бесконечности.
    expect(compactionBudgetChars(8_000, 4_000)).toBe(COMPACT_MIN_CHARS);
    // Огромное окно не должно порождать гигантский запрос.
    expect(compactionBudgetChars(1_000_000, 4_000)).toBe(COMPACT_MAX_CHARS);
  });

  it('вычитает резерв под ответ', () => {
    const withReserve = compactionBudgetChars(100_000, 30_000);
    const withoutReserve = compactionBudgetChars(100_000, 0);
    expect(withReserve).toBeLessThan(withoutReserve);
  });
});

describe('splitTranscript', () => {
  it('короткую историю отдаёт одним блоком', () => {
    const blocks = splitTranscript([user('привет'), assistant('ответ')], 10_000);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('user: привет');
    expect(blocks[0]).toContain('assistant: ответ');
  });

  it('режет длинную историю на несколько блоков', () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i += 1) history.push(user('сообщение '.repeat(20)));
    const blocks = splitTranscript(history, 500);
    expect(blocks.length).toBeGreaterThan(1);
  });

  it('не теряет содержимое: сумма блоков содержит все сообщения', () => {
    const history: ChatMessage[] = [user('первое'), assistant('второе'), user('третье')];
    const blocks = splitTranscript(history, 20);
    const joined = blocks.join('\n');
    expect(joined).toContain('первое');
    expect(joined).toContain('второе');
    expect(joined).toContain('третье');
  });

  it('гигантское одиночное сообщение режет, а не выбрасывает', () => {
    const blocks = splitTranscript([{ role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'д'.repeat(1_000) }], 100);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join('').length).toBeGreaterThanOrEqual(1_000);
  });

  it('вырожденный бюджет не зацикливает: текст остаётся целым по сумме', () => {
    const blocks = splitTranscript([user('текст')], 0);
    expect(blocks.join('')).toContain('текст');
  });
});
