import { describe, expect, it } from 'vitest';
import { scrollTargetFor } from '../src/renderer/ui/chat-session';
import type { ChatSession } from '../src/renderer/ui/chat-session';

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
