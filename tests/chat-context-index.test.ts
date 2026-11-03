import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/api';
import { contextIndexOf, findThreadIndex } from '../src/renderer/ui/chat-session';

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

/**
 * Обратная задача — `findThreadIndex`: где в ленте лежит вопрос, номер которого
 * известен по контексту. Ею «Повторить» режет ленту.
 *
 * Почему это не украшение. «Повторить» отрезает контекст по номеру вопроса из
 * `history`, а лента рисуется по `transcript`. Раньше лента не резалась вообще,
 * и после повтора на экране оказывались два ответа на один вопрос.
 */

const withThread = (transcript: ChatMessage[], history: ChatMessage[]) => ({ transcript, history });

describe('findThreadIndex', () => {
  it('до сжатия находит вопрос там же, где он в контексте', () => {
    const transcript = [user('a'), assistant('A'), user('b'), assistant('B')];
    const history = [...transcript];

    expect(findThreadIndex(withThread(transcript, history), history[2]!, 2)).toBe(2);
  });

  it('после сжатия находит вопрос в уцелевшем хвосте ленты', () => {
    const transcript = [user('старый'), assistant('старый ответ'), user('новый'), assistant('новый ответ')];
    const history = [user('резюме'), assistant('принято'), user('новый'), assistant('новый ответ')];

    expect(findThreadIndex(withThread(transcript, history), history[2]!, 2)).toBe(2);
  });

  it('берёт ПОСЛЕДНЕЕ совпадение, а не первое', () => {
    // Человек спрашивал «глянь» уже трижды, и «Повторить» жмёт на последнем.
    const transcript = [
      user('глянь'),
      assistant('раз'),
      user('глянь'),
      assistant('два'),
      user('глянь'),
      assistant('три'),
    ];
    const history = [user('резюме'), assistant('принято'), user('глянь'), assistant('три')];

    // В ленте таких три; режем по последнему (4), иначе лента схлопнулась бы до
    // первой трети переписки.
    expect(findThreadIndex(withThread(transcript, history), history[2]!, 2)).toBe(4);
  });

  it('разные картинки при одинаковом тексте — разные вопросы', () => {
    const withImage = (src: string): ChatMessage => ({ role: 'user', content: 'что тут', images: [src] });
    const transcript = [withImage('a.png'), assistant('A'), withImage('b.png'), assistant('B')];
    const history = [...transcript];

    expect(findThreadIndex(withThread(transcript, history), history[2]!, 2)).toBe(2);
    expect(findThreadIndex(withThread(transcript, history), history[0]!, 0)).toBe(0);
  });

  it('не находит вопрос, которого в ленте нет, вместо того чтобы резать наугад', () => {
    const transcript = [user('новый'), assistant('ответ')];
    const history = [user('резюме'), assistant('принято'), user('стародавний'), assistant('ответ старый')];

    expect(findThreadIndex(withThread(transcript, history), history[2]!, 2)).toBe(-1);
  });

  it('не доверяет номеру, если по нему лежит другое сообщение', () => {
    const transcript = [user('a'), assistant('A')];
    const history = [user('совсем другое'), assistant('A')];

    expect(findThreadIndex(withThread(transcript, history), history[0]!, 1)).toBe(-1);
  });

  it('согласован с contextIndexOf: туда и обратно одним и тем же вопросом', () => {
    const transcript = [user('x'), assistant('X'), user('y'), assistant('Y'), user('z')];
    const history = [user('резюме'), assistant('принято'), user('y'), assistant('Y'), user('z')];

    for (const threadIndex of [2, 4]) {
      const contextIndex = contextIndexOf(transcript, history, threadIndex);
      expect(contextIndex).toBeGreaterThanOrEqual(0);
      expect(findThreadIndex(withThread(transcript, history), history[contextIndex]!, contextIndex)).toBe(threadIndex);
    }
  });
});
