import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import { countTurns, revealAncestors, scrollTargetFor } from '../src/renderer/ui/chat-session';
import type { ChatSession } from '../src/renderer/ui/chat-session';

beforeAll(() => installMiniDom());

/**
 * Позиция прокрутки при переключении беседы.
 *
 * Баг, ради которого это появилось: `activate` безусловно ставил ленту в конец.
 * Полоса прокрутки в панели ОДНА на все вкладки, поэтому человек возвращался на
 * вкладку, где читал историю, и оказывался на последнем сообщении.
 */
describe('куда встать при переключении беседы', () => {
  const session = (scrollTop?: number) => ({ scrollTop }) as ChatSession;

  it('беседа открывается впервые — сразу в конец', () => {
    // Свежая или старая, но впервые показанная: читают с последнего сообщения.
    expect(scrollTargetFor(session(undefined))).toBe('end');
  });

  it('возврат на вкладку — где человек остановился', () => {
    expect(scrollTargetFor(session(0))).toBe(0);
    expect(scrollTargetFor(session(1234))).toBe(1234);
  });

  it('самый верх — это тоже позиция, а не «в конец»', () => {
    // 0 ложен по себе, и `??` тут по ошибке превратил бы чтение с начала в прыжок
    // в конец. Именно поэтому `??`, а не `||`.
    expect(scrollTargetFor(session(0))).not.toBe('end');
  });
});

/**
 * Сколько ходов показывать сразу.
 *
 * Задача 117: длинная беседа держала в DOM все ходы сразу. Считаем только
 * реплики человека — ассистентские и tool-сообщения к тому же ходу.
 */
describe('счёт ходов для порционного раскрытия', () => {
  const asst = { role: 'assistant', content: 'ok' } as const;
  const user = (content: string) => ({ role: 'user', content }) as const;
  // Служебный дострой хода не начинает: он приходит тем же ходом, что и вопрос.
  const continuePrompt = 'continue';

  it('пустая беседа — ноль ходов', () => {
    expect(countTurns([], continuePrompt)).toBe(0);
  });

  it('ход — это реплика человека, ответы и tool-сообщения его не добавляют', () => {
    const transcript = [user('вопрос'), asst, asst, user('ещё'), asst];
    expect(countTurns(transcript, continuePrompt)).toBe(2);
  });

  it('служебный дострой не считается новым ходом', () => {
    // Иначе лента показывала бы «раскрыть ещё» там, где человек вопроса не задавал.
    const transcript = [user('вопрос'), asst, user(continuePrompt), asst];
    expect(countTurns(transcript, continuePrompt)).toBe(1);
  });
});

/**
 * Поиск по беседе и свёрнутые ходы.
 *
 * Баг, ради которого это появилось: лента режет длинную беседу и прячет старые
 * ходы через `data-hidden` (CSS — `display: none`). Поиск читает текст из DOM,
 * поэтому совпадение в спрятанном ходе находилось и подсвечивалось, а
 * `scrollIntoView` внутри `display: none` ничего не двигал: человек видел счётчик
 * совпадений и пустоту на экране.
 */
describe('показ спрятанного хода перед прокруткой к найденному', () => {
  const build = (hiddenTurns: number) => {
    const thread = document.createElement('div');
    const outer = document.createElement('div');
    // Два уровня нужны намеренно: прятать может и ход, и обёртка вокруг него.
    let cursor: HTMLElement = thread;
    for (let i = 0; i < hiddenTurns; i += 1) {
      const turn = document.createElement('div');
      turn.dataset.hidden = 'true';
      cursor.appendChild(turn);
      cursor = turn;
    }
    const msg = document.createElement('div');
    cursor.appendChild(msg);
    outer.appendChild(thread);
    document.body.appendChild(outer);
    return { msg, outer };
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('вложенный ход раскрывается — иначе прокрутка в нём мёртвая', () => {
    const { msg, outer } = build(2);
    const turns = [...outer.querySelectorAll<HTMLElement>('.chat-turn')];
    expect(turns.every((turn) => turn.dataset.hidden === 'true')).toBe(true);
    expect(revealAncestors(msg)).toBe(2);
    // Счётчик — не доказательство: проверяем, что `display: none` действительно
    // снят, иначе прокрутка к найденному останется вхолостую.
    expect(turns.some((turn) => turn.dataset.hidden === 'true')).toBe(false);
  });

  it('на виде сверху ничего не трогает и не притворяется, что раскрывало', () => {
    // Ноль — сигнал вызывающему, что перерисовка не нужна.
    const { msg } = build(0);
    expect(revealAncestors(msg)).toBe(0);
  });

  it('повторный вызов уже раскрытого не пересчитывается как новое', () => {
    const { msg } = build(1);
    expect(revealAncestors(msg)).toBe(1);
    expect(revealAncestors(msg)).toBe(0);
  });
});
