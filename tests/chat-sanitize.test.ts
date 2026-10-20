import { describe, expect, it } from 'vitest';
import {
  clampString,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MAX_REASONING_CHARS,
  MAX_TOOL_CALLS,
  MISSING_TOOL_RESULT,
  repairToolPairs,
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

  it('trace переносим только с валидным расходом и целыми счётчиками', () => {
    const result = sanitizeConversations([
      { trace: { steps: 3, toolCalls: 7.9, usage: { promptTokens: 100, completionTokens: 20 } } },
      // Расхода нет — след бессмысленен, отбрасываем целиком.
      { trace: { steps: 2, toolCalls: 1, usage: {} } },
      { trace: 'нет' },
    ]);
    expect(result[0]?.trace).toEqual({
      steps: 3,
      toolCalls: 7,
      usage: { promptTokens: 100, completionTokens: 20, cachedTokens: undefined },
    });
    expect(result[1]?.trace).toBeUndefined();
    expect(result[2]?.trace).toBeUndefined();
  });

  // Цель переживает перезапуск вместе с беседой, поэтому она часть файла. Текст
  // проверяем общим правилом, а флаг — строго: «да» строкой это не «закрыто».
  it('цель переносим только с непустым текстом, флаг — настоящим boolean', () => {
    const result = sanitizeConversations([
      { goal: { text: '  Довести   сборку до зелёного ', done: true } },
      { goal: { text: 'Собрать релиз', done: 'да' } },
      { goal: { text: '   ', done: false } },
      { goal: 'нет' },
    ]);
    expect(result[0]?.goal).toEqual({ text: 'Довести сборку до зелёного', done: true });
    expect(result[1]?.goal).toEqual({ text: 'Собрать релиз', done: false });
    expect(result[2]?.goal).toBeUndefined();
    expect(result[3]?.goal).toBeUndefined();
  });

  // Набор инструментов — свойство беседы: без переноса в файл выбор терялся бы
  // при каждом перезапуске, как когда-то терялась цель работы.
  it('набор инструментов беседы переносим, незнакомое значение — общий', () => {
    const result = sanitizeConversations([{ toolPreset: 'read' }, { toolPreset: 'мифический' }, { toolPreset: 5 }, {}]);
    expect(result[0]?.toolPreset).toBe('read');
    expect(result[1]?.toolPreset).toBe('full');
    expect(result[2]?.toolPreset).toBeUndefined();
    expect(result[3]?.toolPreset).toBeUndefined();
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
    // Ответ инструмента стоит после своего вызова: без вызова он осиротевший,
    // и такая пара отбрасывается (см. `repairToolPairs`).
    const result = sanitizeMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', content: 'вывод', name: 'read_file', toolCallId: 'call_1' },
      { role: 'assistant', content: 'ок', rating: 'up' },
      { role: 'assistant', content: 'ок', rating: 'мимо' },
    ]);
    expect(result[1]).toEqual({ role: 'tool', content: 'вывод', name: 'read_file', toolCallId: 'call_1' });
    expect(result[2]?.rating).toBe('up');
    expect(result[3]?.rating).toBeUndefined();
  });

  it('нестроковый content → пустая строка', () => {
    expect(sanitizeMessages([{ role: 'user', content: 5 }])).toEqual([{ role: 'user', content: '' }]);
  });

  // Размышления шага — часть протокола вызова инструментов (DeepSeek отвергает
  // запрос с tools без них), поэтому переживают запись и чтение истории.
  it('размышления шага сохраняются', () => {
    const result = sanitizeMessages([
      { role: 'assistant', content: '', reasoning: 'подумал', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
    ]);
    expect(result[0]?.reasoning).toBe('подумал');
  });

  it('размышления ограничены потолком', () => {
    const long = 'я'.repeat(MAX_REASONING_CHARS + 100);
    const result = sanitizeMessages([{ role: 'assistant', content: 'ок', reasoning: long }]);
    expect(result[0]?.reasoning?.length).toBe(MAX_REASONING_CHARS);
  });

  it('число сообщений ограничено', () => {
    const many = Array.from({ length: MAX_MESSAGES + 3 }, () => ({ role: 'user', content: 'x' }));
    expect(sanitizeMessages(many)).toHaveLength(MAX_MESSAGES);
  });

  // Беседа — контекст для следующего вопроса, поэтому потолок обязан держать
  // свежий хвост: раньше он оставлял первые 200 сообщений, и после перезапуска
  // вся недавняя работа пропадала из истории.
  it('потолок сообщений держит свежие, а не первые', () => {
    const many = Array.from({ length: MAX_MESSAGES + 3 }, (_, index) => ({ role: 'user', content: `м${index}` }));
    const result = sanitizeMessages(many);
    expect(result).toHaveLength(MAX_MESSAGES);
    expect(result.at(-1)).toEqual({ role: 'user', content: `м${MAX_MESSAGES + 2}` });
    expect(result[0]).toEqual({ role: 'user', content: 'м3' });
  });
});

describe('repairToolPairs', () => {
  it('недостающий ответ инструмента дописываем заглушкой', () => {
    const result = repairToolPairs([
      { role: 'user', content: 'проверь' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'run_tests', arguments: '{}' }] },
    ]);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ role: 'tool', toolCallId: 'call_1', name: 'run_tests', content: MISSING_TOOL_RESULT });
  });

  it('заглушка встаёт до следующей реплики человека, а не в конец', () => {
    const result = repairToolPairs([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }] },
      { role: 'user', content: 'ладно, дальше' },
      { role: 'assistant', content: 'ок' },
    ]);
    expect(result.map((message) => message.role)).toEqual(['assistant', 'tool', 'user', 'assistant']);
  });

  it('отвеченный вызов не трогаем, а лишний ответ убираем', () => {
    const result = repairToolPairs([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }] },
      { role: 'tool', content: 'вывод', name: 'read_file', toolCallId: 'call_1' },
      { role: 'tool', content: 'чужой', name: 'read_file', toolCallId: 'call_2' },
      { role: 'user', content: 'спасибо' },
    ]);
    expect(result.map((message) => message.toolCallId ?? message.role)).toEqual(['assistant', 'call_1', 'user']);
  });

  it('вызов без id и повтор id не пропускаем', () => {
    const result = repairToolPairs([
      {
        role: 'assistant',
        content: 'сейчас',
        toolCalls: [
          { id: '', name: 'read_file', arguments: '{}' },
          { id: 'call_1', name: 'read_file', arguments: '{}' },
          { id: 'call_1', name: 'run_tests', arguments: '{}' },
        ],
      },
    ]);
    expect(result[0]?.toolCalls).toHaveLength(1);
    expect(result.map((message) => message.toolCallId)).toEqual([undefined, 'call_1']);
  });

  it('ассистент без вызовов и без текста из истории выпадает', () => {
    const result = repairToolPairs([
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: '', toolCalls: [{ id: '', name: 'read_file', arguments: '{}' }] },
    ]);
    expect(result).toEqual([{ role: 'user', content: 'привет' }]);
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
