import { describe, expect, it } from 'vitest';
import {
  acceptsImages,
  findModelInfo,
  parseModelInfos,
  supportedEfforts,
} from '../src/shared/model-info';

// Ответ настоящего `GET /models` у DeepSeek: паспорт модели, а не голая строка.
const DEEPSEEK = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1_000_000,
      max_output_tokens: 384_000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1_000_000 },
  ],
};

describe('parseModelInfos', () => {
  it('читает паспорт из ответа с data', () => {
    const [flash, pro] = parseModelInfos(DEEPSEEK);
    expect(flash).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      inputModalities: ['text', 'image'],
      effortLevels: ['low', 'high', 'max'],
      defaultEffort: 'high',
    });
    // Модель без окна остаётся без окна: догадываться за сервер не наше дело.
    expect(pro?.contextWindow).toBe(1_000_000);
    expect(pro?.maxOutputTokens).toBeUndefined();
  });

  it('простой список id тоже понимает', () => {
    const infos = parseModelInfos(['gpt-4o', { id: 'o3' }]);
    expect(infos.map((info) => info.id)).toEqual(['gpt-4o', 'o3']);
  });

  it('мусор не ломает разбор', () => {
    expect(parseModelInfos(null)).toEqual([]);
    expect(parseModelInfos({ data: [null, 5, {}] })).toEqual([]);
    expect(parseModelInfos({})).toEqual([]);
  });

  it('подпись, совпадающая с id, не дублируется', () => {
    const [info] = parseModelInfos([{ id: 'llama3', name: 'llama3' }]);
    expect(info?.name).toBeUndefined();
  });
});

describe('findModelInfo', () => {
  it('находит без учёта регистра', () => {
    const infos = parseModelInfos(DEEPSEEK);
    expect(findModelInfo(infos, 'DeepSeek-Flash')?.contextWindow).toBe(1_000_000);
    expect(findModelInfo(infos, 'нет такой')).toBeUndefined();
    expect(findModelInfo(undefined, 'deepseek-flash')).toBeUndefined();
  });
});

describe('модальности и усилие', () => {
  it('картинки: паспорт решает, а без паспорта — разрешаем', () => {
    const [flash, pro] = parseModelInfos(DEEPSEEK);
    expect(acceptsImages(flash)).toBe(true);
    // Модель без `input_modalities` не запрещает картинки, просто молчит.
    expect(acceptsImages(pro)).toBe(true);
    expect(acceptsImages({ id: 'x', inputModalities: ['text'] })).toBe(false);
    expect(acceptsImages(undefined)).toBe(true);
  });

  it('усилие — пересечение с тем, что сервер принимает', () => {
    const [flash] = parseModelInfos(DEEPSEEK);
    // `medium` и `off` сервер не знает: отправлять их — получить отказ.
    // `max` знает и он у нас теперь есть в шкале.
    expect(supportedEfforts(flash)).toEqual(['low', 'high', 'max']);
    expect(supportedEfforts({ id: 'x' })).toBeUndefined();
    expect(supportedEfforts({ id: 'x', effortLevels: ['minimal'] })).toBeUndefined();
  });
});
