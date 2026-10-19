import { describe, expect, it } from 'vitest';
import { parseModelIds } from '../src/shared/providers';

/**
 * Разбор ответа эндпоинта моделей. Форматов в жизни несколько, и понять это
 * пришлось на живом сервере: Ollama отвечал нормально, а настройки показывали
 * «список пуст», и человек искал причину в ключе.
 */
describe('parseModelIds', () => {
  it('OpenAI-совместимый: data[].id', () => {
    expect(parseModelIds({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
  });

  it('Anthropic: data[].id, display_name не мешает', () => {
    expect(parseModelIds({ data: [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' }] })).toEqual([
      'claude-sonnet-4',
    ]);
  });

  it('Ollama: models[].name', () => {
    expect(parseModelIds({ models: [{ name: 'llama3:8b' }, { name: 'qwen2.5' }] })).toEqual(['llama3:8b', 'qwen2.5']);
  });

  it('просто массив строк', () => {
    expect(parseModelIds(['b', 'a'])).toEqual(['a', 'b']);
  });

  it('поле model у части шлюзов', () => {
    expect(parseModelIds({ data: [{ model: 'mixtral' }] })).toEqual(['mixtral']);
  });

  it('сортирует по алфавиту и убирает повторы: список не должен прыгать', () => {
    expect(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
  });

  it('мусор даёт пустой список, а не выдуманную модель', () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({})).toEqual([]);
    expect(parseModelIds({ data: 'нет' })).toEqual([]);
    expect(parseModelIds({ data: [null, 5, {}, { id: 7 }, ''] })).toEqual([]);
  });

  it('пробелы по краям снимаются', () => {
    expect(parseModelIds({ data: [{ id: '  gpt-4o  ' }] })).toEqual(['gpt-4o']);
  });
});
