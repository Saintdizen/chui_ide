import { describe, expect, it } from 'vitest';
import {
  GOAL_MAX_CHARS,
  MAX_GOAL_CONTINUES,
  goalContinuePrompt,
  goalPrompt,
  parseGoalUpdate,
  sanitizeGoal,
} from '../src/shared/goal';

/**
 * Цель работы — условие окончания, а не реплика.
 *
 * Здесь стерегутся три вещи, на которых она держится: текст цели приходит из
 * недоверенных источников (renderer, файл беседы, аргументы модели) и должен
 * быть приведён к одному виду; закрытие цели разбирается отдельно от постановки;
 * а промпты говорят модели то, чего она иначе не поймёт, — что ход не равен работе.
 */

describe('цель: текст из недоверенного источника', () => {
  it('пустое и не строка — цели нет', () => {
    expect(sanitizeGoal(undefined)).toBeNull();
    expect(sanitizeGoal(null)).toBeNull();
    expect(sanitizeGoal(42)).toBeNull();
    expect(sanitizeGoal('   \n\t ')).toBeNull();
  });

  it('переводы строк и лишние пробелы схлопываются: цель — одна фраза', () => {
    expect(sanitizeGoal('  Довести\n сборку\tдо зелёного  ')).toBe('Довести сборку до зелёного');
  });

  it('длинная цель обрезается по границе слова и не превышает потолок', () => {
    const long = `${'слово '.repeat(200)}конец`;
    const text = sanitizeGoal(long);
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(GOAL_MAX_CHARS + 1); // + многоточие
    expect(text!.endsWith('…')).toBe(true);
    // Обрезка не рвёт слово пополам — иначе цель читалась бы как опечатка.
    expect(text!.slice(0, -1).trimEnd().endsWith('слово')).toBe(true);
  });

  it('цель в пределах потолка остаётся как есть', () => {
    const text = 'Починить падающий тест импорта';
    expect(sanitizeGoal(text)).toBe(text);
  });
});

describe('цель: разбор вызова update_goal', () => {
  it('постановка цели', () => {
    expect(parseGoalUpdate(JSON.stringify({ goal: ' Собрать релиз ' }))).toEqual({ text: 'Собрать релиз' });
  });

  it('закрытие цели без повторения текста', () => {
    expect(parseGoalUpdate(JSON.stringify({ done: true }))).toEqual({ done: true });
    expect(parseGoalUpdate(JSON.stringify({ done: false }))).toEqual({ done: false });
  });

  it('мусор и пустая цель — нечего применять', () => {
    expect(parseGoalUpdate('не json')).toBeNull();
    expect(parseGoalUpdate('[]')).toBeNull();
    expect(parseGoalUpdate(JSON.stringify({}))).toBeNull();
    expect(parseGoalUpdate(JSON.stringify({ goal: '   ' }))).toBeNull();
    // Строка вместо флага не должна читаться как «закрыто».
    expect(parseGoalUpdate(JSON.stringify({ done: 'да' }))).toBeNull();
  });
});

describe('цель: что видит модель', () => {
  it('в системной строке есть текст цели и правило про закрытие', () => {
    const line = goalPrompt('Довести сборку до зелёного');
    expect(line).toContain('Довести сборку до зелёного');
    expect(line).toContain('update_goal');
    expect(line).toContain('done: true');
    // Главное отличие цели от вопроса — сказано словами.
    expect(line).toMatch(/не считай законченный ход поводом остановиться/);
  });

  it('принимает и объект цели, а не только строку', () => {
    expect(goalPrompt({ text: 'Собрать релиз', done: false })).toContain('Собрать релиз');
  });

  it('запрос продолжения говорит, что цель открыта и какое это продолжение', () => {
    const prompt = goalContinuePrompt('Собрать релиз', 2, MAX_GOAL_CONTINUES);
    expect(prompt).toContain('Цель ещё не закрыта: Собрать релиз');
    expect(prompt).toContain('2-е продолжение из 3');
    // Тупик без выхода: если нужен человек — спросить, а не гадать.
    expect(prompt).toContain('ask');
  });

  it('потолок продолжений — маленькое число: петля не должна жечь токены', () => {
    expect(MAX_GOAL_CONTINUES).toBeGreaterThan(1);
    expect(MAX_GOAL_CONTINUES).toBeLessThanOrEqual(5);
  });
});
