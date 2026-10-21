import { describe, expect, it } from 'vitest';

/**
 * Роутинг по сложности для коротких подзадач.
 *
 * `quickModel` — модель для подсказки в редакторе, сообщения коммита, заготовки
 * теста и названия беседы. Роутинг сознательно ограничен этими четырьмя: все
 * ответы — короткий текст, который человек видит в поле и может поправить. На
 * `edit` дешёвая модель не ходит никогда, поэтому ошибиться здесь она может
 * только «некрасиво», но не «опасно».
 *
 * Пустая строка (человек стёр поле) — та же «не задана», что и отсутствие:
 * иначе сохранённое пустое значение молча выключило бы подсказки.
 */
describe('quickModel: выбор модели', () => {
  const pick = (ai: { quickModel?: string; activeModel?: string }): string | undefined =>
    ai.quickModel || ai.activeModel;

  it('не задан — работаем активной моделью', () => {
    expect(pick({ activeModel: 'gpt-5' })).toBe('gpt-5');
  });

  it('задан — подзадачи уходят дешёвой модели', () => {
    expect(pick({ quickModel: 'gpt-5-mini', activeModel: 'gpt-5' })).toBe('gpt-5-mini');
  });

  it('пустая строка — тоже «не задана», а не выключение подсказок', () => {
    expect(pick({ quickModel: '', activeModel: 'gpt-5' })).toBe('gpt-5');
  });

  it('ни того ни другого — пусто, и вызов честно отказывает', () => {
    expect(pick({})).toBeUndefined();
  });
});

describe('quickModel: нормализация в настройках', () => {
  /** Повторяет разбор из `SettingsStore.save`: обрезаем, пустую убираем. */
  const normalize = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    const value = raw.trim();
    return value ? value : undefined;
  };

  it('пробелы по краям обрезаются', () => {
    expect(normalize('  gpt-5-mini  ')).toBe('gpt-5-mini');
  });

  it('пробелы вместо имени — поле исчезает', () => {
    expect(normalize('   ')).toBeUndefined();
  });

  it('не строка — поле исчезает', () => {
    expect(normalize(42)).toBeUndefined();
    expect(normalize(null)).toBeUndefined();
  });
});
