import { describe, expect, it } from 'vitest';

import {
  allowFire,
  automationMatchesPath,
  automationsForClock,
  automationsForSave,
  MAX_AUTOMATION_FIRES_PER_HOUR,
  MIN_AUTOMATION_INTERVAL_MS,
  normalizeAutomations,
} from '../src/shared/automations';

describe('автоматизации', () => {
  it('мусор отбрасывается, включённость по умолчанию', () => {
    const list = normalizeAutomations([
      { name: 'Ревью', prompt: 'посмотри дифф', on: { save: 'src/**/*.ts' } },
      { name: 'Без задания', prompt: '   ', on: { save: '*.ts' } },
      { name: 'Без триггера', prompt: 'привет', on: {} },
      null,
      'строка',
    ]);

    expect(list.map((item) => item.name)).toEqual(['Ревью']);
    expect(list[0]?.enabled).toBeUndefined();
  });

  it('маска пути считается от корня проекта', () => {
    expect(automationMatchesPath('src/**/*.ts', 'src/ai/service.ts')).toBe(true);
    expect(automationMatchesPath('src/**/*.ts', 'tests/ai.test.ts')).toBe(false);
  });

  it('потолок: не чаще интервала и не больше лимита в час', () => {
    const now = 10_000_000;
    const recent = new Map([['Ревью', [now - MIN_AUTOMATION_INTERVAL_MS / 2]]]);
    expect(allowFire(recent, 'Ревью', now)).toBe(false);
    expect(allowFire(recent, 'Другое', now)).toBe(true);

    const many = Array.from({ length: MAX_AUTOMATION_FIRES_PER_HOUR }, (_, index) => now - index * 60_001);
    expect(allowFire(new Map([['Ревью', many]]), 'Ревью', now)).toBe(false);
  });

  it('по сохранению срабатывает подходящая маска', () => {
    const list = normalizeAutomations([{ name: 'Ревью', prompt: 'посмотри дифф', on: { save: 'src/**/*.ts' } }]);

    expect(automationsForSave(list, 'src/main/app.ts', new Map(), 1000)).toHaveLength(1);
    expect(automationsForSave(list, 'tests/a.test.ts', new Map(), 1000)).toHaveLength(0);
  });

  it('по часам — только те, у кого задан интервал', () => {
    const list = normalizeAutomations([
      { name: 'Утро', prompt: 'сводка', on: { everyMinutes: 60 } },
      { name: 'Сохранение', prompt: 'посмотри', on: { save: '*.md' } },
    ]);

    expect(automationsForClock(list, new Map(), 5_000_000).map((item) => item.name)).toEqual(['Утро']);
  });
});
