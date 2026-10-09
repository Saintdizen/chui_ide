import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import {
  CALIBRATION_MAX,
  CALIBRATION_MIN,
  COMPACT_MAX_CHARS,
  COMPACT_MIN_CHARS,
  compactionBudgetChars,
  condenseCallArguments,
  contextUsage,
  estimateContextParts,
  estimateMessagesTokens,
  isContextOverflow,
  TokenCalibration,
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

  it('кириллицу считает дороже латиницы', () => {
    // Одна и та же длина — разная цена: русский текст в токенах дороже. Занижать
    // его опаснее всего: предохранитель пропустит запрос, который не влезет.
    const latin = estimateMessagesTokens([user('a'.repeat(100))]);
    const cyrillic = estimateMessagesTokens([user('я'.repeat(100))]);
    expect(cyrillic).toBeGreaterThan(latin);
  });

  it('картинку считает фиксированно, а не по длине data-URL', () => {
    const withImage: ChatMessage = { role: 'user', content: 'a', images: [`data:image/png;base64,${'A'.repeat(50_000)}`] };
    // Огромная base64-строка не должна раздувать оценку: провайдер берёт за картинку не по символам.
    expect(estimateMessagesTokens([withImage])).toBeLessThan(5_000);
  });
});

describe('estimateContextParts', () => {
  const base = {
    history: [] as ChatMessage[],
    attachments: [] as const,
    systemPrompt: '',
    tools: false,
  };

  it('делит сообщения беседы и результаты инструментов', () => {
    const parts = estimateContextParts({
      ...base,
      history: [user('привет'), { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'данные' }],
    });
    expect(parts.messages).toBeGreaterThan(0);
    expect(parts.results).toBeGreaterThan(0);
  });

  it('кириллицу считает дороже латиницы — как и предохранитель в main', () => {
    const latin = estimateContextParts({ ...base, systemPrompt: 'a'.repeat(300) }).system;
    const cyrillic = estimateContextParts({ ...base, systemPrompt: 'я'.repeat(300) }).system;
    // Раньше renderer считал по длине — оценка расходилась с main, и русская
    // беседа переполняла окно незаметно для автосжатия.
    expect(cyrillic).toBeGreaterThan(latin);
  });

  it('ещё не отправленный вопрос входит в сообщения', () => {
    const withPending = estimateContextParts({ ...base, history: [user('привет')], pending: 'а теперь вот это' });
    const without = estimateContextParts({ ...base, history: [user('привет')] });
    expect(withPending.messages).toBeGreaterThan(without.messages);
  });

  it('приложенные вложения уходят в отдельную часть «файлы»', () => {
    const parts = estimateContextParts({
      ...base,
      attachments: [{ kind: 'file', label: 'a.py', title: 'a.py', text: 'x'.repeat(200) }],
    });
    expect(parts.files).toBeGreaterThan(0);
  });
});

