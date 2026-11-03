import { describe, expect, it } from 'vitest';

import { leaveChoice, leaveQuestion } from '../src/shared/run-keep';

/**
 * Закрытие вкладки с идущим прогоном.
 *
 * Найдено при разборе: `closeSession` вызывал `cancelActive()` без единого
 * вопроса. Агент к этому моменту мог уже править файлы — работу теряли молча,
 * и человек не знал, что она была.
 *
 * Спрашивать на каждом прогоне нельзя: вопрос, на который всегда жмут «да»,
 * перестаёт читаться — и в тот раз, когда он важен, его прожмут так же.
 * Поэтому здесь три состояния и условие для каждого.
 */

describe('leaveChoice', () => {
  it('прогон ещё молчит — спрашивать не о чем', () => {
    expect(leaveChoice('idle')).toBe('stop');
  });

  it('агент только читал — терять нечего, бросаем молча', () => {
    expect(leaveChoice('read')).toBe('stop');
  });

  it('агент уже изменил файлы — обязательно спросить', () => {
    expect(leaveChoice('wrote')).toBe('ask');
  });
});

describe('leaveQuestion', () => {
  it('на чтении вопроса нет, а не пустая строка', () => {
    expect(leaveQuestion('read', 0, 5)).toBeNull();
  });

  it('на бездействии вопроса нет', () => {
    expect(leaveQuestion('idle', 0, 0)).toBeNull();
  });

  it('говорит, сколько файлов уже изменил и за сколько шагов', () => {
    const text = leaveQuestion('wrote', 3, 7)!;
    expect(text).toContain('изменил файлов: 3');
    expect(text).toContain('7 шагов');
    expect(text).toContain('ответа вы не увидите');
  });

  it('шесть файлов за один шаг — «шаг», а не «шагов»', () => {
    expect(leaveQuestion('wrote', 6, 1)).toContain('за один шаг');
  });

  it('снимков нет, а шаги были — не рисует «файлов: 0»', () => {
    const text = leaveQuestion('wrote', 0, 4)!;
    expect(text).not.toContain('файлов');
    expect(text).toContain('сделал несколько шагов');
  });

  it('файлы без счёта шагов — говорит только про файлы', () => {
    const text = leaveQuestion('wrote', 2, 0)!;
    expect(text).toContain('файлов: 2');
    expect(text).not.toContain('за 0');
  });
});
