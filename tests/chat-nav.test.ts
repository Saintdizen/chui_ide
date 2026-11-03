import { describe, expect, it } from 'vitest';
import { messageAtScroll, promptIndexes, promptNeighbour } from '../src/shared/chat-nav';

/**
 * Переход по своим промптам (`Alt+↑/↓`).
 *
 * Главное, что здесь сторожится, — НЕзамыкание: в поиске по кругу ходить
 * полезно, а в навигации это ловушка: нажал «вверх» на первом вопросе и
 * улетел в конец, перепрыгнув всю беседу.
 */

const беседа = [
  { role: 'user' }, // 0
  { role: 'assistant' }, // 1
  { role: 'user' }, // 2
  { role: 'assistant' }, // 3
  { role: 'user' }, // 4
];

describe('promptIndexes', () => {
  it('берёт только вопросы человека, не ответы', () => {
    expect(promptIndexes(беседа)).toEqual([0, 2, 4]);
  });

  it('роль `tool` и прочие не считаются промптом', () => {
    expect(promptIndexes([{ role: 'tool' }, { role: 'system' }, { role: 'user' }])).toEqual([2]);
  });

  it('пустая беседа — пусто', () => {
    expect(promptIndexes([])).toEqual([]);
  });
});

describe('promptNeighbour', () => {
  it('вперёд от первого вопроса — второй', () => {
    expect(promptNeighbour(беседа, 0, 1)).toBe(2);
  });

  it('назад от последнего — средний', () => {
    expect(promptNeighbour(беседа, 4, -1)).toBe(2);
  });

  it('вперёд с последнего вопроса — -1, а НЕ первый по кругу', () => {
    // Это и есть то самое незамыкание: иначе «вниз» на последнем вопросе
    // улетало бы в начало беседы.
    expect(promptNeighbour(беседа, 4, 1)).toBe(-1);
  });

  it('назад с первого вопроса — -1, а НЕ последний', () => {
    expect(promptNeighbour(беседа, 0, -1)).toBe(-1);
  });

  it('стоим на ответе — вперёд ведёт к следующему вопросу', () => {
    expect(promptNeighbour(беседа, 1, 1)).toBe(2);
  });

  it('стоим на ответе — назад ведёт к прошлому вопросу', () => {
    expect(promptNeighbour(беседа, 3, -1)).toBe(2);
  });

  it('ни на чём не остановились (-1) — вперёд к первому вопросу', () => {
    expect(promptNeighbour(беседа, -1, 1)).toBe(0);
  });

  it('ни на чём не остановились (-1) — назад к последнему вопросу', () => {
    expect(promptNeighbour(беседа, -1, -1)).toBe(4);
  });

  it('в беседе нет вопросов — -1 в обе стороны', () => {
    expect(promptNeighbour([{ role: 'assistant' }], 0, 1)).toBe(-1);
    expect(promptNeighbour([{ role: 'assistant' }], 0, -1)).toBe(-1);
  });

  it('один вопрос: от него некуда идти ни вперёд, ни назад', () => {
    expect(promptNeighbour([{ role: 'user' }], 0, 1)).toBe(-1);
    expect(promptNeighbour([{ role: 'user' }], 0, -1)).toBe(-1);
  });
});

describe('messageAtScroll', () => {
  // Верхи сообщений в координатах содержимого ленты.
  const tops = [0, 100, 300, 500];

  it('верх ленты — первое сообщение', () => {
    expect(messageAtScroll(tops, 0)).toBe(0);
  });

  it('середина первого сообщения — всё ещё первое', () => {
    expect(messageAtScroll(tops, 50)).toBe(0);
  });

  it('ровно на верхней кромке второго — второе', () => {
    // Без этого «вниз» от первого вопроса возвращался бы к нему же:
    // прокрутили к 100, а посчитали бы, что стоим на 0.
    expect(messageAtScroll(tops, 100)).toBe(1);
  });

  it('между вторым и третьим — второе', () => {
    expect(messageAtScroll(tops, 450)).toBe(2);
  });

  it('дальше всех сообщений — последнее', () => {
    expect(messageAtScroll(tops, 5000)).toBe(3);
  });

  it('пустая лента — -1', () => {
    expect(messageAtScroll([], 100)).toBe(-1);
  });

  it('прокрутка выше нуля не сбивает', () => {
    // Отрицательный scrollTop бывает на «резинке» macOS.
    expect(messageAtScroll(tops, -50)).toBe(-1);
  });
});
