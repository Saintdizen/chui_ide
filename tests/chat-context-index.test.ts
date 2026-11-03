import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import { contextIndexOf } from '../src/renderer/ui/chat-session';

/**
 * Перевод номера вопроса из ленты в контекст (`contextIndexOf`).
 *
 * Ленту рисуют по `transcript`, модель получает `history`, и после сжатия это
 * РАЗНЫЕ массивы. Кнопка «Править» отдаёт номер из ленты, а резать им `history`
 * нельзя — отрежется чужой вопрос. Здесь и проверяем, что попадание верное.
 */

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('contextIndexOf', () => {
  it('до сжатия номера совпадают', () => {
    const transcript = [user('a'), assistant('A'), user('b'), assistant('B')];
    const history = [...transcript];

    expect(contextIndexOf(transcript, history, 0)).toBe(0);
    expect(contextIndexOf(transcript, history, 2)).toBe(2);
  });

  it('после сжатия находит вопрос за резюме, а не режет резюме', () => {
    // В ленте вся переписка, в контексте — только резюме и служебный ответ.
    const transcript = [user('вопрос 1'), assistant('ответ 1'), user('вопрос 2'), assistant('ответ 2')];
    const history = [user('Контекст сжатой беседы:\n\n...'), assistant('Принято, продолжаем с этим контекстом.')];

    // Вопроса в контексте нет вовсе — править нечего, отрезать нельзя.
    expect(contextIndexOf(transcript, history, 0)).toBe(-1);
    expect(contextIndexOf(transcript, history, 2)).toBe(-1);
  });

  it('находит вопрос, заданный уже после сжатия', () => {
    const transcript = [user('старый'), assistant('старый ответ'), user('новый')];
    const history = [user('резюме'), assistant('принято'), user('новый')];

    // «новый» в ленте на 2, в контексте — на 2: после сжатия два служебных.
    expect(contextIndexOf(transcript, history, 2)).toBe(2);
    // «старый» в контексте отсутствует.
    expect(contextIndexOf(transcript, history, 0)).toBe(-1);
  });

  it('одно и то же сообщение дважды — попадает в своё повторение', () => {
    const transcript = [user('ещё раз'), assistant('A'), user('ещё раз'), assistant('B')];
    const history = [user('ещё раз'), assistant('A'), user('ещё раз'), assistant('B')];

    // Без учёта повторений оба номера дали бы 0 — правка второго вопроса
    // отрезала бы первый.
    expect(contextIndexOf(transcript, history, 0)).toBe(0);
    expect(contextIndexOf(transcript, history, 2)).toBe(2);
  });

  it('повторение с учётом пропущенного в контексте', () => {
    // Первый такой вопрос уже съеден сжатием, остался только второй.
    const transcript = [user('да'), assistant('A'), user('да')];
    const history = [user('резюме'), assistant('принято'), user('да')];

    expect(contextIndexOf(transcript, history, 2)).toBe(2);
    expect(contextIndexOf(transcript, history, 0)).toBe(-1);
  });

  it('вопрос вне диапазона ленты и не вопрос — отказ', () => {
    const transcript = [user('a'), assistant('A')];
    const history = [user('a'), assistant('A')];

    expect(contextIndexOf(transcript, history, -1)).toBe(-1);
    expect(contextIndexOf(transcript, history, 5)).toBe(-1);
    // Ответ — не то, что правят: у него нет вопроса, который можно переписать.
    expect(contextIndexOf(transcript, history, 1)).toBe(-1);
  });
});
