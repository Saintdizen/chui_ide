import { describe, expect, it } from 'vitest';
import { compareForks } from '../src/renderer/ui/chat-fork';
import type { ChatMessage } from '../src/shared/api';

/**
 * Сравнение двух веток: нужно показать, где именно они разошлись.
 * Ошибка здесь не роняет ничего — просто в панели сравнения будет не то,
 * что человек видит в беседах, и он перестанет ей верить.
 */

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

describe('compareForks', () => {
  it('находит точку расхождения', () => {
    const left = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'left')];
    const right = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'right')];
    const result = compareForks(left, right);
    expect(result.shared).toBe(2);
    expect(result.left).toHaveLength(1);
    expect(result.right).toHaveLength(1);
    expect(result.left[0]!.content).toBe('left');
  });

  it('одинаковые ветки — пустая разница', () => {
    const one = [msg('user', 'a')];
    expect(compareForks(one, one)).toEqual({ shared: 1, left: [], right: [] });
  });

  it('роль важнее текста: «a» от разных ролей — не общее', () => {
    const result = compareForks([msg('user', 'a')], [msg('assistant', 'a')]);
    expect(result.shared).toBe(0);
  });

  it('одна ветка — продолжение другой', () => {
    const left = [msg('user', 'a')];
    const right = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')];
    const result = compareForks(left, right);
    expect(result.shared).toBe(1);
    expect(result.left).toEqual([]);
    expect(result.right).toHaveLength(2);
  });
});