describe('contextUsage', () => {
  const base = {
    model: 'gpt-4o',
    contextWindow: 100_000,
    history: [user('привет')],
    attachments: [] as const,
    systemPrompt: 'инструкции',
    tools: false,
  };

  it('без ответа провайдера считает по символам и помечает итог оценкой', () => {
    const usage = contextUsage(base);
    expect(usage.exact).toBe(false);
    expect(usage.used).toBeGreaterThan(0);
    expect(usage.limit).toBe(100_000);
  });

  it('к известному итогу добавляет вес ещё не отправленного вопроса', () => {
    const known = contextUsage({ ...base, usage: { promptTokens: 1_000 } });
    const withPending = contextUsage({ ...base, usage: { promptTokens: 1_000 }, pending: 'новый вопрос' });
    // Иначе перед отправкой вес вопроса не виден и сжатие запаздывает.
    expect(known.exact).toBe(true);
    expect(withPending.used).toBeGreaterThan(known.used);
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

/**
 * Переполнение контекста у провайдера — сигнал к тому, чтобы обрезать историю и
 * повторить шаг, а не показывать ошибку. Поэтому важно не спутать его с прочими
 * отказами: ложное срабатывание заставит резать беседу на ровном месте, а пропуск
 * оставит человека с невнятным «HTTP 400».
 */
describe('isContextOverflow', () => {
  it('узнаёт переполнение по исходному телу ответа в `details`', () => {
    // `message` у нас уже переведён, поэтому признак ищем в сыром теле провайдера.
    const openai = { message: 'Превышен размер контекста модели', details: "This model's maximum context length is 128000 tokens" };
    const anthropic = { message: 'Превышен размер контекста модели', details: 'prompt is too long: 210000 tokens > 200000 maximum' };
    expect(isContextOverflow(openai)).toBe(true);
    expect(isContextOverflow(anthropic)).toBe(true);
  });

  it('ловит признак и в самом сообщении — на случай ошибки без тела', () => {
    expect(isContextOverflow({ message: 'maximum context length exceeded' })).toBe(true);
  });

  it('прочие ошибки переполнением не считает', () => {
    expect(isContextOverflow({ message: 'Ключ отклонён провайдером (HTTP 401)', details: 'invalid api key' })).toBe(false);
    expect(isContextOverflow(new Error('сеть недоступна'))).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow('maximum context')).toBe(false);
  });
});

/**
 * Само-калибровка оценки токенов: сами считаем символы по ставке, а провайдер
 * отдаёт настоящий `usage`. Сверяя факт с оценкой того же запроса, учим поправку —
 * иначе русский текст и незнакомая модель стабильно промахиваются мимо окна.
 */
describe('TokenCalibration', () => {
  it('без замеров поправка нейтральна', () => {
    const calibration = new TokenCalibration();
    expect(calibration.scaleFor('openai::gpt-4o')).toBe(1);
  });

  it('учится по факту: факт вдвое больше оценки — поправка растёт к 2', () => {
    const calibration = new TokenCalibration();
    calibration.observe('m', 1_000, 2_000);
    // Первый замер берём как есть: сравнивать ещё не с чем.
    expect(calibration.scaleFor('m')).toBeCloseTo(2, 5);
  });

  it('сглаживает: одиночный выброс не бросает поправку к границе', () => {
    const calibration = new TokenCalibration();
    calibration.observe('m', 1_000, 1_000); // поправка 1
    calibration.observe('m', 100, 1_000); // выброс: отношение 10, но весит 0.3
    // 1 + 0.3 * (10 - 1) = 1.6 — далеко от границы 3.
    expect(calibration.scaleFor('m')).toBeGreaterThan(1);
    expect(calibration.scaleFor('m')).toBeLessThan(CALIBRATION_MAX);
  });

  it('зажимает поправку в разумные границы', () => {
    const calibration = new TokenCalibration();
    calibration.observe('huge', 1, 10_000);
    expect(calibration.scaleFor('huge')).toBe(CALIBRATION_MAX);
    calibration.observe('tiny', 10_000, 1);
    expect(calibration.scaleFor('tiny')).toBe(CALIBRATION_MIN);
  });

  it('ведёт поправку на каждый ключ отдельно', () => {
    const calibration = new TokenCalibration();
    calibration.observe('gpt-4o', 1_000, 2_000);
    expect(calibration.scaleFor('gpt-4o')).toBeGreaterThan(1);
    expect(calibration.scaleFor('claude')).toBe(1);
  });

  it('игнорирует вырожденные замеры', () => {
    const calibration = new TokenCalibration();
    calibration.observe('m', 0, 100);
    calibration.observe('m', 100, 0);
    calibration.observe('m', Number.NaN, 100);
    expect(calibration.scaleFor('m')).toBe(1);
  });

  it('переживает перезапуск: снимок восстанавливается в новую калибровку', () => {
    const source = new TokenCalibration();
    source.observe('openai::gpt-4o', 1_000, 2_000);
    const restored = new TokenCalibration();
    restored.load(source.snapshot());
    expect(restored.scaleFor('openai::gpt-4o')).toBeCloseTo(source.scaleFor('openai::gpt-4o'), 5);
  });

  it('load терпим к мусору: берёт числа и пропускает остальное', () => {
    const calibration = new TokenCalibration();
    calibration.load({ good: 2, bad: 'x', missing: null, nan: Number.NaN });
    expect(calibration.scaleFor('good')).toBe(2);
    expect(calibration.scaleFor('bad')).toBe(1);
    expect(calibration.scaleFor('nan')).toBe(1);
    calibration.load(null);
    expect(calibration.scaleFor('good')).toBe(2);
  });
});

describe('condenseCallArguments', () => {
  const long = 'строка\n'.repeat(120);
  const minChars = 400;

  it('сжимает длинные тела правок, сохраняя путь и версию', () => {
    const args = JSON.stringify({
      edits: [
        {
          path: 'src/a.ts',
          expectedVersion: 3,
          edits: [{ startLine: 1, endLine: 2, oldText: long, newText: long }],
        },
      ],
    });
    const condensed = condenseCallArguments(args, minChars);
    const parsed = JSON.parse(condensed) as {
      edits: Array<{
        path: string;
        expectedVersion: number;
        edits: Array<{ oldText: string; newText: string }>;
      }>;
    };
    expect(parsed.edits[0]?.path).toBe('src/a.ts');
    expect(parsed.edits[0]?.expectedVersion).toBe(3);
    expect(parsed.edits[0]?.edits[0]?.newText).toContain('применено');
    expect(condensed.length).toBeLessThan(args.length);
  });

  it('сжимает длинное содержимое create_file', () => {
    const args = JSON.stringify({ path: 'src/b.ts', contents: long });
    const parsed = JSON.parse(condenseCallArguments(args, minChars)) as {
      path: string;
      contents: string;
    };
    expect(parsed.path).toBe('src/b.ts');
    expect(parsed.contents).not.toContain('строка');
  });

  it('не трогает короткие тела и мелкие поля', () => {
    const args = JSON.stringify({ path: 'src/a.ts', contents: 'коротко' });
    expect(condenseCallArguments(args, minChars)).toBe(args);
  });

  it('возвращает исходную строку для не-JSON', () => {
    expect(condenseCallArguments('не json', minChars)).toBe('не json');
  });
});
